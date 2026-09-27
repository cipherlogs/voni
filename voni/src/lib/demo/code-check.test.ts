import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CODE_TRIES,
  codeOutcome,
  replyCode,
  replyEmail,
  spokenCode,
  type CodeCall,
} from "./code-check";
import { EMAIL_TEST_START, PROVISIONAL_TALK_S, VERIFIED_TALK_S, emailTestAfterCode, talkLimitS } from "./email-test";

test("each call gets its own stable 4-digit code", () => {
  const a = replyCode("key", "call-a");
  assert.match(a, /^[1-9]\d{3}$/, "four digits, no leading zero to trip over aloud");
  assert.equal(replyCode("key", "call-a"), a, "a rejoin of the same call keeps its code");
  const codes = new Set(Array.from({ length: 50 }, (_, i) => replyCode("key", `call-${i}`)));
  assert.ok(codes.size > 40, "codes differ between calls");
  assert.notEqual(replyCode("other-key", "call-a"), a, "the code needs the server key");
});

test("a read-back code is its four digits, however the model wrote them", () => {
  assert.equal(spokenCode("4821"), "4821");
  assert.equal(spokenCode("4 8 2 1"), "4821");
  assert.equal(spokenCode("48-21"), "4821");
  assert.equal(spokenCode("482"), null);
  assert.equal(spokenCode("48215"), null);
  assert.equal(spokenCode("four eight"), null);
});

const sent: CodeCall = { replyMessageId: "m1", codeAttempts: 0, codeVerifiedAt: null };

test("the right code passes on the first or second try", () => {
  assert.deepEqual(codeOutcome(sent, "4821", "4821"), { status: "correct", triesLeft: 1 });
  const once = { ...sent, codeAttempts: 1 };
  assert.deepEqual(codeOutcome(once, "4821", "4821"), { status: "correct", triesLeft: 0 });
});

test("two wrong tries and the code is spent", () => {
  assert.equal(MAX_CODE_TRIES, 2);
  assert.deepEqual(codeOutcome(sent, "1111", "4821"), { status: "wrong", triesLeft: 1 });
  const once = { ...sent, codeAttempts: 1 };
  assert.deepEqual(codeOutcome(once, "1111", "4821"), { status: "wrong", triesLeft: 0 });
  const spent = { ...sent, codeAttempts: 2 };
  assert.deepEqual(codeOutcome(spent, "4821", "4821"), { status: "out_of_tries", triesLeft: 0 }, "even the right code, after two misses");
});

test("a code is single-use, and there is none before the reply is sent", () => {
  const used = { ...sent, codeAttempts: 1, codeVerifiedAt: new Date() };
  assert.equal(codeOutcome(used, "4821", "4821").status, "used");
  assert.equal(codeOutcome(null, "4821", "4821").status, "not_sent");
  assert.equal(codeOutcome({ ...sent, replyMessageId: null }, "4821", "4821").status, "not_sent");
});

test("a garbled read-back doesn't cost a try", () => {
  assert.deepEqual(codeOutcome(sent, null, "4821"), { status: "unclear", triesLeft: 2 });
});

test("a passed code check is the verified extension (9 min)", () => {
  const found = { ...EMAIL_TEST_START, invited: true, found: true };
  assert.equal(talkLimitS(found), PROVISIONAL_TALK_S);
  assert.equal(VERIFIED_TALK_S, 540);
  assert.equal(talkLimitS(emailTestAfterCode(found, "correct")), VERIFIED_TALK_S);
  assert.equal(talkLimitS(emailTestAfterCode(found, "used")), VERIFIED_TALK_S, "a pass whose first result was lost");
  for (const status of ["wrong", "out_of_tries", "unclear", "not_sent"] as const) {
    assert.equal(talkLimitS(emailTestAfterCode(found, status)), PROVISIONAL_TALK_S, status);
  }
  assert.equal(talkLimitS(emailTestAfterCode(EMAIL_TEST_START, "correct")), talkLimitS(EMAIL_TEST_START), "no email, no verified extension");
});

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const bodyOf = (mime: string) => Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString("utf8");

test("the reply is a threaded plain email with the name, the code and Voni's line", () => {
  const mime = decode(
    replyEmail({
      language: "en",
      to: "andres@acme-realty.com",
      subject: "Lime 42",
      messageIdHeader: "<abc@mail.acme-realty.com>",
      name: "Andres",
      code: "4821",
      warmLine: "Loved hearing about your listings!",
    }),
  );
  assert.match(mime, /^To: andres@acme-realty\.com\r$/m);
  assert.match(mime, /^Subject: Re: Lime 42\r$/m);
  assert.match(mime, /^In-Reply-To: <abc@mail\.acme-realty\.com>\r$/m);
  assert.match(mime, /^References: <abc@mail\.acme-realty\.com>\r$/m);
  const body = bodyOf(mime);
  assert.match(body, /Andres/);
  assert.match(body, /4821/);
  assert.match(body, /Loved hearing about your listings!/);
  assert.doesNotMatch(body, /verif|security|OTP|one-time|password/i, "nothing reads like a security email");
});

test("the reply is in the picked language, and Re: isn't doubled", () => {
  const body = bodyOf(
    decode(replyEmail({ language: "es", to: "a@b.es", subject: "Re: Lima 42", messageIdHeader: "", name: null, code: "1234", warmLine: "" })),
  );
  assert.match(body, /código/);
  const mime = decode(replyEmail({ language: "es", to: "a@b.es", subject: "Re: Lima 42", messageIdHeader: "", name: null, code: "1234", warmLine: "" }));
  assert.match(mime, /^Subject: Re: Lima 42\r$/m);
  assert.doesNotMatch(mime, /In-Reply-To/, "no Message-ID, no threading headers");
});

test("Voni's line and the name can't break out of the template", () => {
  const mime = decode(
    replyEmail({
      language: "fr",
      to: "a@b.fr",
      subject: "Citron 12 — été",
      messageIdHeader: "<x@y>",
      name: "Bob\r\nBcc: evil@x.com",
      code: "1234",
      warmLine: `${"a".repeat(400)}\r\nBcc: evil@x.com`,
    }),
  );
  assert.doesNotMatch(mime.split("\r\n\r\n")[0], /Bcc/, "no header injection");
  assert.match(mime, /^Subject: =\?UTF-8\?B\?/m, "a non-ASCII subject is encoded");
  const body = bodyOf(mime);
  assert.ok(!body.includes("a".repeat(301)), "the line is capped");
  assert.doesNotMatch(body, /Bob/, "a name that isn't a name is dropped");
});

test("Voni's lines follow the check: reveal only on a pass, never the code on a miss", async () => {
  const { codeCheckInstructions, REPLY_SENT_INSTRUCTIONS } = await import("./voni-agent");
  assert.match(codeCheckInstructions({ status: "correct", triesLeft: 1 }), /OTP, a security check[\s\S]*How efficient did that feel/);
  assert.match(codeCheckInstructions({ status: "wrong", triesLeft: 1 }), /once more/);
  for (const status of ["wrong", "out_of_tries"] as const) {
    const line = codeCheckInstructions({ status, triesLeft: 0 });
    assert.doesNotMatch(line, /OTP|How efficient/, status);
    assert.match(line, /Never say the right code/, status);
  }
  assert.doesNotMatch(REPLY_SENT_INSTRUCTIONS, /OTP|security/, "no early reveal");
});

test("the invite comes once, from the show tool's own result: no lead-in, no second note", async () => {
  const { inviteNowInstructions, voniConfig } = await import("./voni-agent");
  const { executeDemoTool, SHOW_TEST_ADDRESS_TOOL } = await import("./demo-tools");
  const result = await executeDemoTool(SHOW_TEST_ADDRESS_TOOL, {}, { testTag: "Lotus 82" });
  assert.ok(result.ok);
  assert.equal(result.data.instructions, inviteNowInstructions("Lotus 82"));
  assert.match(inviteNowInstructions("Lotus 82"), /Say only the invite, once[\s\S]*with Lotus 82 in the subject[\s\S]*Don't repeat anything/);
  const rules = voniConfig("any").knowledge;
  assert.match(rules, /Always respond to what the caller actually said first/);
  assert.doesNotMatch(rules, /Let me put something on your screen|a note follows/);
});

test("the call opens with the hook, and a yes goes straight to the test", async () => {
  const { VONI_GREETINGS, voniConfig } = await import("./voni-agent");
  assert.match(VONI_GREETINGS.en, /Let's try something cool/);
  assert.doesNotMatch(VONI_GREETINGS.en, /business/, "the business comes later");
  const rules = voniConfig("any").knowledge;
  assert.match(rules, /As soon as they say yes[\s\S]*in that same turn, put the test on their screen/);
  assert.doesNotMatch(rules, /Once they've told you a little about their business/);
});

test("a personal address: acknowledged, asked again, never a hang-up", async () => {
  const { checkEmailInstructions, beatGoal, EMAIL_BEAT_GOAL, OPEN_BEAT_GOAL } = await import("./voni-agent");
  const line = checkEmailInstructions({ status: "free", address: "nedal@gmail.com" });
  assert.match(line, /Got it, Nedal! But that's a personal address, and I need your work one/);
  assert.match(line, /Never hang up over it/);
  assert.doesNotMatch(line, /Then hang up/);
  const invited = { invited: true, found: false };
  assert.equal(beatGoal(invited), EMAIL_BEAT_GOAL);
  assert.equal(beatGoal({ ...invited, gated: true }), OPEN_BEAT_GOAL, "no strikes for not having a work email");
});

test("the silence check-in is one short line", async () => {
  const { SILENCE_CHECK_IN_INSTRUCTIONS, SILENCE_CHECK_IN_MS } = await import("./voni-agent");
  assert.equal(SILENCE_CHECK_IN_MS, 15_000);
  assert.match(SILENCE_CHECK_IN_INSTRUCTIONS, /Still with me\? Take your time\.[\s\S]*Nothing else/);
});
