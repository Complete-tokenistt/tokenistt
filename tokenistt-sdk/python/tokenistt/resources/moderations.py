"""Moderations resource (sync + async)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from ..core.base_client import AsyncBaseClient, BaseClient
from ..types import CreateModerationResponse, ModerationCreateParams


class Moderations:
    def __init__(self, client: BaseClient):
        self._client = client

    def create(
        self,
        *,
        input: Union[str, List[str]],
        model: Optional[str] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> CreateModerationResponse:
        body: Dict[str, Any] = {"input": input, **kwargs}
        if model is not None:
            body["model"] = model
        if extra_body:
            body.update(extra_body)
        response = self._client._request(
            "POST",
            "/moderations",
            json=body,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
            extra_query=extra_query,
        )
        return CreateModerationResponse.model_validate(response.json())


class AsyncModerations:
    def __init__(self, client: AsyncBaseClient):
        self._client = client

    async def create(
        self,
        *,
        input: Union[str, List[str]],
        model: Optional[str] = None,
        user: Optional[str] = None,
        cost_center: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        extra_query: Optional[Dict[str, Any]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        **kwargs: Any,
    ) -> CreateModerationResponse:
        body: Dict[str, Any] = {"input": input, **kwargs}
        if model is not None:
            body["model"] = model
        if extra_body:
            body.update(extra_body)
        response = await self._client._arequest(
            "POST",
            "/moderations",
            json=body,
            user=user,
            cost_center=cost_center,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
            extra_query=extra_query,
        )
        return CreateModerationResponse.model_validate(response.json())
