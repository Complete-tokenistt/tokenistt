"""Runtime smoke test for the tokenistt SDK (no network — uses httpx mocks).

Run:  python tests/smoke.py
"""
from __future__ import annotations

import asyncio

import httpx

from tokenistt import (
    AsyncOpenAI,
    BudgetExceededError,
    OpenAI,
)


# --------------------------------------------------------------------------- #
# Sync gateway mock
# --------------------------------------------------------------------------- #


def chat_body_is_stream(body: bytes) -> bool:
    return b'"stream":true' in body.replace(b" ", b"")


def make_sync_handler(captured: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        captured.setdefault("headers", []).append(dict(request.headers))
        captured.setdefault("urls", []).append(str(request.url))
        body = request.read()

        if str(request.url).rstrip("/").endswith("/chat/completions"):
            if chat_body_is_stream(body):
                sse = (
                    'data: {"id":"x","object":"chat.completion.chunk","created":1,'
                    '"model":"gpt-4o-mini","choices":[{"index":0,'
                    '"delta":{"role":"assistant","content":"Hel"}}]}\n\n'
                    'data: {"id":"x","object":"chat.completion.chunk","created":1,'
                    '"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n'
                    'data: {"id":"x","object":"chat.completion.chunk","created":1,'
                    '"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},'
                    '"finish_reason":"stop"}],"usage":{"prompt_tokens":3,'
                    '"completion_tokens":2,"total_tokens":5}}\n\n'
                    "data: [DONE]\n\n"
                )
                return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})
            return httpx.Response(
                200,
                json={
                    "id": "cmpl_1",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "gpt-4o-mini",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "Hi there!"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                },
            )

        if str(request.url).rstrip("/").endswith("/embeddings"):
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2]}],
                    "model": "text-embedding-3-small",
                    "usage": {"prompt_tokens": 4, "completion_tokens": 0, "total_tokens": 4},
                },
            )

        if str(request.url).rstrip("/").endswith("/models"):
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "data": [{"id": "gpt-4o-mini", "object": "model", "created": 1, "owned_by": "tokenistt"}],
                },
            )

        return httpx.Response(404, json={"error": {"message": "not found"}})

    return handler


def sync_client(handler, **kwargs):
    base = dict(api_key="sk-test", base_url="https://fake.local/v1")
    base.update(kwargs)
    base.setdefault("http_client", httpx.Client(transport=httpx.MockTransport(handler)))
    return OpenAI(**base)


# --------------------------------------------------------------------------- #
# Sync tests
# --------------------------------------------------------------------------- #


def test_sync_basic(captured, handler):
    usage_calls = []
    client = sync_client(
        handler,
        user="tester",
        cost_center="cc1",
        on_usage=lambda cost: usage_calls.append(cost),
        budget={"softLimit": 0.000001},
    )
    events = []
    client.on("usage", lambda e: events.append(("usage", e)))
    client.on("budget:warning", lambda e: events.append(("warn", e)))

    comp = client.chat.completions.create(
        model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}]
    )
    assert comp.choices[0].message.content == "Hi there!"
    assert comp.usage.total_tokens == 15
    assert len(usage_calls) == 1
    assert abs(usage_calls[0] - 4.5e-6) < 1e-9
    assert any(k == "warn" for k, _ in events)
    hdr = captured["headers"][0]
    assert hdr["x-tokenistt-user"] == "tester"
    assert hdr["x-tokenistt-cost-center"] == "cc1"
    assert hdr["authorization"] == "Bearer sk-test"
    print("✓ sync non-streaming + cost + headers + budget warning")


def test_sync_streaming(captured, handler):
    client = sync_client(handler, user="tester")
    stream = client.chat.completions.create(
        model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}], stream=True
    )
    out = ""
    for chunk in stream:
        out += chunk.choices[0].delta.content or ""
    assert out == "Hello", out
    full = stream.get_final_completion()
    assert full.choices[0].message.content == "Hello"
    assert full.usage.total_tokens == 5
    assert stream.cost is not None and stream.cost > 0
    print(f"✓ sync streaming reconstruct + cost metadata at end (cost={stream.cost:.8f})")


def test_sync_retry():
    state = {"n": 0}

    def handler(request):
        state["n"] += 1
        if state["n"] < 3:
            return httpx.Response(500, json={"error": {"message": "boom"}})
        return httpx.Response(
            200,
            json={
                "id": "r",
                "object": "chat.completion",
                "created": 1,
                "model": "m",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    client = sync_client(handler, max_retries=3)
    retries = []
    client.on("retry", lambda e: retries.append(e))
    comp = client.chat.completions.create(model="m", messages=[{"role": "user", "content": "x"}])
    assert comp.choices[0].message.content == "ok"
    assert state["n"] == 3
    assert len(retries) == 2
    print(f"✓ sync retry on 500 (attempts={state['n']}, retries={len(retries)})")


def test_sync_budget_block():
    client = sync_client(
        lambda r: httpx.Response(
            200,
            json={
                "id": "e",
                "object": "chat.completion",
                "created": 1,
                "model": "gpt-4",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "x"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 1000, "total_tokens": 2000},
            },
        ),
        budget={"hardLimit": 0.0000001},
        throw_on_budget_exceeded=True,
        on_usage=lambda c: None,
    )
    client.chat.completions.create(model="gpt-4", messages=[{"role": "user", "content": "x"}])
    try:
        client.chat.completions.create(model="gpt-4", messages=[{"role": "user", "content": "x"}])
        raise AssertionError("expected BudgetExceededError")
    except BudgetExceededError:
        pass
    print(f"✓ sync budget hard-stop (cumulative=${client.get_cumulative_cost():.6f})")


def test_sync_context_manager(handler):
    with sync_client(handler) as client:
        comp = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
        assert comp.choices[0].message.content == "Hi there!"
    print("✓ sync client context manager")


def test_sync_embeddings_and_models(handler):
    client = sync_client(handler)
    emb = client.embeddings.create(model="text-embedding-3-small", input="hello")
    assert emb.data[0].embedding == [0.1, 0.2]
    models = client.models.list()
    assert models.data[0].id == "gpt-4o-mini"
    print("✓ sync embeddings + models.list")


# --------------------------------------------------------------------------- #
# Async
# --------------------------------------------------------------------------- #


async def test_async_basic_and_stream():
    captured = {}

    def handler(request):
        captured.setdefault("headers", []).append(dict(request.headers))
        body = request.read()
        if chat_body_is_stream(body):
            sse = (
                'data: {"id":"x","object":"chat.completion.chunk","created":1,'
                '"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n'
                'data: {"id":"x","object":"chat.completion.chunk","created":1,'
                '"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},'
                '"finish_reason":"stop"}],"usage":{"prompt_tokens":2,'
                '"completion_tokens":1,"total_tokens":3}}\n\n'
                "data: [DONE]\n\n"
            )
            return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})
        return httpx.Response(
            200,
            json={
                "id": "a1",
                "object": "chat.completion",
                "created": 1,
                "model": "gpt-4o-mini",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Async hi"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10},
            },
        )

    client = AsyncOpenAI(
        api_key="x",
        base_url="https://fake.local/v1",
        user="async-user",
        on_usage=lambda c: None,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    async with client:
        comp = await client.chat.completions.create(
            model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}]
        )
        assert comp.choices[0].message.content == "Async hi"

        stream = await client.chat.completions.create(
            model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}], stream=True
        )
        out = ""
        async for chunk in stream:
            out += chunk.choices[0].delta.content or ""
        assert out == "Hi", out
        full = await stream.get_final_completion()
        assert full.usage.total_tokens == 3
        assert stream.cost is not None and stream.cost > 0

    assert captured["headers"][0]["x-tokenistt-user"] == "async-user"
    print(f"✓ async basic + streaming (cost={stream.cost:.8f}) + context manager")


async def test_async_budget_block():
    client = AsyncOpenAI(
        api_key="x",
        base_url="https://fake.local/v1",
        budget={"hardLimit": 0.0000001},
        throw_on_budget_exceeded=True,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(
                    200,
                    json={
                        "id": "e",
                        "object": "chat.completion",
                        "created": 1,
                        "model": "gpt-4",
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "x"}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 1000, "completion_tokens": 1000, "total_tokens": 2000},
                    },
                )
            )
        ),
    )
    await client.chat.completions.create(model="gpt-4", messages=[{"role": "user", "content": "x"}])
    try:
        await client.chat.completions.create(model="gpt-4", messages=[{"role": "user", "content": "x"}])
        raise AssertionError("expected BudgetExceededError")
    except BudgetExceededError:
        pass
    print(f"✓ async budget hard-stop (cumulative=${client.get_cumulative_cost():.6f})")


# --------------------------------------------------------------------------- #


def main():
    captured = {}
    handler = make_sync_handler(captured)
    test_sync_basic(captured, handler)
    test_sync_streaming(captured, handler)
    test_sync_retry()
    test_sync_budget_block()
    test_sync_context_manager(handler)
    test_sync_embeddings_and_models(handler)
    asyncio.run(test_async_basic_and_stream())
    asyncio.run(test_async_budget_block())
    print("\nALL OK")


if __name__ == "__main__":
    main()
