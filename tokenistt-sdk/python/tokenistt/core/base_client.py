"""Shared client settings, HTTP transport with retry/backoff, and events."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Dict, Optional

import httpx

from .._version import VERSION
from ..core._utils import (
    build_url,
    compute_delay,
    jsonable,
    merge_query,
    parse_retry_after,
)
from ..core.cost import CostTracker, get_default_pricing
from ..core.events import EventEmitter
from ..errors import (
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    APIUserAbortError,
    make_error_from_response,
)
from ..types import BudgetConfig, UsageEvent

RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
DEFAULT_BASE_URL = "https://api.tokenistt.ai/v1"


class _ClientCommon(EventEmitter):
    def _init_settings(
        self,
        *,
        api_key: Optional[str],
        base_url: Optional[str],
        organization: Optional[str],
        project: Optional[str],
        user: Optional[str],
        cost_center: Optional[str],
        timeout: float,
        max_retries: int,
        pricing: Optional[Dict[str, Dict[str, float]]],
        budget: Optional[BudgetConfig],
        on_usage: Optional[Callable[[float], None]],
        throw_on_budget_exceeded: bool,
        currency: str,
        default_headers: Optional[Dict[str, str]],
        default_query: Optional[Dict[str, Any]],
    ) -> None:
        self.api_key = api_key
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.organization = organization
        self.project = project
        self.user = user
        self.cost_center = cost_center
        self.timeout = timeout
        self.max_retries = max_retries
        self.currency = currency
        self.throw_on_budget_exceeded = throw_on_budget_exceeded
        self.default_headers = default_headers or {}
        self.default_query = default_query or {}
        self._cost_tracker = CostTracker(
            pricing=pricing or get_default_pricing(),
            budget=budget,
            on_usage=on_usage,
            currency=currency,
        )
        self._cost_tracker.on("usage", lambda e: self.trigger("usage", e))
        self._cost_tracker.on("budget:warning", lambda e: self.trigger("budget:warning", e))
        self._cost_tracker.on("budget:exceeded", lambda e: self.trigger("budget:exceeded", e))

    def _clone_kwargs(self) -> Dict[str, Any]:
        return {
            "api_key": self.api_key,
            "base_url": self.base_url,
            "organization": self.organization,
            "project": self.project,
            "user": self.user,
            "cost_center": self.cost_center,
            "timeout": self.timeout,
            "max_retries": self.max_retries,
            "pricing": self._cost_tracker._pricing,
            "budget": self._cost_tracker._budget,
            "on_usage": self._cost_tracker._on_usage,
            "throw_on_budget_exceeded": self.throw_on_budget_exceeded,
            "currency": self.currency,
            "default_headers": self.default_headers,
            "default_query": self.default_query,
        }

    def _build_headers(
        self,
        user: Optional[str],
        cost_center: Optional[str],
        extra_headers: Optional[Dict[str, str]],
    ) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Authorization": f"Bearer {self.api_key or ''}",
            "X-Tokenistt-SDK-Version": VERSION,
        }
        u = user or self.user
        cc = cost_center or self.cost_center
        if u:
            headers["X-Tokenistt-User"] = u
        if cc:
            headers["X-Tokenistt-Cost-Center"] = cc
        if self.organization:
            headers["OpenAI-Organization"] = self.organization
        if self.project:
            headers["OpenAI-Project"] = self.project
        headers.update(self.default_headers)
        if extra_headers:
            headers.update(extra_headers)
        return headers

    def _record_usage(
        self,
        usage: Any,
        *,
        model: str,
        user: Optional[str],
        cost_center: Optional[str],
        request_id: Optional[str],
    ) -> Optional[UsageEvent]:
        if usage is None:
            return None
        if hasattr(usage, "model_dump"):
            usage = usage.model_dump()
        return self._cost_tracker.record(
            model, usage, user=user, cost_center=cost_center, request_id=request_id
        )

    def get_cumulative_cost(self) -> float:
        return self._cost_tracker.cumulative

    def with_options(self, **kwargs: Any) -> "Any":
        merged = self._clone_kwargs()
        merged.update(kwargs)
        return self.__class__(**merged)


class BaseClient(_ClientCommon):
    """Synchronous client (mirrors ``openai.OpenAI``)."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        organization: Optional[str] = None,
        project: Optional[str] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        timeout: float = 600.0,
        max_retries: int = 2,
        pricing: Optional[Dict[str, Dict[str, float]]] = None,
        budget: Optional[BudgetConfig] = None,
        on_usage: Optional[Callable[[float], None]] = None,
        throw_on_budget_exceeded: bool = False,
        currency: str = "USD",
        http_client: Optional[httpx.Client] = None,
        default_headers: Optional[Dict[str, str]] = None,
        default_query: Optional[Dict[str, Any]] = None,
    ):
        super().__init__()
        self._init_settings(
            api_key=api_key,
            base_url=base_url,
            organization=organization,
            project=project,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            pricing=pricing,
            budget=budget,
            on_usage=on_usage,
            throw_on_budget_exceeded=throw_on_budget_exceeded,
            currency=currency,
            default_headers=default_headers,
            default_query=default_query,
        )
        self._client = http_client or httpx.Client(timeout=httpx.Timeout(self.timeout))
        self._init_resources()

    def _init_resources(self) -> None:  # overridden in OpenAI
        pass

    # -- request ---------------------------------------------------------- #

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        query: Optional[Dict[str, Any]] = None,
        stream: bool = False,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
    ) -> httpx.Response:
        if self.throw_on_budget_exceeded:
            self._cost_tracker.maybe_throw_if_exceeded(
                user or self.user, cost_center or self.cost_center
            )
        timeout = timeout if timeout is not None else self.timeout
        max_retries = max_retries if max_retries is not None else self.max_retries
        merged_query = merge_query(self.default_query, query, extra_query)
        url = build_url(self.base_url, path, merged_query)
        headers = self._build_headers(user, cost_center, extra_headers)
        body = jsonable(json) if json is not None else None

        attempt = 0
        last_error: Optional[Exception] = None
        while True:
            self.trigger("request", {"method": method, "url": url})
            try:
                request = self._client.build_request(
                    method, url, json=body, headers=headers, timeout=timeout
                )
                response = self._client.send(request, stream=stream)
            except httpx.TimeoutException as exc:
                last_error = APIConnectionTimeoutError(message=f"Request to {url} timed out: {exc}")
                if attempt >= max_retries:
                    raise last_error
                attempt += 1
                delay = compute_delay(attempt)
                self.trigger("retry", {"attempt": attempt, "delay_ms": delay, "error": last_error})
                time.sleep(delay / 1000.0)
                continue
            except httpx.HTTPError as exc:
                last_error = APIConnectionError(
                    message=f"Request to {url} failed: {exc}", cause=exc
                )
                if attempt >= max_retries:
                    raise last_error
                attempt += 1
                delay = compute_delay(attempt)
                self.trigger("retry", {"attempt": attempt, "delay_ms": delay, "error": last_error})
                time.sleep(delay / 1000.0)
                continue

            self.trigger(
                "response",
                {
                    "method": method,
                    "url": url,
                    "status": response.status_code,
                    "headers": dict(response.headers),
                },
            )
            if 200 <= response.status_code < 300:
                return response

            try:
                resp_body = response.json()
            except Exception:
                resp_body = None
            api_error = make_error_from_response(
                response.status_code, resp_body, dict(response.headers)
            )
            last_error = api_error
            ra = response.headers.get("retry-after")
            retry_after = parse_retry_after(ra) if ra else None
            if attempt >= max_retries or response.status_code not in RETRYABLE_STATUS:
                raise api_error
            attempt += 1
            delay = retry_after if retry_after is not None else compute_delay(attempt)
            self.trigger("retry", {"attempt": attempt, "delay_ms": delay, "error": api_error})
            time.sleep(delay / 1000.0)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "BaseClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncBaseClient(_ClientCommon):
    """Asynchronous client (mirrors ``openai.AsyncOpenAI``)."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        organization: Optional[str] = None,
        project: Optional[str] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        timeout: float = 600.0,
        max_retries: int = 2,
        pricing: Optional[Dict[str, Dict[str, float]]] = None,
        budget: Optional[BudgetConfig] = None,
        on_usage: Optional[Callable[[float], None]] = None,
        throw_on_budget_exceeded: bool = False,
        currency: str = "USD",
        http_client: Optional[httpx.AsyncClient] = None,
        default_headers: Optional[Dict[str, str]] = None,
        default_query: Optional[Dict[str, Any]] = None,
    ):
        super().__init__()
        self._init_settings(
            api_key=api_key,
            base_url=base_url,
            organization=organization,
            project=project,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            pricing=pricing,
            budget=budget,
            on_usage=on_usage,
            throw_on_budget_exceeded=throw_on_budget_exceeded,
            currency=currency,
            default_headers=default_headers,
            default_query=default_query,
        )
        self._client = http_client or httpx.AsyncClient(timeout=httpx.Timeout(self.timeout))
        self._init_resources()

    def _init_resources(self) -> None:  # overridden in AsyncOpenAI
        pass

    async def _arequest(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        query: Optional[Dict[str, Any]] = None,
        stream: bool = False,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
    ) -> httpx.Response:
        if self.throw_on_budget_exceeded:
            self._cost_tracker.maybe_throw_if_exceeded(
                user or self.user, cost_center or self.cost_center
            )
        timeout = timeout if timeout is not None else self.timeout
        max_retries = max_retries if max_retries is not None else self.max_retries
        merged_query = merge_query(self.default_query, query, extra_query)
        url = build_url(self.base_url, path, merged_query)
        headers = self._build_headers(user, cost_center, extra_headers)
        body = jsonable(json) if json is not None else None

        attempt = 0
        last_error: Optional[Exception] = None
        while True:
            self.trigger("request", {"method": method, "url": url})
            try:
                request = self._client.build_request(
                    method, url, json=body, headers=headers, timeout=timeout
                )
                response = await self._client.send(request, stream=stream)
            except httpx.TimeoutException as exc:
                last_error = APIConnectionTimeoutError(message=f"Request to {url} timed out: {exc}")
                if attempt >= max_retries:
                    raise last_error
                attempt += 1
                delay = compute_delay(attempt)
                self.trigger("retry", {"attempt": attempt, "delay_ms": delay, "error": last_error})
                await asyncio.sleep(delay / 1000.0)
                continue
            except httpx.HTTPError as exc:
                last_error = APIConnectionError(
                    message=f"Request to {url} failed: {exc}", cause=exc
                )
                if attempt >= max_retries:
                    raise last_error
                attempt += 1
                delay = compute_delay(attempt)
                self.trigger("retry", {"attempt": attempt, "delay_ms": delay, "error": last_error})
                await asyncio.sleep(delay / 1000.0)
                continue

            self.trigger(
                "response",
                {
                    "method": method,
                    "url": url,
                    "status": response.status_code,
                    "headers": dict(response.headers),
                },
            )
            if 200 <= response.status_code < 300:
                return response

            try:
                resp_body = response.json()
            except Exception:
                resp_body = None
            api_error = make_error_from_response(
                response.status_code, resp_body, dict(response.headers)
            )
            last_error = api_error
            ra = response.headers.get("retry-after")
            retry_after = parse_retry_after(ra) if ra else None
            if attempt >= max_retries or response.status_code not in RETRYABLE_STATUS:
                raise api_error
            attempt += 1
            delay = retry_after if retry_after is not None else compute_delay(attempt)
            self.trigger("retry", {"attempt": attempt, "delay_ms": delay, "error": api_error})
            await asyncio.sleep(delay / 1000.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncBaseClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
