"""Native level: the cascade has no gain stage (W1 ticket 127).

Spec: `.scratch/meta-cascade/spec.md`, M4 "W1 re-point" — the cascade carries
no ``output.volume``, no client gain and no limiter. Each voice's native level
is its target, so a delivered level difference is a pipeline or client defect,
not a tuning knob. The managed path keeps ``output.volume`` until it retires.

This module is the one place the rule is written down, so every gate that
touches a level reads the same vocabulary:

- :data:`NATIVE_GAIN_STAGE` is the only stage a cascade render may declare;
  :func:`assert_native_stage` refuses any other stage *by name*, so a clip or
  render record that says ``normalised`` cannot pass as native.
- :data:`MANAGED_LEVEL_FIELD` names the managed path's level (the stored body's
  ``output.volume``). It is managed-only: the cascade's body adapter ignores it
  and records it, and :func:`assert_no_level_stage` refuses it (and every other
  level knob) on a cascade request before a vendor socket opens.
- :func:`level_stage_keys` names the level-stage keys present in a mapping, so
  a caller can report every one rather than the first.

A level change is a new native render or a new voice decision. There is no
client stage to reach for: this module deliberately exposes no function that
applies a gain, because the absence of that function is the contract.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: The one stage a cascade render may declare. Native means the synthesis bytes
#: were written verbatim: no gain, limiter, normalisation or ``output.volume``.
NATIVE_GAIN_STAGE = "none"

#: Every stage a cascade render is allowed to declare. Kept as a tuple so a
#: test can pin the list and a second stage is a visible change.
CASCADE_GAIN_STAGES: tuple[str, ...] = (NATIVE_GAIN_STAGE,)

#: The managed path's level, on the stored agent body. Managed-only: the
#: cascade ignores it (see ``cascade.body_map.IGNORE_SET``) and never reads it
#: into a setting.
MANAGED_LEVEL_FIELD = "output.volume"

#: Keys that express a level stage if they appear on a cascade request or
#: output mapping. Covers the vendor's usual spellings so a smuggled knob is
#: named rather than dropped silently.
LEVEL_STAGE_KEYS: tuple[str, ...] = (
    "volume",
    "output_volume",
    "gain",
    "gain_db",
    "makeup_gain",
    "limiter",
    "limiter_db",
    "normalisation",
    "normalization",
    "normalise",
    "normalize",
    "loudness",
    "agc",
)


class LevelStageError(RuntimeError):
    """A level stage tried to enter the cascade, and is named.

    ``where`` is the gate that refused (a clip record, a synthesis request);
    ``stage`` is the stage or the level-stage keys that were found.
    """

    def __init__(self, where: str, stage: str) -> None:
        self.where = where
        self.stage = stage
        super().__init__(
            f'{where} carries a level stage "{stage}": the cascade has no '
            "output.volume, no gain, no limiter and no normalisation; a level "
            "change is a new native render or a new voice decision, never a "
            "gain stage"
        )


def assert_native_stage(stage: str, *, where: str = "render") -> str:
    """Return ``stage`` when it is native; refuse any other stage by name."""
    if stage != NATIVE_GAIN_STAGE:
        raise LevelStageError(where, stage)
    return stage


def level_stage_keys(parameters: Mapping[str, Any]) -> tuple[str, ...]:
    """Every level-stage key ``parameters`` carries, sorted and named."""
    if not isinstance(parameters, Mapping):
        raise TypeError(
            f"a request or output mapping must be a mapping, got {type(parameters).__name__}"
        )
    return tuple(sorted(key for key in parameters if key in LEVEL_STAGE_KEYS))


def assert_no_level_stage(parameters: Mapping[str, Any], *, where: str) -> None:
    """Refuse a request/output mapping carrying any level-stage key, by name.

    Every key is named, not just the first, so a caller fixing a configuration
    sees the whole set rather than discovering them one run at a time.
    """
    names = level_stage_keys(parameters)
    if names:
        raise LevelStageError(where, ", ".join(names))
