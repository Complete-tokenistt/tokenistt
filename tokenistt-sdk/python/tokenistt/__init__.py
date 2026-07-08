"""
tokenistt — a drop-in Python replacement for the ``openai`` library that routes
to the Tokenistt gateway, with auto-retry, cost tracking, budget warnings, and
per-user / per-cost-center attribution.
"""
from __future__ import annotations

from ._version import VERSION
from .async_client import AsyncOpenAI
from .client import OpenAI
from .core.cost import CostTracker, compute_cost, get_default_pricing
from .errors import (
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    APIUserAbortError,
    AuthenticationError,
    BadRequestError,
    BudgetExceededError,
    InternalServerError,
    RateLimitError,
    TokenisttError,
)
from .core.stream import AsyncStream, Stream
from .types import (
    BudgetConfig,
    ChatCompletion,
    ChatCompletionChunk,
    Completion,
    CreateEmbeddingResponse,
    CreateModerationResponse,
    Embedding,
    Model,
    ModelListResponse,
    ModerationResult,
    Usage,
    UsageEvent,
)

__version__ = VERSION

__all__ = [
    "OpenAI",
    "AsyncOpenAI",
    "Stream",
    "AsyncStream",
    "TokenisttError",
    "APIError",
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "APIUserAbortError",
    "RateLimitError",
    "BadRequestError",
    "AuthenticationError",
    "InternalServerError",
    "BudgetExceededError",
    "CostTracker",
    "compute_cost",
    "get_default_pricing",
    "VERSION",
    # types
    "ChatCompletion",
    "ChatCompletionChunk",
    "Completion",
    "CreateEmbeddingResponse",
    "CreateModerationResponse",
    "Embedding",
    "Model",
    "ModelListResponse",
    "ModerationResult",
    "Usage",
    "UsageEvent",
    "BudgetConfig",
]
