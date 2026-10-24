import os

# Set before main.py is imported: python-dotenv never overrides variables that
# already exist, so a real GEMINI_API_KEY in the shell or in server/.env can
# never be picked up (or spent) by the tests.
os.environ["GEMINI_API_KEY"] = ""
os.environ["AGENT_SHARED_SECRET"] = ""

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(monkeypatch):
    """Server in stub mode (no Gemini key) with no shared secret required."""
    monkeypatch.setattr(main, "GEMINI_API_KEY", None)
    monkeypatch.setattr(main, "AGENT_SHARED_SECRET", None)
    monkeypatch.setattr(main, "get_client", lambda: pytest.fail("a Gemini client must never be created in tests"))
    return TestClient(main.app)


def make_element(idx, tag="button", label="OK", sensitive=None, type_=None):
    return {
        "idx": idx,
        "tag": tag,
        "type": type_,
        "label": label,
        "sensitive": sensitive,
        "bbox": {"x": 0, "y": 0, "w": 10, "h": 10},
    }


def make_body(elements, history=None, task="do the thing"):
    return {
        "task": task,
        "screen": {"url": "example.com", "title": "T", "viewport": {"w": 1280, "h": 800}, "elements": elements},
        "history": history or [],
    }
