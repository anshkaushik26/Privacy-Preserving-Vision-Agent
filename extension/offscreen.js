/**
 * Runs entirely inside the extension's offscreen document (has DOM/canvas,
 * unlike the service worker). Loads a locally-bundled ONNX face-detection
 * model (UltraFace, ~1.2MB, MIT licensed) via ONNX Runtime Web's WASM
 * backend and detects faces in a screenshot the background script sends it.
 * Returns only bounding boxes - the image itself never leaves this context.
 *
 * Why ONNX Runtime Web and not TensorFlow.js: TensorFlow.js calls eval()
 * during its own initialization, which Manifest V3 permanently forbids for
 * extension pages (no override exists for plain 'unsafe-eval'). ONNX Runtime
 * Web's WASM backend only needs WebAssembly.instantiate, which MV3 *does*
 * allow via the 'wasm-unsafe-eval' CSP source (see manifest.json). This was
 * verified directly: TF.js throws "Evaluating a string as JavaScript
 * violates ... script-src 'self'" under MV3's default CSP; onnxruntime-web
 * loads and runs cleanly under 'wasm-unsafe-eval'.
 */
const INPUT_W = 320;
const INPUT_H = 240;
const CONFIDENCE_THRESHOLD = 0.7;
const NMS_IOU_THRESHOLD = 0.3;

let sessionPromise = null;

function getSession() {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
    ort.env.wasm.numThreads = 1;
    sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL("lib/face_detector.onnx"), {
      executionProviders: ["wasm"],
    });
  }
  return sessionPromise;
}

// UltraFace expects 320x240 RGB, NCHW, normalized to roughly [-1, 1] via (px-127)/128.
function preprocess(canvas) {
  const small = document.createElement("canvas");
  small.width = INPUT_W;
  small.height = INPUT_H;
  small.getContext("2d").drawImage(canvas, 0, 0, INPUT_W, INPUT_H);
  const { data } = small.getContext("2d").getImageData(0, 0, INPUT_W, INPUT_H);

  const out = new Float32Array(3 * INPUT_H * INPUT_W);
  const plane = INPUT_H * INPUT_W;
  for (let y = 0; y < INPUT_H; y++) {
    for (let x = 0; x < INPUT_W; x++) {
      const i = (y * INPUT_W + x) * 4;
      const idx = y * INPUT_W + x;
      out[0 * plane + idx] = (data[i] - 127) / 128;
      out[1 * plane + idx] = (data[i + 1] - 127) / 128;
      out[2 * plane + idx] = (data[i + 2] - 127) / 128;
    }
  }
  return out;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter);
}

function nms(boxes, scores, iouThreshold) {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  while (order.length) {
    const cur = order.shift();
    keep.push(cur);
    for (let i = order.length - 1; i >= 0; i--) {
      if (iou(boxes[cur], boxes[order[i]]) > iouThreshold) order.splice(i, 1);
    }
  }
  return keep;
}

async function detectFaces(dataUrl) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);

  const session = await getSession();
  const inputData = preprocess(canvas);
  const tensor = new ort.Tensor("float32", inputData, [1, 3, INPUT_H, INPUT_W]);

  const t0 = performance.now();
  const results = await session.run({ input: tensor });
  const inferenceMs = performance.now() - t0;

  const scoresT = results.scores; // [1, N, 2]: background, face
  const boxesT = results.boxes; // [1, N, 4]: x1,y1,x2,y2 normalized 0..1
  const n = scoresT.dims[1];

  const candBoxes = [];
  const candScores = [];
  for (let i = 0; i < n; i++) {
    const faceScore = scoresT.data[i * 2 + 1];
    if (faceScore > CONFIDENCE_THRESHOLD) {
      const b = boxesT.data.slice(i * 4, i * 4 + 4);
      candBoxes.push([b[0] * canvas.width, b[1] * canvas.height, b[2] * canvas.width, b[3] * canvas.height]);
      candScores.push(faceScore);
    }
  }
  const keep = nms(candBoxes, candScores, NMS_IOU_THRESHOLD);
  const boxes = keep.map((i) => {
    const [x1, y1, x2, y2] = candBoxes[i];
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  });

  return { boxes, imageWidth: canvas.width, imageHeight: canvas.height, inferenceMs };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "detect-faces") return false;
  detectFaces(msg.dataUrl)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
  return true; // keep the message channel open for the async response
});
