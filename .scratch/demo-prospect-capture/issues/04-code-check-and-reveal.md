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

**Status:** ready-for-agent

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
