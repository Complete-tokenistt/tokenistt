"""Synchronous ``tokenistt.OpenAI`` client."""
from __future__ import annotations

from typing import Any

from .core.base_client import BaseClient
from .resources.chat import Chat
from .resources.completions import Completions
from .resources.embeddings import Embeddings
from .resources.models import Models
from .resources.moderations import Moderations


class OpenAI(BaseClient):
    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.chat = Chat(self)
        self.embeddings = Embeddings(self)
        self.models = Models(self)
        self.moderations = Moderations(self)
        self.completions = Completions(self)
