"""Pydantic contracts for the client <-> server agent-step API.

These mirror exactly what extension/content_script.js serializes, so keep the
two in sync if you change one.
"""
from typing import List, Literal, Optional

from pydantic import BaseModel


class BBox(BaseModel):
    x: int
    y: int
    w: int
    h: int


class ElementDescriptor(BaseModel):
    idx: int
    tag: str
    type: Optional[str] = None
    role: Optional[str] = None
    label: str
    sensitive: Optional[str] = None
    filled: Optional[bool] = None
    bbox: BBox


class ScreenState(BaseModel):
    url: str
    title: str
    devicePixelRatio: float = 1
    viewport: dict
    elements: List[ElementDescriptor]


class HistoryItem(BaseModel):
    action: dict
    result: dict


class AgentStepRequest(BaseModel):
    task: str
    screen: ScreenState
    history: List[HistoryItem] = []


class AgentAction(BaseModel):
    action: Literal["click", "type", "scroll", "done"]
    target_idx: Optional[int] = None
    value: Optional[str] = None
    reasoning: str = ""
