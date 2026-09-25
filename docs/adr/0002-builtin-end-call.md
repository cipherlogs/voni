# Built-in end_call instead of opt-in call control

Agents could never end a call themselves — every session ended by human hang-up or timeout. The user asked for agent-initiated hang-up as a built-in capability ("we should have implemented those tools from the start").

## Considered Options

- **Opt-in per-agent tool in the picker**: rejected — call control is safety infrastructure, not a feature choice. An agent without it cannot close consent-denied or looping calls, and a picker default nobody finds is the same as not shipping it.
- **Built-in `end_call`, always compiled (chosen)**: every agent gets it like `transfer_to_human`. Hold-mode: the agent speaks `closing_line` first, then each path drains playback (browser waits for the worklet to settle, PSTN waits out the unplayed tail, cascade drains) before tearing down. The execution layer refuses it while another tool is still running; post-call work queues as durable jobs. A caller talking over the goodbye disarms it everywhere.
- **Immediate server-side hangup on tool result**: rejected — it cuts the closing line mid-word on every path and reads as a glitch, not a human goodbye.
