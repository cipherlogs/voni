import test from "node:test";
import assert from "node:assert/strict";

import {
  InboxError,
  countThreadReplies,
  findTaggedMessage,
  inboxConfig,
  probeInbox,
  verifyDelivery,
  type InboxDeps,
} from "./inbox";

/**
 * The real inbox path for X4/X5/X8. The Gmail transport is injected, so the
 * tests prove the shape of the evidence (tag, message, thread, the gate) and
 * every named refusal without a network. A live run uses the same functions
 * with the configured refresh token; a missing or unreachable inbox refuses by
 * name and is never a skip that reads green.
 */

const CONFIG = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  DEMO_INBOX_REFRESH_TOKEN: "refresh-token",
};

type Call = { url: string; method: string };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deps(handler: (url: URL) => Response | Promise<Response>): { deps: InboxDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      fetch: async (input, init: RequestInit | undefined) => {
        const url = new URL(String(input));
        calls.push({ url: url.toString(), method: init?.method ?? "GET" });
        return handler(url);
      },
    },
  };
}

function gmail(handler: (url: URL) => Response | Promise<Response> | null): InboxDeps["fetch"] {
  return async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      return json({ access_token: "access-token", expires_in: 3600 });
    }
    const answer = handler(url);
    if (answer === null) throw new Error(`unexpected ${url.pathname}`);
    return answer;
  };
}

test("a missing inbox configuration is a named refusal, not an empty inbox", () => {
  assert.deepEqual(inboxConfig({}), {
    configured: false,
    missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DEMO_INBOX_REFRESH_TOKEN"],
  });
  const configured = inboxConfig(CONFIG);
  assert.equal(configured.configured, true);
  assert.ok(configured.configured);
  assert.equal(configured.refreshToken, "refresh-token");
});

test("a reachable inbox reports its own address and message count", async () => {
  const fake = deps((url) => {
    if (url.hostname === "oauth2.googleapis.com") {
      return json({ access_token: "access-token", expires_in: 3600 });
    }
    assert.equal(url.pathname, "/gmail/v1/users/me/profile");
    return json({ emailAddress: "test@voni.cc", messagesTotal: 42 });
  });
  const probe = await probeInbox(CONFIG, fake.deps);
  assert.deepEqual(probe, { ok: true, emailAddress: "test@voni.cc", messagesTotal: 42 });
});

test("a missing refresh token refuses by name before any network call", async () => {
  const fake = deps(() => json({}));
  await assert.rejects(probeInbox({}, fake.deps), (error: unknown) => {
    assert.ok(error instanceof InboxError);
    assert.equal(error.code, "inbox-not-configured");
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /DEMO_INBOX_REFRESH_TOKEN/);
    return true;
  });
  assert.equal(fake.calls.length, 0, "no request is sent without configuration");
});

test("a rejected refresh token is an auth refusal, never a zero-message inbox", async () => {
  const fake: InboxDeps = {
    fetch: async () => json({ error: "invalid_grant" }, 400),
  };
  await assert.rejects(probeInbox(CONFIG, fake), (error: unknown) => {
    assert.ok(error instanceof InboxError);
    assert.equal(error.code, "inbox-auth-failed");
    assert.equal(error.exitCode, 2);
    assert.ok(!error.message.includes("refresh-token"), "the secret never reaches the message");
    return true;
  });
});

test("an unreachable Gmail is a named refusal", async () => {
  const fake: InboxDeps = {
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        return json({ access_token: "a", expires_in: 3600 });
      }
      return json({ error: "backend down" }, 503);
    },
  };
  await assert.rejects(probeInbox(CONFIG, fake), (error: unknown) => {
    assert.ok(error instanceof InboxError);
    assert.equal(error.code, "inbox-unreachable");
    assert.match(error.message, /503/);
    return true;
  });
});

const ISSUED = new Date("2026-10-31T10:00:00.000Z");

function message(id: string, from: string, subject: string, snippet = ""): Response {
  return json({
    id,
    threadId: `thread-${id}`,
    internalDate: String(ISSUED.getTime() + 5_000),
    snippet,
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
        { name: "Authentication-Results", value: "mx; spf=pass; dkim=pass" },
      ],
    },
  });
}

test("a message carrying the call's tag is found by the same query the app uses", async () => {
  const seen: string[] = [];
  const fetch = gmail((url) => {
    seen.push(url.toString());
    if (url.pathname.endsWith("/messages")) {
      assert.match(url.searchParams.get("q") ?? "", /in:inbox -from:me after:/);
      assert.match(url.searchParams.get("q") ?? "", /\{lime lime42\}/);
      return json({ messages: [{ id: "m1" }] });
    }
    return message("m1", "Andres <andres@casaverde.pt>", "Lime 42");
  });

  const found = await findTaggedMessage({ tag: "Lime 42", issuedAt: ISSUED, env: CONFIG, deps: { fetch } });
  assert.deepEqual(found, {
    found: true,
    messageId: "m1",
    threadId: "thread-m1",
    senderKind: "work",
    receivedAt: ISSUED.getTime() + 5_000,
  });
  assert.equal(seen.length, 2);
});

test("an email naming several tags is nobody's and is not the delivery", async () => {
  const fetch = gmail((url) => {
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "m1" }] });
    return message("m1", "someone@work.example", "Lime 42 and Wave 19");
  });
  const found = await findTaggedMessage({ tag: "Lime 42", issuedAt: ISSUED, env: CONFIG, deps: { fetch } });
  assert.equal(found.found, false);
});

test("a personal-domain sender is marked personal, the gate's input", async () => {
  const fetch = gmail((url) => {
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "m2" }] });
    return message("m2", "someone@gmail.com", "Lime 42");
  });
  const found = await findTaggedMessage({ tag: "Lime 42", issuedAt: ISSUED, env: CONFIG, deps: { fetch } });
  assert.equal(found.found, true);
  assert.equal(found.found && found.senderKind, "personal");
});

test("a tag that never arrived is a delivered-nothing result, not an error", async () => {
  const fetch = gmail((url) => {
    if (url.pathname.endsWith("/messages")) return json({});
    return json({});
  });
  const found = await findTaggedMessage({ tag: "Lime 42", issuedAt: ISSUED, env: CONFIG, deps: { fetch } });
  assert.deepEqual(found, { found: false });
});

test("delivery verification refuses a tool's claim the inbox cannot produce", async () => {
  const fetch = gmail((url) => {
    if (url.pathname.endsWith("/messages")) return json({});
    return json({});
  });
  await assert.rejects(
    verifyDelivery(
      { tag: "Lime 42", issuedAt: ISSUED, claimedMessageId: "m1", env: CONFIG },
      { fetch },
    ),
    (error: unknown) => {
      assert.ok(error instanceof InboxError);
      assert.equal(error.code, "tag-not-delivered");
      assert.equal(error.exitCode, 2);
      return true;
    },
  );
});

test("delivery verification takes the real inbox's message id, refusing a mismatch", async () => {
  const fetch = gmail((url) => {
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "m9" }] });
    return message("m9", "andres@casaverde.pt", "Lime 42");
  });
  await assert.rejects(
    verifyDelivery(
      { tag: "Lime 42", issuedAt: ISSUED, claimedMessageId: "m1", env: CONFIG },
      { fetch },
    ),
    (error: unknown) => {
      assert.ok(error instanceof InboxError);
      assert.equal(error.code, "delivery-mismatch");
      assert.match(error.message, /m1/);
      assert.match(error.message, /m9/);
      return true;
    },
  );

  const verified = await verifyDelivery(
    { tag: "Lime 42", issuedAt: ISSUED, claimedMessageId: "m9", env: CONFIG, threadId: "thread-m9" },
    {
      fetch: gmail((url) => {
        if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "m9" }] });
        if (url.pathname.includes("/threads/")) {
          return json({
            id: "thread-m9",
            messages: [
              { payload: { headers: [{ name: "From", value: "Andres <andres@casaverde.pt>" }] } },
              { payload: { headers: [{ name: "From", value: "Voni <test@voni.cc>" }] } },
            ],
          });
        }
        return message("m9", "andres@casaverde.pt", "Lime 42");
      }),
    },
  );
  assert.deepEqual(verified, {
    verified: true,
    tag: "Lime 42",
    messageId: "m9",
    threadId: "thread-m9",
    senderKind: "work",
    repliesFromInbox: 1,
  });
});

test("a thread with two replies from the inbox is a double send", async () => {
  const fetch = gmail((url) => {
    if (url.pathname.includes("/threads/")) {
      return json({
        id: "thread-m9",
        messages: [
          { payload: { headers: [{ name: "From", value: "andres@casaverde.pt" }] } },
          { payload: { headers: [{ name: "From", value: "test@voni.cc" }] } },
          { payload: { headers: [{ name: "From", value: "test@voni.cc" }] } },
        ],
      });
    }
    return json({});
  });
  const replies = await countThreadReplies({ threadId: "thread-m9", env: CONFIG, deps: { fetch } });
  assert.equal(replies, 2);
});

test("a thread read failure is a named refusal, never zero replies", async () => {
  const fetch: InboxDeps["fetch"] = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "a", expires_in: 3600 });
    return json({ error: "nope" }, 500);
  };
  await assert.rejects(
    countThreadReplies({ threadId: "thread-m9", env: CONFIG, deps: { fetch } }),
    (error: unknown) => {
      assert.ok(error instanceof InboxError);
      assert.equal(error.code, "inbox-unreachable");
      return true;
    },
  );
});
