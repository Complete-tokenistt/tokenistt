"""Run with:  python examples/quickstart.py  (set TOKENISTT_API_KEY / TOKENISTT_BASE_URL)"""
from __future__ import annotations

import asyncio

import tokenistt


def main() -> None:
    client = tokenistt.OpenAI(
        api_key="tk-test",
        base_url="https://gateway.tokenistt.ai/v1",
        user="examples/quickstart",
        cost_center="demo",
        on_usage=lambda cost: print(f"  -> request cost: ${cost:.6f}"),
        budget={"softLimit": 1, "hardLimit": 5},
    )
    client.on("usage", lambda e: print(f"  -> cumulative: ${e.cumulative_cost:.6f} ({e.model})"))
    client.on("budget:warning", lambda e: print(f"  !! budget warning at ${e.cumulative_cost:.4f}"))

    # Non-streaming
    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are terse."},
            {"role": "user", "content": "Say hello in 3 words."},
        ],
        user="alice",            # per-request attribution override
        cost_center="onboarding",
    )
    print("Completion:", completion.choices[0].message.content)
    print("Usage:", completion.usage)

    # Streaming
    print("\nStreaming:")
    stream = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Write a haiku about APIs."}],
        stream=True,
    )
    for chunk in stream:
        print(chunk.choices[0].delta.content or "", end="")
    full = stream.get_final_completion()
    print("\n\nFinal usage:", full.usage)
    print("Total tracked spend:", client.get_cumulative_cost())


async def main_async() -> None:
    client = tokenistt.AsyncOpenAI(api_key="tk-test", base_url="https://gateway.tokenistt.ai/v1")
    async with client:
        stream = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "Hi"}],
            stream=True,
        )
        async for chunk in stream:
            print(chunk.choices[0].delta.content or "", end="")
        full = await stream.get_final_completion()
        print("\nasync usage:", full.usage)


if __name__ == "__main__":
    main()
    print("\n--- async ---")
    asyncio.run(main_async())
