"""SSE stream readers (sync + async) for chat completions.

The stream yields ``ChatCompletionChunk`` models and, once exhausted, records
cost/usage on the client and lets you reconstruct the full ``ChatCompletion``.
"""
from __future__ import annotations

from typing import Any, Callable, Iterator, List, Optional

from ..types import ChatCompletion, ChatCompletionChunk, Usage


def build_chat_completion(
    chunks: List[ChatCompletionChunk], usage: Optional[Usage]
) -> ChatCompletion:
    if not chunks:
        raise ValueError("No chunks were received from the stream.")

    first = chunks[0]
    last = chunks[-1]
    max_index = -1
    for c in chunks:
        for ch in c.choices:
            if ch.index > max_index:
                max_index = ch.index

    choices = []
    for i in range(max_index + 1):
        message: dict = {
            "role": "assistant",
            "content": None,
            "refusal": None,
            "tool_calls": [],
            "function_call": None,
        }
        finish_reason = None
        for c in chunks:
            ch = next((x for x in c.choices if x.index == i), None)
            if ch is None:
                continue
            d = ch.delta
            if d.role:
                message["role"] = d.role
            if d.content:
                message["content"] = (message["content"] or "") + d.content
            if d.refusal:
                message["refusal"] = (message["refusal"] or "") + d.refusal
            if d.function_call:
                if message["function_call"] is None:
                    message["function_call"] = {"name": "", "arguments": ""}
                if d.function_call.name:
                    message["function_call"]["name"] += d.function_call.name
                if d.function_call.arguments:
                    message["function_call"]["arguments"] += d.function_call.arguments
            if d.tool_calls:
                for tc in d.tool_calls:
                    existing = (
                        message["tool_calls"][tc.index]
                        if tc.index < len(message["tool_calls"])
                        else None
                    )
                    if existing is None:
                        message["tool_calls"].append(
                            {
                                "id": tc.id or "",
                                "type": "function",
                                "function": {
                                    "name": tc.function.name if tc.function else "",
                                    "arguments": tc.function.arguments if tc.function else "",
                                },
                            }
                        )
                    else:
                        if tc.id:
                            existing["id"] += tc.id
                        if tc.function and tc.function.name:
                            existing["function"]["name"] += tc.function.name
                        if tc.function and tc.function.arguments:
                            existing["function"]["arguments"] += tc.function.arguments
        if not message["tool_calls"]:
            message["tool_calls"] = None
        choices.append({"index": i, "message": message, "finish_reason": finish_reason})

    return ChatCompletion(
        id=first.id,
        object="chat.completion",
        created=first.created,
        model=first.model,
        system_fingerprint=last.system_fingerprint or first.system_fingerprint,
        choices=choices,  # type: ignore[arg-type]
        usage=usage,
    )


class Stream(Iterator[ChatCompletionChunk]):
    """Synchronous SSE stream (mirrors ``openai.Stream``)."""

    def __init__(
        self,
        *,
        response: Any,
        client: Any,
        model: str,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        request_id: Optional[str] = None,
        model_cls: Any = ChatCompletionChunk,
        final_builder: Optional[Callable[..., Any]] = None,
    ):
        self._response = response
        self._client = client
        self._model = model
        self._user = user
        self._cost_center = cost_center
        self._request_id = request_id
        self._model_cls = model_cls
        self._final_builder = final_builder
        self._chunks: List[Any] = []
        self._final_usage: Optional[Usage] = None
        self._usage_event: Optional[Any] = None
        self._cost: Optional[float] = None
        self._done = False
        self._iterator = self._iter()

    def __iter__(self) -> "Stream":
        return self

    def __next__(self) -> ChatCompletionChunk:
        return next(self._iterator)

    def _iter(self) -> Iterator[ChatCompletionChunk]:
        try:
            for line in self._response.iter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].lstrip()
                if data == "[DONE]":
                    break
                chunk = self._model_cls.model_validate_json(data)
                self._chunks.append(chunk)
                usage = getattr(chunk, "usage", None)
                if usage is not None:
                    self._final_usage = usage
                yield chunk
        except GeneratorExit:
            pass
        finally:
            self._finish()
            try:
                self._response.close()
            except Exception:
                pass

    def _finish(self) -> None:
        if self._done:
            return
        self._done = True
        self._usage_event = self._client._record_usage(
            self._final_usage,
            model=self._model,
            user=self._user,
            cost_center=self._cost_center,
            request_id=self._request_id,
        )
        if self._usage_event is not None:
            self._cost = self._usage_event.cost

    def get_final_completion(self) -> Any:
        for _ in self:
            pass
        if self._final_builder is None:
            raise NotImplementedError("final completion is not supported for this stream")
        return self._final_builder(self._chunks, self._final_usage)

    @property
    def cost(self) -> Optional[float]:
        return self._cost

    @property
    def usage(self) -> Optional[Usage]:
        return self._final_usage

    @property
    def cumulative_cost(self) -> Optional[float]:
        return self._usage_event.cumulative_cost if self._usage_event else None

    @property
    def usage_event(self) -> Optional[Any]:
        return self._usage_event

    def __enter__(self) -> "Stream":
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            self._response.close()
        except Exception:
            pass

    def close(self) -> None:
        try:
            self._response.close()
        except Exception:
            pass


class AsyncStream:
    """Asynchronous SSE stream (mirrors ``openai.AsyncStream``)."""

    def __init__(
        self,
        *,
        response: Any,
        client: Any,
        model: str,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        request_id: Optional[str] = None,
        model_cls: Any = ChatCompletionChunk,
        final_builder: Optional[Callable[..., Any]] = None,
    ):
        self._response = response
        self._client = client
        self._model = model
        self._user = user
        self._cost_center = cost_center
        self._request_id = request_id
        self._model_cls = model_cls
        self._final_builder = final_builder
        self._chunks: List[Any] = []
        self._final_usage: Optional[Usage] = None
        self._usage_event: Optional[Any] = None
        self._cost: Optional[float] = None
        self._done = False

    def __aiter__(self) -> "AsyncStream":
        self._aiterator = self._aiter()
        return self

    async def __anext__(self) -> ChatCompletionChunk:
        return await self._aiterator.__anext__()

    async def _aiter(self):
        try:
            async for line in self._response.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].lstrip()
                if data == "[DONE]":
                    break
                chunk = self._model_cls.model_validate_json(data)
                self._chunks.append(chunk)
                usage = getattr(chunk, "usage", None)
                if usage is not None:
                    self._final_usage = usage
                yield chunk
        except GeneratorExit:
            pass
        finally:
            self._finish()
            try:
                await self._response.aclose()
            except Exception:
                pass

    def _finish(self) -> None:
        if self._done:
            return
        self._done = True
        self._usage_event = self._client._record_usage(
            self._final_usage,
            model=self._model,
            user=self._user,
            cost_center=self._cost_center,
            request_id=self._request_id,
        )
        if self._usage_event is not None:
            self._cost = self._usage_event.cost

    async def get_final_completion(self) -> Any:
        async for _ in self:
            pass
        if self._final_builder is None:
            raise NotImplementedError("final completion is not supported for this stream")
        return self._final_builder(self._chunks, self._final_usage)

    @property
    def cost(self) -> Optional[float]:
        return self._cost

    @property
    def usage(self) -> Optional[Usage]:
        return self._final_usage

    @property
    def cumulative_cost(self) -> Optional[float]:
        return self._usage_event.cumulative_cost if self._usage_event else None

    @property
    def usage_event(self) -> Optional[Any]:
        return self._usage_event

    async def __aenter__(self) -> "AsyncStream":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        try:
            await self._response.aclose()
        except Exception:
            pass

    async def aclose(self) -> None:
        try:
            await self._response.aclose()
        except Exception:
            pass
