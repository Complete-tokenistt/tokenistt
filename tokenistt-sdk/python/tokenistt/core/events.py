"""Minimal synchronous event emitter (no external deps)."""
from __future__ import annotations

from typing import Any, Callable, Dict, List


class EventEmitter:
    def __init__(self) -> None:
        self._handlers: Dict[str, List[Callable[[Any], None]]] = {}

    def on(self, event: str, callback: Callable[[Any], None]) -> "EventEmitter":
        self._handlers.setdefault(event, []).append(callback)
        return self

    def off(self, event: str, callback: Callable[[Any], None]) -> "EventEmitter":
        handlers = self._handlers.get(event)
        if handlers and callback in handlers:
            handlers.remove(callback)
        return self

    def trigger(self, event: str, payload: Any = None) -> None:
        for cb in list(self._handlers.get(event, [])):
            try:
                cb(payload)
            except Exception as exc:  # never let a listener break the pipeline
                import logging

                logging.getLogger("tokenistt").error(
                    "listener for %r threw: %s", event, exc
                )
