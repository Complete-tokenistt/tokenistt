"""Live test: drives the Python SDK against a REAL running gateway (no mocks).

    TOKENISTT_BASE_URL=http://localhost:3000/v1 TOKENISTT_API_KEY=tktt_live_... python tests/live.py

Uses the gateway's offline ``mock:echo`` model by default (MODEL=... to change).
"""
from __future__ import annotations

import os
import sys

from tokenistt import AuthenticationError, BudgetExceededError, OpenAI

base_url = os.environ.get("TOKENISTT_BASE_URL")
api_key = os.environ.get("TOKENISTT_API_KEY")
model = os.environ.get("MODEL", "mock:echo")
if not base_url or not api_key:
    sys.exit("TOKENISTT_BASE_URL and TOKENISTT_API_KEY are required")

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{'' if ok else '  -> ' + detail}")
    if not ok:
        failed += 1


client = OpenAI(
    api_key=api_key,
    base_url=base_url,
    attribution={"team": "sdk-live-test", "repo": "tokenistt/sdk", "feature": "live-test"},
    max_retries=0,
)

c = client.chat.completions.create(model=model, messages=[{"role": "user", "content": "hello sdk"}])
check("chat completion returns the reply", c.choices[0].message.content == "mock reply: hello sdk", repr(c.choices))
check("usage is present", bool(c.usage) and c.usage.total_tokens > 0, repr(c.usage))
check("SDK tracked a cumulative cost", client.get_cumulative_cost() > 0, str(client.get_cumulative_cost()))

text = ""
for chunk in client.chat.completions.create(model=model, stream=True, messages=[{"role": "user", "content": "stream me"}]):
    if chunk.choices and chunk.choices[0].delta.content:
        text += chunk.choices[0].delta.content
check("streaming delivers the full reply", text == "mock reply: stream me", repr(text))

u = client.usage()
check("usage() reports spend, requests and top models", u["month"]["requests"] >= 2 and u["month"]["cost_usd"] > 0 and isinstance(u["top_models"], list), repr(u)[:200])

try:
    OpenAI(api_key="tktt_live_not_a_real_key", base_url=base_url, max_retries=0).chat.completions.create(
        model=model, messages=[{"role": "user", "content": "x"}]
    )
    check("invalid key raises AuthenticationError", False, "no error raised")
except AuthenticationError:
    check("invalid key raises AuthenticationError", True)
except Exception as e:  # noqa: BLE001
    check("invalid key raises AuthenticationError", False, repr(e))

capped = OpenAI(
    api_key=api_key, base_url=base_url, max_retries=0,
    throw_on_budget_exceeded=True, budget={"hardLimit": 0.0000001},
)
capped.chat.completions.create(model=model, messages=[{"role": "user", "content": "spend a little"}])
try:
    capped.chat.completions.create(model=model, messages=[{"role": "user", "content": "again"}])
    check("hard budget raises BudgetExceededError on the next call", False, "no error raised")
except BudgetExceededError:
    check("hard budget raises BudgetExceededError on the next call", True)

print("\nALL OK" if not failed else f"\n{failed} check(s) failed")
sys.exit(1 if failed else 0)
