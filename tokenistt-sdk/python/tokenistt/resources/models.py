"""Models resource (sync + async)."""
from __future__ import annotations

from typing import Any, Dict, Optional

from ..core.base_client import AsyncBaseClient, BaseClient
from ..types import Model, ModelListResponse


class Models:
    def __init__(self, client: BaseClient):
        self._client = client

    def list(
        self,
        *,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> ModelListResponse:
        response = self._client._request(
            "GET",
            "/models",
            extra_headers=extra_headers,
            extra_query=extra_query,
            timeout=timeout,
            max_retries=max_retries,
        )
        return ModelListResponse.model_validate(response.json())

    def retrieve(
        self,
        model: str,
        *,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Model:
        response = self._client._request(
            "GET",
            f"/models/{model}",
            extra_headers=extra_headers,
            extra_query=extra_query,
            timeout=timeout,
            max_retries=max_retries,
        )
        return Model.model_validate(response.json())

    def delete(
        self,
        model: str,
        *,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        response = self._client._request(
            "DELETE",
            f"/models/{model}",
            extra_headers=extra_headers,
            extra_query=extra_query,
            timeout=timeout,
            max_retries=max_retries,
        )
        return response.json()


class AsyncModels:
    def __init__(self, client: AsyncBaseClient):
        self._client = client

    async def list(
        self,
        *,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> ModelListResponse:
        response = await self._client._arequest(
            "GET",
            "/models",
            extra_headers=extra_headers,
            extra_query=extra_query,
            timeout=timeout,
            max_retries=max_retries,
        )
        return ModelListResponse.model_validate(response.json())

    async def retrieve(
        self,
        model: str,
        *,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Model:
        response = await self._client._arequest(
            "GET",
            f"/models/{model}",
            extra_headers=extra_headers,
            extra_query=extra_query,
            timeout=timeout,
            max_retries=max_retries,
        )
        return Model.model_validate(response.json())

    async def delete(
        self,
        model: str,
        *,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        response = await self._client._arequest(
            "DELETE",
            f"/models/{model}",
            extra_headers=extra_headers,
            extra_query=extra_query,
            timeout=timeout,
            max_retries=max_retries,
        )
        return response.json()
