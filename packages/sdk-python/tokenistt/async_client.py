"""Asynchronous ``tokenistt.AsyncOpenAI`` client."""
from __future__ import annotations

from typing import Any

from .core.base_client import AsyncBaseClient
from .resources.chat import AsyncChat
from .resources.completions import AsyncCompletions
from .resources.embeddings import AsyncEmbeddings
from .resources.models import AsyncModels
from .resources.moderations import AsyncModerations


class AsyncOpenAI(AsyncBaseClient):
    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.chat = AsyncChat(self)
        self.embeddings = AsyncEmbeddings(self)
        self.models = AsyncModels(self)
        self.moderations = AsyncModerations(self)
        self.completions = AsyncCompletions(self)
