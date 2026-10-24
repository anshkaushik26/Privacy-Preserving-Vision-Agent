from conftest import make_body, make_element

from prompt import build_prompt
from schema import AgentStepRequest


def build(elements, task="open the inbox"):
    return build_prompt(AgentStepRequest(**make_body(elements, task=task)))


def test_prompt_contains_the_task_and_every_element():
    text = build([make_element(1, label="Inbox"), make_element(2, label="Compose")], task="open the inbox")
    assert "open the inbox" in text
    assert '#1 <button> "Inbox"' in text and '#2 <button> "Compose"' in text


def test_sensitive_elements_are_flagged_so_the_model_will_not_type_into_them():
    text = build([make_element(1, "input", "[PASSWORD]", sensitive="password")])
    assert "SENSITIVE:password" in text


def test_safety_rules_are_still_in_the_prompt():
    # These sentences back the send guard and the scope rule; a reworded
    # prompt that drops them should fail loudly here.
    text = build([make_element(1)])
    assert "literal scope" in text
    assert "NEVER choose" in text
    assert "MOST ONCE" in text
