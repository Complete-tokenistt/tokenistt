"""OpenAI-compatible Pydantic models (response shapes + request-param shapes).

Response models are strict (parsed from gateway JSON). Request-param models use
``extra="allow"`` so newer / unknown fields pass through untouched.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict, Union

from pydantic import BaseModel, ConfigDict, Field

# --------------------------------------------------------------------------- #
# Shared
# --------------------------------------------------------------------------- #


class Usage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    prompt_tokens_details: Optional["PromptTokensDetails"] = None
    completion_tokens_details: Optional["CompletionTokensDetails"] = None


class PromptTokensDetails(BaseModel):
    cached_tokens: Optional[int] = None
    audio_tokens: Optional[int] = None


class CompletionTokensDetails(BaseModel):
    reasoning_tokens: Optional[int] = None
    audio_tokens: Optional[int] = None
    accepted_prediction_tokens: Optional[int] = None
    rejected_prediction_tokens: Optional[int] = None


# --------------------------------------------------------------------------- #
# Functions / tools
# --------------------------------------------------------------------------- #


class FunctionCall(BaseModel):
    name: str
    arguments: str


class FunctionDefinition(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None
    strict: Optional[bool] = None


class ToolDefinition(BaseModel):
    type: Literal["function"] = "function"
    function: FunctionDefinition


class ToolCall(BaseModel):
    id: str
    type: Literal["function"] = "function"
    function: FunctionCall


class FunctionCallDelta(BaseModel):
    name: Optional[str] = None
    arguments: Optional[str] = None


class ToolCallDelta(BaseModel):
    index: int
    id: Optional[str] = None
    type: Optional[Literal["function"]] = None
    function: Optional[FunctionCallDelta] = None


# --------------------------------------------------------------------------- #
# Chat content parts
# --------------------------------------------------------------------------- #


class ChatCompletionContentPartText(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ChatCompletionContentPartImage(BaseModel):
    type: Literal["image_url"] = "image_url"
    image_url: Dict[str, Any]


ChatCompletionContentPart = Union[
    ChatCompletionContentPartText, ChatCompletionContentPartImage
]


# --------------------------------------------------------------------------- #
# Chat messages (request params)
# --------------------------------------------------------------------------- #


class _ParamBase(BaseModel):
    model_config = ConfigDict(extra="allow")


class SystemMessageParam(_ParamBase):
    role: Literal["system"] = "system"
    content: str
    name: Optional[str] = None


class UserMessageParam(_ParamBase):
    role: Literal["user"] = "user"
    content: Union[str, List[ChatCompletionContentPart]]
    name: Optional[str] = None


class AssistantMessageParam(_ParamBase):
    role: Literal["assistant"] = "assistant"
    content: Optional[str] = None
    name: Optional[str] = None
    tool_calls: Optional[List[ToolCall]] = None
    function_call: Optional[FunctionCall] = None


class ToolMessageParam(_ParamBase):
    role: Literal["tool"] = "tool"
    content: str
    tool_call_id: str


class FunctionMessageParam(_ParamBase):
    role: Literal["function"] = "function"
    content: str
    name: str


ChatCompletionMessageParam = Union[
    SystemMessageParam,
    UserMessageParam,
    AssistantMessageParam,
    ToolMessageParam,
    FunctionMessageParam,
]


# --------------------------------------------------------------------------- #
# Chat completions — response
# --------------------------------------------------------------------------- #


class ChatCompletionMessage(BaseModel):
    role: Literal["assistant"] = "assistant"
    content: Optional[str] = None
    refusal: Optional[str] = None
    function_call: Optional[FunctionCall] = None
    tool_calls: Optional[List[ToolCall]] = None


class ChatCompletionChoice(BaseModel):
    index: int
    message: ChatCompletionMessage
    finish_reason: Optional[str] = None
    logprobs: Optional[Any] = None


class ChatCompletion(BaseModel):
    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    system_fingerprint: Optional[str] = None
    choices: List[ChatCompletionChoice]
    usage: Optional[Usage] = None
    service_tier: Optional[str] = None


class ChatCompletionChunkDelta(BaseModel):
    role: Optional[str] = None
    content: Optional[str] = None
    refusal: Optional[str] = None
    function_call: Optional[FunctionCall] = None
    tool_calls: Optional[List[ToolCallDelta]] = None


class ChatCompletionChunkChoice(BaseModel):
    index: int
    delta: ChatCompletionChunkDelta
    finish_reason: Optional[str] = None
    logprobs: Optional[Any] = None


class ChatCompletionChunk(BaseModel):
    id: str
    object: Literal["chat.completion.chunk"] = "chat.completion.chunk"
    created: int
    model: str
    system_fingerprint: Optional[str] = None
    choices: List[ChatCompletionChunkChoice]
    usage: Optional[Usage] = None
    service_tier: Optional[str] = None


# --------------------------------------------------------------------------- #
# Legacy completions
# --------------------------------------------------------------------------- #


class CompletionChoice(BaseModel):
    text: str
    index: int
    finish_reason: Optional[str] = None
    logprobs: Optional[Any] = None


class Completion(BaseModel):
    id: str
    object: Literal["text_completion"] = "text_completion"
    created: int
    model: str
    choices: List[CompletionChoice]
    usage: Optional[Usage] = None
    system_fingerprint: Optional[str] = None


# --------------------------------------------------------------------------- #
# Embeddings
# --------------------------------------------------------------------------- #


class Embedding(BaseModel):
    object: Literal["embedding"] = "embedding"
    index: int
    embedding: List[float]


class CreateEmbeddingResponse(BaseModel):
    object: Literal["list"] = "list"
    data: List[Embedding]
    model: str
    usage: Usage


# --------------------------------------------------------------------------- #
# Moderations
# --------------------------------------------------------------------------- #


class ModerationCategories(BaseModel):
    hate: Optional[bool] = None
    hate_threatening: Optional[bool] = None
    self_harm: Optional[bool] = None
    sexual: Optional[bool] = None
    sexual_minors: Optional[bool] = None
    violence: Optional[bool] = None
    violence_graphic: Optional[bool] = None


class ModerationResult(BaseModel):
    id: str
    model: str
    flagged: bool
    categories: ModerationCategories
    category_scores: Dict[str, float]


class CreateModerationResponse(BaseModel):
    id: str
    model: str
    results: List[ModerationResult]


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #


class Model(BaseModel):
    id: str
    object: Literal["model"] = "model"
    created: int
    owned_by: str
    permission: Optional[List[Any]] = None
    root: Optional[str] = None
    parent: Optional[str] = None


class ModelListResponse(BaseModel):
    object: Literal["list"] = "list"
    data: List[Model]


# --------------------------------------------------------------------------- #
# Cost / budget event payloads (type safety for callbacks & events)
# --------------------------------------------------------------------------- #


class UsageEvent(BaseModel):
    cost: float
    cumulative_cost: float
    currency: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    user: Optional[str] = None
    cost_center: Optional[str] = None
    request_id: Optional[str] = None


class BudgetEvent(BaseModel):
    cumulative_cost: float
    limit: float
    currency: str
    user: Optional[str] = None
    cost_center: Optional[str] = None


# --------------------------------------------------------------------------- #
# Request-param shapes (type hints / optional validation)
# --------------------------------------------------------------------------- #


class ResponseFormat(BaseModel):
    type: str
    json_schema: Optional[Dict[str, Any]] = None


class ChatCompletionCreateParams(_ParamBase):
    model: str
    messages: List[ChatCompletionMessageParam]
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = None
    stream: Optional[bool] = None
    stream_options: Optional[Dict[str, Any]] = None
    max_tokens: Optional[int] = None
    max_completion_tokens: Optional[int] = None
    stop: Optional[Union[str, List[str]]] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None
    logit_bias: Optional[Dict[str, int]] = None
    user: Optional[str] = None
    response_format: Optional[ResponseFormat] = None
    seed: Optional[int] = None
    tools: Optional[List[ToolDefinition]] = None
    tool_choice: Optional[Any] = None
    parallel_tool_calls: Optional[bool] = None
    logprobs: Optional[bool] = None
    top_logprobs: Optional[int] = None
    reasoning_effort: Optional[str] = None
    service_tier: Optional[str] = None


class EmbeddingCreateParams(_ParamBase):
    model: str
    input: Any
    encoding_format: Optional[str] = None
    dimensions: Optional[int] = None
    user: Optional[str] = None


class ModerationCreateParams(_ParamBase):
    model: Optional[str] = None
    input: Union[str, List[str]]


class CompletionCreateParams(_ParamBase):
    model: str
    prompt: Optional[Any] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = None
    stream: Optional[bool] = None
    max_tokens: Optional[int] = None
    stop: Optional[Union[str, List[str]]] = None
    user: Optional[str] = None


# --------------------------------------------------------------------------- #
# Budget config (TypedDict — all keys optional)
# --------------------------------------------------------------------------- #


class BudgetConfig(TypedDict, total=False):
    softLimit: float
    hardLimit: float
    warnAtFraction: float


# forward refs
Usage.model_rebuild()
PromptTokensDetails.model_rebuild()
CompletionTokensDetails.model_rebuild()
