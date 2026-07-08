"""Pure helpers: URL building, retry timing, JSON coercion."""
from __future__ import annotations

import email.utils
import random
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
BASE_DELAY_MS = 500
MAX_DELAY_MS = 60_000


def compute_delay(attempt: int) -> int:
    exp = min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** (attempt - 1)))
    jitter = random.random() * exp * 0.25
    return int(exp + jitter)


def parse_retry_after(value: str) -> Optional[int]:
    try:
        secs = float(value)
        return min(MAX_DELAY_MS, int(secs * 1000))
    except (TypeError, ValueError):
        pass
    try:
        dt = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        dt = None
    if dt is not None:
        return min(MAX_DELAY_MS, max(0, int((dt.timestamp() - time.time()) * 1000)))
    return None


def build_url(base_url: str, path: str, query: Optional[Dict[str, Any]]) -> str:
    url = base_url.rstrip("/") + (path if path.startswith("/") else "/" + path)
    if query:
        q = {k: v for k, v in query.items() if v is not None}
        if q:
            from urllib.parse import urlencode

            sep = "&" if "?" in url else "?"
            url = url + sep + urlencode(q, doseq=True)
    return url


def merge_query(*dicts: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for d in dicts:
        if d:
            out.update(d)
    return out


def jsonable(o: Any) -> Any:
    """Recursively coerce pydantic models / dicts / lists into JSON-safe form."""
    if isinstance(o, BaseModel):
        return o.model_dump(mode="json", exclude_none=True)
    if isinstance(o, dict):
        return {k: jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [jsonable(v) for v in o]
    return o
