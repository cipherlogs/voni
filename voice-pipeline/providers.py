"""Provider contracts for the cascade voice pipeline (P0).

One pipeline core, two transports (browser WS @ 24 kHz PCM, Telnyx WS @ 8 kHz
mu-law). Every vendor backend — AssemblyAI or Deepgram for STT, gateway
models for LLM, Cartesia for TTS — implements these interfaces. P1 wires real
backends; P0 proves the contracts are drivable (see test_providers.py).

Design rules carried over from the bridge:
- No network round trip is ever awaited in an audio-forwarding path. STT audio
  goes one way; LLM prefetch is background with cancellation; TTS streams
  sentence chunks so playout starts while the LLM still generates.
- Reads may prefetch, writes never do (see turns.py commit gate).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class PartialTranscript:
    """Cumulative running text for the current turn. Render latest, never concat."""

    text: str


@dataclass(frozen=True)
class FinalTranscript:
    """End-of-turn text. The only input the LLM may act on."""

    text: str
    turn_duration_ms: int = 0


@dataclass(frozen=True)
class TokenDelta:
    """One streaming LLM output fragment. Accumulate for TTS sentence split."""

    text: str


@dataclass(frozen=True)
class ToolCallRequest:
    """LLM-requested function call (cascade equivalent of AssemblyAI tool.call)."""

    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    call_id: str = ""


@dataclass(frozen=True)
class SentenceAudio:
    """One sentence of synthesized speech, playable the moment it arrives."""

    pcm: bytes
    sample_rate: int
    text: str = ""


class PrefetchHandle(ABC):
    """Background speculative work. Cancel on turn divergence."""

    @abstractmethod
    def cancel(self) -> None:
        """Idempotent. Never raises, never blocks."""


class StreamingSTT(ABC):
    """Streaming speech-to-text. AssemblyAI default, Deepgram optional (P3)."""

    @abstractmethod
    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        """Open a recognition session. Empty language_codes = auto-detect."""

    @abstractmethod
    async def send_audio(self, pcm: bytes) -> None:
        """Forward one mic frame. Fire-and-forget; never await a reply here."""

    @abstractmethod
    async def events(self) -> AsyncIterator[PartialTranscript | FinalTranscript]:
        """Yield partials then the final. Exactly one final per turn."""

    @abstractmethod
    async def close(self) -> None:
        """End the session. Idempotent."""


class LLMStream(ABC):
    """Token-streaming LLM behind the gateway key. Never in the audio path."""

    @abstractmethod
    async def complete(
        self, *, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        """Stream the reply for committed messages. Tokens first, tool calls inline."""

    @abstractmethod
    def prefetch(self, *, messages: list[dict[str, Any]]) -> PrefetchHandle:
        """Start speculative background work on UNCOMMITTED partials.

        Synchronous start (no await) so the audio path never blocks; the
        handle cancels when the turn diverges. Read-only work only.
        """


class StreamingTTS(ABC):
    """Sentence-chunked speech synthesis (Cartesia in P1)."""

    @abstractmethod
    async def speak(self, text: str) -> AsyncIterator[SentenceAudio]:
        """Yield one chunk per sentence, in order. First chunk starts playout
        while the LLM is still generating the rest of the reply."""
