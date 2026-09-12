"""FastAPI server: receives the sanitized screen state, asks Gemini what to do
next, returns a structured action. Falls back to a deterministic stub when
GEMINI_API_KEY is unset, so the extension<->server wiring can be tested without
an API key.

Reads GEMINI_API_KEY from the environment, or from a `.env` file next to this
script (see .env.example). Run with: uvicorn main:app --port 8787 --reload
"""
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from prompt import build_prompt
from schema import AgentAction, AgentStepRequest

load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("agent-server")

app = FastAPI(title="Privacy-Preserving Vision Agent Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")
_client = None


def get_client():
    global _client
    if _client is None:
        from google import genai

        _client = genai.Client(api_key=GEMINI_API_KEY)
    return _client


def stub_decide(req: AgentStepRequest) -> AgentAction:
    """No GEMINI_API_KEY set: deterministically click/fill the first available
    non-sensitive element not yet touched. Lets you test the client/server
    wiring end-to-end before wiring up a real API key."""
    used = {h.action.get("target_idx") for h in req.history if h.action.get("action") in ("click", "type")}
    for el in req.screen.elements:
        if el.sensitive or el.idx in used:
            continue
        if el.tag in ("button", "a") or (el.tag == "input" and el.type == "submit"):
            return AgentAction(action="click", target_idx=el.idx, reasoning="stub mode: first available button (set GEMINI_API_KEY for real reasoning)")
        if el.tag == "input" and el.type in (None, "text", "email"):
            return AgentAction(action="type", target_idx=el.idx, value="test@example.com", reasoning="stub mode: fill first text field")
    return AgentAction(action="done", reasoning="stub mode: nothing safe left to do")


@app.post("/agent/step", response_model=AgentAction)
async def agent_step(req: AgentStepRequest) -> AgentAction:
    if not GEMINI_API_KEY:
        action = stub_decide(req)
        log.info("STUB action=%s target_idx=%s", action.action, action.target_idx)
        return action

    prompt = build_prompt(req)
    client = get_client()
    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config={
                "response_mime_type": "application/json",
                "automatic_function_calling": {"disable": True},
            },
        )
        data = json.loads(resp.text)
        action = AgentAction(**data)
    except Exception as e:
        log.warning("gemini call/parse failed: %s", e)
        action = AgentAction(action="done", reasoning=f"server error: {e}")

    log.info("action=%s target_idx=%s value=%s", action.action, action.target_idx, action.value)
    return action


@app.get("/healthz")
async def healthz():
    return {"ok": True, "mode": "gemini" if GEMINI_API_KEY else "stub"}