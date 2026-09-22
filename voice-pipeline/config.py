"""Pipeline configuration for the cascade voice service (P0).

One schema for both transports (browser WS @ 24 kHz PCM, Telnyx WS @ 8 kHz
mu-law), delivered per call — the browser passes the agent id like
bridge_config.py does today; P1 wires the fetch.

Safety invariant: `fallback_mode` defaults to "managed". A call routes at the
cascade pipeline only on explicit `"cascade"` — the managed path stays live
until the new pipeline beats it on the scoreboard two rounds running.

Secrets policy: this schema holds key *names* and non-secret tuning only.
Key material lives in host env / secret stores, never in configs or logs.
"""

from __future__ import annotations

from dataclasses import dataclass

STT_PROVIDERS = ("assemblyai", "deepgram")
TRANSPORTS = ("browser", "telnyx")
FALLBACK_MODES = ("managed", "cascade")


@dataclass(frozen=True)
class PipelineConfig:
    stt_provider: str = "assemblyai"
    stt_model: str = ""
    llm_model: str = ""
    tts_voice: str = ""
    tts_model: str = ""
    transport: str = "browser"
    language_codes: tuple[str, ...] = ("en",)
    min_silence_ms: int = 900
    max_silence_ms: int = 1200
    interruption_delay_ms: int = 350
    fallback_mode: str = "managed"

    def __post_init__(self) -> None:
        errors = validate_pipeline_config(self)
        if errors:
            raise ValueError("; ".join(errors))

    @property
    def routes_to_cascade(self) -> bool:
        return self.fallback_mode == "cascade"


def validate_pipeline_config(config: PipelineConfig) -> list[str]:
    """Return human-readable errors; empty means valid."""
    errors: list[str] = []
    if config.stt_provider not in STT_PROVIDERS:
        errors.append(
            f"unknown stt_provider {config.stt_provider!r} "
            f"(expected one of {', '.join(STT_PROVIDERS)})"
        )
    if config.transport not in TRANSPORTS:
        errors.append(
            f"unknown transport {config.transport!r} "
            f"(expected one of {', '.join(TRANSPORTS)})"
        )
    if config.fallback_mode not in FALLBACK_MODES:
        errors.append(
            f"unknown fallback_mode {config.fallback_mode!r} "
            f"(expected one of {', '.join(FALLBACK_MODES)})"
        )
    if config.min_silence_ms < 0 or config.max_silence_ms < 0:
        errors.append("silence windows must be non-negative")
    elif config.min_silence_ms > config.max_silence_ms:
        errors.append(
            f"min_silence_ms ({config.min_silence_ms}) exceeds "
            f"max_silence_ms ({config.max_silence_ms})"
        )
    if config.interruption_delay_ms < 0:
        errors.append("interruption_delay_ms must be non-negative")
    if not config.llm_model:
        errors.append("llm_model is required")
    if config.fallback_mode == "cascade" and not config.tts_model:
        errors.append("tts_model is required to route at the cascade pipeline")
    return errors


def pipeline_config_from_dict(data: dict) -> PipelineConfig:
    """Build from a plain dict (settings page payload, per-call fetch)."""
    allowed = {
        "stt_provider",
        "stt_model",
        "llm_model",
        "tts_voice",
        "tts_model",
        "transport",
        "language_codes",
        "min_silence_ms",
        "max_silence_ms",
        "interruption_delay_ms",
        "fallback_mode",
    }
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ValueError(f"unknown pipeline keys: {', '.join(unknown)}")
    kwargs = dict(data)
    if "language_codes" in kwargs:
        kwargs["language_codes"] = tuple(kwargs["language_codes"])
    return PipelineConfig(**kwargs)
