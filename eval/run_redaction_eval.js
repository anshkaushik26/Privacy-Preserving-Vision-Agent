/**
 * Computes precision/recall for PII detection and redaction correctness
 * against eval/redaction_testset.json, using the exact same redact.js the
 * extension ships (no reimplementation, no drift).
 *
 * Run with: node run_redaction_eval.js
 */
const path = require("path");
const fs = require("fs");
const Redact = require(path.join(__dirname, "..", "extension", "redact.js"));

const testset = JSON.parse(fs.readFileSync(path.join(__dirname, "redaction_testset.json"), "utf8"));

function countsByType(redactions) {
  const out = {};
  for (const r of redactions) out[r.type] = (out[r.type] || 0) + r.count;
  return out;
}

function evalTextCases(cases) {
  let tp = 0, fp = 0, fn = 0;
  const rows = [];
  for (const c of cases) {
    const actual = countsByType(Redact.redactText(c.text).redactions);
    const types = new Set([...Object.keys(c.expected), ...Object.keys(actual)]);
    let caseOk = true;
    for (const t of types) {
      const exp = c.expected[t] || 0;
      const act = actual[t] || 0;
      const caseTp = Math.min(exp, act);
      const caseFp = Math.max(0, act - exp);
      const caseFn = Math.max(0, exp - act);
      tp += caseTp; fp += caseFp; fn += caseFn;
      if (caseFp || caseFn) caseOk = false;
    }
    rows.push({ id: c.id, ok: caseOk, expected: c.expected, actual });
  }
  return { tp, fp, fn, rows };
}

function evalElementCases(cases) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const rows = [];
  for (const c of cases) {
    const actual = Redact.classifyElementSensitivity(c.attrs);
    let outcome;
    if (c.expected === null && actual === null) { tn++; outcome = "tn"; }
    else if (c.expected !== null && actual === c.expected) { tp++; outcome = "tp"; }
    else if (c.expected === null && actual !== null) { fp++; outcome = "fp"; }
    else { fn++; outcome = "fn"; } // expected sensitive but missed, or classified as wrong category
    rows.push({ id: c.id, ok: outcome === "tp" || outcome === "tn", expected: c.expected, actual });
  }
  return { tp, fp, fn, tn, rows };
}

function prf(tp, fp, fn) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

const textResult = evalTextCases(testset.textCases);
const elementResult = evalElementCases(testset.elementCases);

console.log("=== Text redaction (PII detection + redaction precision) ===");
for (const r of textResult.rows) {
  console.log(`  [${r.ok ? "OK" : "FAIL"}] ${r.id}: expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`);
}
const textMetrics = prf(textResult.tp, textResult.fp, textResult.fn);
console.log(`  TP=${textResult.tp} FP=${textResult.fp} FN=${textResult.fn}`);
console.log(`  precision=${textMetrics.precision.toFixed(3)} recall=${textMetrics.recall.toFixed(3)} f1=${textMetrics.f1.toFixed(3)}`);

console.log("\n=== Element sensitivity classification ===");
for (const r of elementResult.rows) {
  console.log(`  [${r.ok ? "OK" : "FAIL"}] ${r.id}: expected=${r.expected} actual=${r.actual}`);
}
const elementMetrics = prf(elementResult.tp, elementResult.fp, elementResult.fn);
console.log(`  TP=${elementResult.tp} FP=${elementResult.fp} FN=${elementResult.fn} TN=${elementResult.tn}`);
console.log(`  precision=${elementMetrics.precision.toFixed(3)} recall=${elementMetrics.recall.toFixed(3)} f1=${elementMetrics.f1.toFixed(3)}`);

const anyFail = [...textResult.rows, ...elementResult.rows].some((r) => !r.ok);
process.exit(anyFail ? 1 : 0);
