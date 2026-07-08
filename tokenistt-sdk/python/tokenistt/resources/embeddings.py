"""Embeddings resource (sync + async)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from ..core.base_client import AsyncBaseClient, BaseClient
from ..types import CreateEmbeddingResponse, EmbeddingCreateParams


class Embeddings:
    def __init__(self, client: BaseClient):
        self._client = client

    def create(
        self,
        *,
        model: str,
        input: Any,
        encoding_format: Optional[str] = None,
        dimensions: Optional[int] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> CreateEmbeddingResponse:
        body: Dict[str, Any] = {"model": model, "input": input, **kwargs}
        if encoding_format is not None:
            body["encoding_format"] = encoding_format
        if dimensions is not None:
            body["dimensions"] = dimensions
        if extra_body:
            body.update(extra_body)
        response = self._client._request(
            "POST",
            "/embeddings",
            json=body,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
            extra_query=extra_query,
        )
        obj = CreateEmbeddingResponse.model_validate(response.json())
        if obj.usage is not None:
            self._client._record_usage(
                obj.usage,
                model=model,
                user=user or self._client.user,
                cost_center=cost_center or self._client.cost_center,
                request_id=response.headers.get("x-request-id"),
            )
        return obj


class AsyncEmbeddings:
    def __init__(self, client: AsyncBaseClient):
        self._client = client

    async def create(
        self,
        *,
        model: str,
        input: Any,
        encoding_format: Optional[str] = None,
        dimensions: Optional[int] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> CreateEmbeddingResponse:
        body: Dict[str, Any] = {"model": model, "input": input, **kwargs}
        if encoding_format is not None:
            body["encoding_format"] = encoding_format
        if dimensions is not None:
            body["dimensions"] = dimensions
        if extra_body:
            body.update(extra_body)
        response = await self._client._arequest(
            "POST",
            "/embeddings",
            json=body,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
            extra_query=extra_query,
        )
        obj = CreateEmbeddingResponse.model_validate(response.json())
        if obj.usage is not None:
            self._client._record_usage(
                obj.usage,
                model=model,
                user=user or self._client.user,
                cost_center=cost_center or self._client.cost_center,
                request_id=response.headers.get("x-request-id"),
            )
        return obj
