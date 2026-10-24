import json

import pytest
from conftest import make_body, make_element

import main


class FakeGemini:
    """Stands in for google.genai.Client; records what it was asked."""

    def __init__(self, reply=None, error=None):
        self.reply, self.error, self.contents = reply, error, None
        self.models = self

    def generate_content(self, model, contents, config):
        self.contents = contents
        if self.error:
            raise self.error
        return type("Resp", (), {"text": self.reply})()


@pytest.fixture
def with_gemini(client, monkeypatch):
    """Switch the server to 'Gemini mode' backed by a fake client."""

    def install(reply=None, error=None):
        fake = FakeGemini(reply, error)
        monkeypatch.setattr(main, "GEMINI_API_KEY", "test-key")
        monkeypatch.setattr(main, "get_client", lambda: fake)
        return fake

    return install


# ---- health ---------------------------------------------------------------
def test_healthz_reports_stub_mode_without_a_key(client):
    assert client.get("/healthz").json() == {"ok": True, "mode": "stub"}


def test_healthz_reports_gemini_mode_with_a_key(client, monkeypatch):
    monkeypatch.setattr(main, "GEMINI_API_KEY", "test-key")
    assert client.get("/healthz").json()["mode"] == "gemini"


# ---- shared-secret filter --------------------------------------------------
BODY = make_body([make_element(1)])


def test_no_secret_configured_accepts_any_caller(client):
    assert client.post("/agent/step", json=BODY).status_code == 200


def test_missing_secret_header_is_rejected(client, monkeypatch):
    monkeypatch.setattr(main, "AGENT_SHARED_SECRET", "s3cret")
    assert client.post("/agent/step", json=BODY).status_code == 401


def test_wrong_secret_is_rejected(client, monkeypatch):
    monkeypatch.setattr(main, "AGENT_SHARED_SECRET", "s3cret")
    assert client.post("/agent/step", json=BODY, headers={"X-Agent-Secret": "nope"}).status_code == 401


def test_correct_secret_is_accepted(client, monkeypatch):
    monkeypatch.setattr(main, "AGENT_SHARED_SECRET", "s3cret")
    assert client.post("/agent/step", json=BODY, headers={"X-Agent-Secret": "s3cret"}).status_code == 200


def test_rejected_request_never_reaches_gemini(client, with_gemini, monkeypatch):
    fake = with_gemini(reply='{"action": "done"}')
    monkeypatch.setattr(main, "AGENT_SHARED_SECRET", "s3cret")
    assert client.post("/agent/step", json=BODY).status_code == 401
    assert fake.contents is None


def test_cors_preflight_allows_the_secret_header(client):
    r = client.options(
        "/agent/step",
        headers={
            "Origin": "chrome-extension://abc",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-agent-secret",
        },
    )
    assert r.status_code == 200
    assert "x-agent-secret" in r.headers["access-control-allow-headers"].lower()


# ---- request validation ----------------------------------------------------
def test_body_without_a_screen_is_rejected(client):
    assert client.post("/agent/step", json={"task": "x"}).status_code == 422


def test_non_json_body_is_rejected(client):
    r = client.post("/agent/step", content="not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422


# ---- stub mode (no Gemini key) ---------------------------------------------
def test_stub_clicks_the_first_button(client):
    r = client.post("/agent/step", json=make_body([make_element(1, "button"), make_element(2, "button")])).json()
    assert (r["action"], r["target_idx"]) == ("click", 1)


def test_stub_never_acts_on_sensitive_elements(client):
    elements = [make_element(1, "input", "[PASSWORD]", sensitive="password"), make_element(2, "button")]
    r = client.post("/agent/step", json=make_body(elements)).json()
    assert r["target_idx"] == 2


def test_stub_skips_elements_already_used(client):
    history = [{"action": {"action": "click", "target_idx": 1}, "result": {"ok": True}}]
    r = client.post("/agent/step", json=make_body([make_element(1), make_element(2)], history)).json()
    assert r["target_idx"] == 2


def test_stub_is_done_when_only_sensitive_elements_remain(client):
    elements = [make_element(1, "input", "[CARD]", sensitive="card")]
    assert client.post("/agent/step", json=make_body(elements)).json()["action"] == "done"


# ---- Gemini mode (fake client, no network) ---------------------------------
def test_valid_model_reply_is_returned(client, with_gemini):
    with_gemini(reply='{"action": "click", "target_idx": 2, "reasoning": "go"}')
    r = client.post("/agent/step", json=BODY).json()
    assert (r["action"], r["target_idx"], r["reasoning"]) == ("click", 2, "go")


def test_unknown_action_from_the_model_is_rejected_as_done(client, with_gemini):
    with_gemini(reply='{"action": "delete_everything"}')
    r = client.post("/agent/step", json=BODY).json()
    assert r["action"] == "done" and "server error" in r["reasoning"]


def test_non_json_model_reply_becomes_done(client, with_gemini):
    with_gemini(reply="sure, I'll click it!")
    assert client.post("/agent/step", json=BODY).json()["action"] == "done"


def test_model_errors_surface_as_done_with_the_error_text(client, with_gemini):
    # Documents current behaviour: an upstream failure is reported as "done",
    # so the side panel can show "task complete" when nothing was done.
    with_gemini(error=RuntimeError("503 UNAVAILABLE"))
    r = client.post("/agent/step", json=BODY).json()
    assert r["action"] == "done" and "503 UNAVAILABLE" in r["reasoning"]


def test_prompt_sent_to_the_model_has_the_task_and_marks_sensitive_fields(client, with_gemini):
    fake = with_gemini(reply=json.dumps({"action": "done"}))
    elements = [make_element(1, "input", "[PASSWORD]", sensitive="password"), make_element(2)]
    client.post("/agent/step", json=make_body(elements, task="pay the invoice"))
    assert "pay the invoice" in fake.contents
    assert "SENSITIVE:password" in fake.contents
