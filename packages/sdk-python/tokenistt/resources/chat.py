"""Chat completions resource (sync + async)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from ..core.base_client import AsyncBaseClient, BaseClient
from ..core.stream import AsyncStream, Stream, build_chat_completion
from ..types import (
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionMessageParam,
)


class Completions:
    def __init__(self, client: BaseClient):
        self._client = client

    def create(
        self,
        *,
        model: str,
        messages: List[ChatCompletionMessageParam],
        stream: bool = False,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Union[ChatCompletion, Stream[ChatCompletionChunk]]:
        params: Dict[str, Any] = {"model": model, "messages": messages, **kwargs}
        if extra_body:
            params.update(extra_body)
        if stream:
            params["stream"] = True
            params.setdefault("stream_options", {})["include_usage"] = True
        else:
            params["stream"] = False

        response = self._client._request(
            "POST",
            "/chat/completions",
            json=params,
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
                final_builder=build_chat_completion,
            )

        data = response.json()
        completion = ChatCompletion.model_validate(data)
        self._client._record_usage(
            completion.usage,
            model=model,
            user=user or self._client.user,
            cost_center=cost_center or self._client.cost_center,
            request_id=response.headers.get("x-request-id"),
        )
        return completion

    def stream(self, **kwargs: Any) -> Stream[ChatCompletionChunk]:
        kwargs["stream"] = True
        return self.create(**kwargs)  # type: ignore[return-value]


class AsyncCompletions:
    def __init__(self, client: AsyncBaseClient):
        self._client = client

    async def create(
        self,
        *,
        model: str,
        messages: List[ChatCompletionMessageParam],
        stream: bool = False,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Union[ChatCompletion, AsyncStream]:
        params: Dict[str, Any] = {"model": model, "messages": messages, **kwargs}
        if extra_body:
            params.update(extra_body)
        if stream:
            params["stream"] = True
            params.setdefault("stream_options", {})["include_usage"] = True
        else:
            params["stream"] = False

        response = await self._client._arequest(
            "POST",
            "/chat/completions",
            json=params,
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
                final_builder=build_chat_completion,
            )

        data = response.json()
        completion = ChatCompletion.model_validate(data)
        self._client._record_usage(
            completion.usage,
            model=model,
            user=user or self._client.user,
            cost_center=cost_center or self._client.cost_center,
            request_id=response.headers.get("x-request-id"),
        )
        return completion

    def stream(self, **kwargs: Any) -> "AsyncStream":
        kwargs["stream"] = True
        return self.create(**kwargs)  # type: ignore[return-value]


class Chat:
    def __init__(self, client: BaseClient):
        self.completions = Completions(client)


class AsyncChat:
    def __init__(self, client: AsyncBaseClient):
        self.completions = AsyncCompletions(client)
