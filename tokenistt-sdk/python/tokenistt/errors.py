"""Error hierarchy mirroring (and extending) the openai Python SDK."""
from __future__ import annotations

from typing import Any, Optional


class TokenisttError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class APIError(TokenisttError):
    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        headers: Optional[dict] = None,
        error: Any = None,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
    ):
        super().__init__(message)
        self.status = status
        self.headers = headers or {}
        self.error = error
        self.code = code if code is not None else (error.get("code") if isinstance(error, dict) else None)
        self.request_id = request_id or (headers or {}).get("x-request-id")


class APIConnectionError(TokenisttError):
    def __init__(self, message: str = "Connection error.", *, cause: Any = None):
        super().__init__(message)
        self.cause = cause


class APIConnectionTimeoutError(APIConnectionError):
    def __init__(self, message: str = "Request timed out."):
        super().__init__(message)


class APIUserAbortError(TokenisttError):
    def __init__(self, message: str = "Request was aborted by the user."):
        super().__init__(message)


class RateLimitError(APIError):
    pass


class BadRequestError(APIError):
    pass


class AuthenticationError(APIError):
    pass


class InternalServerError(APIError):
    pass


class BudgetExceededError(TokenisttError):
    def __init__(self, cumulative_cost: float, limit: float):
        super().__init__(
            f"Budget exceeded: cumulative spend ${cumulative_cost:.4f} >= hard limit "
            f"${limit:.4f}. Request blocked."
        )
        self.cumulative_cost = cumulative_cost
        self.limit = limit


def make_error_from_response(
    status: int, body: Any, headers: Optional[dict] = None
) -> APIError:
    message = _extract_message(body) or f"Request failed with status {status}"
    if status == 429:
        return RateLimitError(message, status=status, headers=headers, error=body)
    if status == 400:
        return BadRequestError(message, status=status, headers=headers, error=body)
    if status == 401:
        return AuthenticationError(message, status=status, headers=headers, error=body)
    if status >= 500:
        return InternalServerError(message, status=status, headers=headers, error=body)
    return APIError(message, status=status, headers=headers, error=body)


def _extract_message(body: Any) -> Optional[str]:
    if not body:
        return None
    if isinstance(body, str):
        return body
    if isinstance(body, dict):
        if isinstance(body.get("message"), str):
            return body["message"]
        if isinstance(body.get("error"), dict) and isinstance(body["error"].get("message"), str):
            return body["error"]["message"]
    return None
