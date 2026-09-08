#!/usr/bin/env python
"""Turn a Voice Agent session id into the numbers that explain a bad call.

    ./pull_session.py sess_251aada7f29346abb6908c682839c70f [--audio]

Every session is retained server-side with three artifacts: the stereo
recording (left=caller, right=agent), a turn-by-turn `timeline`, and
`metadata`. The timeline is the useful one — each turn carries
`time_to_first_audio_ms`, which is the wait between the caller finishing and
the agent's first *word*.

That matters because the agent streams its thinking time to us as real-time
silence inside `reply.audio`, and the bridge forwards it. So a reply that is
"19.31s of audio" is 15.4s of dead air followed by 3.6s of speech, and the
caller experiences the whole thing as the agent going quiet on them.

`--audio` additionally downloads the recording and checks the agent channel
for dropouts, to separate "the agent generated bad audio" from "the audio was
fine and something downstream of AssemblyAI broke it".
"""

import json
import os
import sys
import urllib.request

API = "https://agents.assemblyai.com/v1/sessions"


def get(url: str, key: str | None = None) -> bytes:
    req = urllib.request.Request(url)
    if key:
        # A raw API key, not prefixed with "Bearer" — prefixing it is a 401.
        req.add_header("Authorization", key)
    with urllib.request.urlopen(req) as r:
        return r.read()


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    want_audio = "--audio" in sys.argv
    if not args:
        print(__doc__)
        return 2
    session_id = args[0]

    key = os.environ.get("ASSEMBLYAI_API_KEY")
    if not key:
        print("ASSEMBLYAI_API_KEY is not set (it lives in voni/.dev.vars)")
        return 2

    session = json.loads(get(f"{API}/{session_id}", key))
    cfg = session.get("config") or {}
    inp = cfg.get("input") or {}
    print(f"session {session_id}  status={session.get('status')} "
          f"duration={session.get('duration_seconds', 0):.1f}s")
    print(f"  voice={(cfg.get('output') or {}).get('voice')} "
          f"transcription_mode={inp.get('transcription_mode')} "
          f"turn_detection={inp.get('turn_detection')}")

    urls = {a["type"]: a["url"] for a in session.get("artifacts", [])}
    timeline = json.loads(get(urls["timeline"]))

    print(f"\n{'agent said':<44} {'dead air':>9} {'speech':>7} {'total':>7}")
    dead, spoken = 0.0, 0.0
    for turn in timeline["turns"]:
        start = turn.get("agent_reply_started_at_ms")
        end = turn.get("agent_reply_ended_at_ms")
        ttfa = turn.get("time_to_first_audio_ms")
        if not (start and end and ttfa is not None):
            continue
        speech = (end - start) / 1000
        total = ttfa / 1000 + speech
        dead += ttfa / 1000
        spoken += speech
        flag = "  <-- " + "#" * min(30, int(ttfa / 500)) if ttfa > 1000 else ""
        text = (turn.get("agent_text") or "").strip()
        print(f"{text[:43]:<44} {ttfa:>8}ms {speech:>6.2f}s {total:>6.2f}s{flag}")

    if dead + spoken:
        print(f"\ndead air {dead:.1f}s vs speech {spoken:.1f}s — the caller spent "
              f"{dead / (dead + spoken) * 100:.0f}% of the agent's airtime on silence")

    if want_audio:
        check_audio(urls["audio"])
    return 0


def check_audio(url: str) -> None:
    """Look for dropouts inside the agent's own generated speech.

    Note the limit: this is what AssemblyAI produced, not what the caller
    heard. If this comes back clean but the call still sounded broken, the
    damage is downstream — this bridge, Telnyx, or the PSTN leg.
    """
    import subprocess
    import tempfile

    try:
        import numpy as np
    except ImportError:
        print("\n--audio needs numpy")
        return

    with tempfile.TemporaryDirectory() as tmp:
        ogg, raw = f"{tmp}/a.ogg", f"{tmp}/agent.raw"
        with open(ogg, "wb") as f:
            f.write(get(url))
        # `pan` rather than the old -map_channel (removed from ffmpeg) or
        # channelsplit (which errors unless every split output is consumed).
        # c0=c1 keeps the right channel only, which is the agent.
        try:
            done = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", ogg, "-af", "pan=mono|c0=c1",
                 "-ar", "8000", "-f", "s16le", raw, "-y"],
                capture_output=True, text=True,
            )
        except FileNotFoundError:
            print("\n--audio needs ffmpeg on PATH")
            return
        if done.returncode != 0:
            print(f"\nffmpeg failed: {done.stderr.strip()[:200]}")
            return
        x = np.fromfile(raw, dtype=np.int16).astype(np.float32) / 32768

    win = 160  # 20 ms at 8 kHz
    n = len(x) // win * win
    rms = np.sqrt((x[:n].reshape(-1, win) ** 2).mean(1))
    loud = rms > 0.002

    edges = np.diff(loud.astype(int))
    starts = np.r_[0, np.where(edges == 1)[0] + 1] if loud[0] else np.where(edges == 1)[0] + 1
    ends = np.r_[np.where(edges == -1)[0] + 1, len(loud)] if loud[-1] else np.where(edges == -1)[0] + 1

    gaps = 0
    for s, e in zip(starts, ends):
        if (e - s) * 0.02 < 0.3:
            continue
        seg = rms[s:e] < 0.002
        d = np.diff(seg.astype(int))
        for a, b in zip(np.where(d == 1)[0] + 1, np.where(d == -1)[0] + 1):
            if 0.04 <= (b - a) * 0.02 <= 0.5:
                print(f"  dropout at {(s + a) * 0.02:.2f}s ({(b - a) * 20:.0f}ms)")
                gaps += 1
    print(f"\nagent channel: {loud.sum() * 0.02:.1f}s of speech, {gaps} intra-word dropouts"
          f"{' — generated audio is clean, look downstream' if not gaps else ''}")


if __name__ == "__main__":
    raise SystemExit(main())
