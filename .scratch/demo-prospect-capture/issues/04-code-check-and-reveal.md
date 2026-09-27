# 04: Code check and reveal

**Goal:** Voni replies to my email live, I read back the code from the reply, and then Voni reveals it was an OTP. The whole thing makes me go "wait, that was a security check?"

**What to build:** Once the caller's email is matched (from 03), Voni sends a reply from the test inbox and narrates truthfully while it happens: "writing it… sending… just sent." It never says "sent" before the send succeeds. The reply contains:

- the visitor's name (asked for lightly if the address doesn't reveal it)
- a 4-digit code framed as a fun test ("a code to test things out, tell me what it says")
- a short warm line Voni writes itself

The reply is in the picked language, and nothing in it looks like a security email. The visitor reads the code back, with two tries. A correct code gives the **verified extension** (talk clock to 7 min) and triggers the reveal:

- "That was actually an OTP, a security check. Didn't feel like one, right?"
- Voni explains the whole call was a fun way to learn their name, verified email, and business without a single form, and that there are more creative ways to do this with *their* customers.
- It asks "How efficient did that feel to you?" and lets them react.

Two wrong tries means Voni moves on without the extension, politely.

**Blocked by:** 03 (Work-email claim and gate).

**Status:** ready-for-human (built; the owner's real call with a work address pending)

## Manual test (approve / reject)

1. Complete the 03 flow with a work address. → Voni says it's writing, then sending, then "just sent," and asks you to read the code.
2. Check your inbox. → The reply arrived within seconds, has your name, a 4-digit code, and a friendly line. It doesn't look like a security email.
3. Read the code wrong once, then right. → Voni lets you retry once, then accepts. The clock extends to 7 minutes.
4. Listen to the reveal. → Voni says it was an OTP, explains the whole call captured your details without a form, and asks how efficient it felt.
5. New call: read the code wrong twice. → Voni moves on gracefully, with no extension and no reveal of a verified state.
6. Repeat with another language selected. → The reply email is in that language.

## Acceptance criteria

- [ ] The reply is sent from the test inbox, threaded to the visitor's email, with name + 4-digit code + warm line, in the picked language.
- [ ] Narration follows the real send state (no early "sent").
- [ ] Code verified server-side, two tries, and each code is single-use for its call.
- [ ] Correct code → verified extension (7 min) → reveal beat as specified.
- [ ] Tests for code generation, verification, attempt limits, and the extension.

## Answer

- **Owner decisions (2026-09-27):**
  - The verified extension is 9 min (the spec amendment wins over this ticket's "7 min").
  - The email is a fixed template per language plus one warm line from Voni.
  - Every call sends its own reply and code, so a callback does the check again.
  - Voni's lines are shortened only before the email lands.
- **Pure core** (`voni/src/lib/demo/code-check.ts`):
  - The code is 4 digits (1000–9999), an HMAC of the call id with the server key, never stored. A rejoin of the same call keeps it.
  - `codeOutcome`: two tries, single-use. A garbled read-back costs no try.
  - `replyEmail`: RFC 2822, threaded (In-Reply-To/References), in 6 languages. The name and the warm line can't inject headers. The warm line is capped at 300 characters.
- **Server:**
  - `demo_calls` (migration 0013, applied to the dev DB directly) holds the call's language, recorded at token mint, and the reply and code state.
  - `send_code_reply` and `check_code` are dispatched by `/api/demo/tools/[name]` to `reply.ts`. The Gmail send lives in `inbox.ts`.
  - One reply per call, via a claim on `reply_started_at`. Only a failed send frees the claim. Gmail calls time out at 15s, under the 60s stale window.
- **Narration:** Voni says "writing it… sending…" as it calls `send_code_reply`. "Just sent" comes only in the result, after Gmail returns an id.
- **Reveal:** the `check_code` result carries the reveal lines on a pass. Two misses: Voni moves on, never says the code, and never says they're verified.
- **Client:** `voice-call.tsx` sets `verified` on "correct" or "used" (a pass whose first result was lost), so the talk limit becomes 540s.
- **Brevity (base stretch):** a DEMO_RULES line, "until their test email lands, one short sentence, two at most", plus shorter invite, gate and not-arrived lines. The ladder rungs and the hold return were left as they were, since they also fire after the email lands.
- **Verified:**
  - `npm test` 750/750; tsc and eslint clean. Mutation checks on the attempt and single-use logic.
  - A real dev-DB run of the check path:
    - not_sent before the reply
    - unclear costs nothing
    - wrong → right passes, then "used"
    - wrong, wrong → out_of_tries even with the right code
    - a rejoin keeps its first language
- **Not verified live:** the actual Gmail send (not run, to avoid mailing a real address). e2e was skipped on request; the full e2e pass comes after all tickets.
- **Not in this ticket:** the late-email "reply still goes out after the call" (spec Clock section). The talk clock stays client-enforced, the same as the 6-min extension.
