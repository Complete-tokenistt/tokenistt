"""Legacy completions resource (sync + async)."""
from __future__ import annotations

from typing import Any, Dict, Optional, Union

from ..core.base_client import AsyncBaseClient, BaseClient
from ..core.stream import AsyncStream, Stream
from ..types import Completion, CompletionCreateParams


class Completions:
    def __init__(self, client: BaseClient):
        self._client = client

    def create(
        self,
        *,
        model: str,
        prompt: Any = None,
        stream: bool = False,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Union[Completion, Stream]:
        body: Dict[str, Any] = {"model": model, **kwargs}
        if prompt is not None:
            body["prompt"] = prompt
        if extra_body:
            body.update(extra_body)
        if stream:
            body["stream"] = True
        response = self._client._request(
            "POST",
            "/completions",
            json=body,
            stream=stream,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
            extra_query=extra_query,
        )
        if stream:
            return Stream(
                response=response,
                client=self._client,
                model=model,
                user=user or self._client.user,
                cost_center=cost_center or self._client.cost_center,
                request_id=response.headers.get("x-request-id"),
                model_cls=Completion,
                final_builder=None,
            )
        obj = Completion.model_validate(response.json())
        if obj.usage is not None:
            self._client._record_usage(
                obj.usage,
                model=model,
                user=user or self._client.user,
                cost_center=cost_center or self._client.cost_center,
                request_id=response.headers.get("x-request-id"),
            )
        return obj


class AsyncCompletions:
    def __init__(self, client: AsyncBaseClient):
        self._client = client

    async def create(
        self,
        *,
        model: str,
        prompt: Any = None,
        stream: bool = False,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Union[Completion, AsyncStream]:
        body: Dict[str, Any] = {"model": model, **kwargs}
        if prompt is not None:
            body["prompt"] = prompt
        if extra_body:
            body.update(extra_body)
        if stream:
            body["stream"] = True
        response = await self._client._arequest(
            "POST",
            "/completions",
            json=body,
            stream=stream,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
            extra_query=extra_query,
        )
        if stream:
            return AsyncStream(
                response=response,
                client=self._client,
                model=model,
                user=user or self._client.user,
                cost_center=cost_center or self._client.cost_center,
                request_id=response.headers.get("x-request-id"),
                model_cls=Completion,
                final_builder=None,
            )
        obj = Completion.model_validate(response.json())
        if obj.usage is not None:
            self._client._record_usage(
                obj.usage,
                model=model,
                user=user or self._client.user,
                cost_center=cost_center or self._client.cost_center,
                request_id=response.headers.get("x-request-id"),
            )
        return obj
