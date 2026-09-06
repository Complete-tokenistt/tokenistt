"""Cost pricing, computation, and the budget-aware cost tracker."""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from ..core.events import EventEmitter
from ..errors import BudgetExceededError
from ..types import BudgetEvent, BudgetConfig, UsageEvent

ModelPrice = Dict[str, float]  # {"input":..., "output":..., "cachedInput":...}
PricingTable = Dict[str, ModelPrice]


DEFAULT_PRICING: PricingTable = {
    "gpt-4o": {"input": 2.5, "output": 10},
    "gpt-4o-2024-08-06": {"input": 2.5, "output": 10},
    "gpt-4o-2024-11-20": {"input": 2.5, "output": 10},
    "gpt-4o-mini": {"input": 0.15, "output": 0.6},
    "gpt-4o-mini-2024-07-18": {"input": 0.15, "output": 0.6},
    "gpt-4-turbo": {"input": 10, "output": 30},
    "gpt-4-turbo-2024-04-09": {"input": 10, "output": 30},
    "gpt-4": {"input": 30, "output": 60},
    "gpt-4-32k": {"input": 60, "output": 120},
    "gpt-4-0125-preview": {"input": 10, "output": 30},
    "gpt-4-1106-preview": {"input": 10, "output": 30},
    "gpt-3.5-turbo": {"input": 0.5, "output": 1.5},
    "gpt-3.5-turbo-0125": {"input": 0.5, "output": 1.5},
    "gpt-3.5-turbo-instruct": {"input": 1.5, "output": 2},
    "text-embedding-3-small": {"input": 0.02, "output": 0},
    "text-embedding-3-large": {"input": 0.13, "output": 0},
    "text-embedding-ada-002": {"input": 0.1, "output": 0},
    "o1": {"input": 15, "output": 60},
    "o1-preview": {"input": 15, "output": 60},
    "o1-mini": {"input": 1.1, "output": 4.4},
    "o3-mini": {"input": 1.1, "output": 4.4},
    # Anthropic Claude Models
    "claude-3-5-sonnet": {"input": 3.0, "output": 15.0, "cachedInput": 0.3},
    "claude-3-5-sonnet-20241022": {"input": 3.0, "output": 15.0, "cachedInput": 0.3},
    "claude-3-5-haiku": {"input": 0.8, "output": 4.0, "cachedInput": 0.08},
    "claude-3-5-haiku-20241022": {"input": 0.8, "output": 4.0, "cachedInput": 0.08},
    "claude-3-opus": {"input": 15.0, "output": 75.0},
    "claude-3-opus-20240229": {"input": 15.0, "output": 75.0},
    "claude-3-sonnet": {"input": 3.0, "output": 15.0},
    "claude-3-sonnet-20240229": {"input": 3.0, "output": 15.0},
    "claude-3-haiku": {"input": 0.25, "output": 1.25},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
}


def get_default_pricing() -> PricingTable:
    return {k: dict(v) for k, v in DEFAULT_PRICING.items()}


def _resolve_price(model: str, pricing: PricingTable) -> ModelPrice:
    if model in pricing:
        return pricing[model]
    best: Optional[ModelPrice] = None
    best_len = -1
    for key, val in pricing.items():
        if model.startswith(key) and len(key) > best_len:
            best = val
            best_len = len(key)
    return best or {"input": 0.0, "output": 0.0}


def compute_cost(model: str, usage: Dict[str, Any], pricing: PricingTable) -> float:
    price = _resolve_price(model, pricing)
    prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
    completion_tokens = int(usage.get("completion_tokens", 0) or 0)
    cached = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0)
    uncached = max(0, prompt_tokens - cached)
    cached_rate = price.get("cachedInput", price["input"])
    in_cost = (uncached / 1_000_000) * price["input"] + (cached / 1_000_000) * cached_rate
    out_cost = (completion_tokens / 1_000_000) * price["output"]
    return in_cost + out_cost


class CostTracker(EventEmitter):
    def __init__(
        self,
        *,
        pricing: PricingTable,
        budget: Optional[BudgetConfig],
        on_usage: Optional[Callable[[float], None]],
        currency: str,
    ):
        super().__init__()
        self.cumulative = 0.0
        self._warned = False
        self._exceeded = False
        self._pricing = pricing
        self._budget = budget
        self._on_usage = on_usage
        self._currency = currency

    def record(
        self,
        model: str,
        usage: Dict[str, Any],
        *,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> UsageEvent:
        cost = compute_cost(model, usage, self._pricing)
        self.cumulative += cost
        event = UsageEvent(
            cost=cost,
            cumulative_cost=self.cumulative,
            currency=self._currency,
            model=model,
            prompt_tokens=int(usage.get("prompt_tokens", 0) or 0),
            completion_tokens=int(usage.get("completion_tokens", 0) or 0),
            total_tokens=int(usage.get("total_tokens", 0) or 0),
            user=user,
            cost_center=cost_center,
            request_id=request_id,
        )
        if self._on_usage is not None:
            self._on_usage(cost)
        self.trigger("usage", event)
        self._check_budget(user, cost_center)
        return event

    def _check_budget(self, user: Optional[str], cost_center: Optional[str]) -> None:
        budget = self._budget
        if not budget:
            return
        soft = budget.get("softLimit")
        hard = budget.get("hardLimit")
        warn_fraction = budget.get("warnAtFraction", 0.8)
        warn_threshold = soft if soft is not None else (
            hard * warn_fraction if hard is not None else None
        )
        if warn_threshold is not None and self.cumulative >= warn_threshold and not self._warned:
            self._warned = True
            self.trigger(
                "budget:warning",
                BudgetEvent(
                    cumulative_cost=self.cumulative,
                    limit=warn_threshold,
                    currency=self._currency,
                    user=user,
                    cost_center=cost_center,
                ),
            )
        if hard is not None and self.cumulative >= hard and not self._exceeded:
            self._exceeded = True
            self.trigger(
                "budget:exceeded",
                BudgetEvent(
                    cumulative_cost=self.cumulative,
                    limit=hard,
                    currency=self._currency,
                    user=user,
                    cost_center=cost_center,
                ),
            )

    def maybe_throw_if_exceeded(self, user: Optional[str], cost_center: Optional[str]) -> None:
        hard = self._budget.get("hardLimit") if self._budget else None
        if hard is not None and self.cumulative >= hard:
            raise BudgetExceededError(self.cumulative, hard)
