/**
 * Rules for the one shape the Grafana k6 check posts to
 * `/api/email/clicks/report`. The route's half is proved by source text; every
 * decision about what may be stored is proved here, on the parser, without a
 * request or a database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isClickReportAuthorized,
  parseClickReport,
} from "./click-report";

const NOW = new Date("2026-11-17T12:00:00.000Z");

test("a minimal report parses with nulls for what was not observed", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing?utm_source=email" },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.target, "https://voni.cc/landing?utm_source=email");
  assert.equal(result.value.source, null);
  assert.equal(result.value.finalUrl, null);
  assert.equal(result.value.status, null);
  assert.equal(result.value.ms, null);
  assert.equal(result.value.ranAt.toISOString(), NOW.toISOString());
});

test("a full report parses and trims an empty source to null", () => {
  const result = parseClickReport(
    {
      target: "https://voni.cc/landing",
      source: "  ",
      finalUrl: "https://example.com/final",
      status: 302,
      ms: 120,
      ranAt: "2026-11-17T11:59:00.000Z",
    },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.source, null);
  assert.equal(result.value.finalUrl, "https://example.com/final");
  assert.equal(result.value.status, 302);
  assert.equal(result.value.ms, 120);
  assert.equal(result.value.ranAt.toISOString(), "2026-11-17T11:59:00.000Z");
});

test("a missing target is rejected", () => {
  const result = parseClickReport({ source: "gmail.com" }, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_target");
});

test("a relative target is rejected", () => {
  const result = parseClickReport({ target: "/landing" }, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_target");
});

test("an ftp target is rejected", () => {
  const result = parseClickReport({ target: "ftp://voni.cc/landing" }, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_target");
});

test("an over-long target is rejected", () => {
  const result = parseClickReport(
    { target: `https://voni.cc/${"a".repeat(2048)}` },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_target");
});

test("status outside 100-599 is rejected", () => {
  for (const status of [99, 600]) {
    const result = parseClickReport(
      { target: "https://voni.cc/landing", status },
      NOW,
    );
    assert.equal(result.ok, false, `status ${status} was accepted`);
    if (result.ok) continue;
    assert.equal(result.reason, "bad_status");
  }
});

test("a fractional status is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", status: 200.5 },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_status");
});

test("ms above the ceiling is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", ms: 120_001 },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_ms");
});

test("a negative ms is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", ms: -1 },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_ms");
});

test("a report 25 hours old is rejected", () => {
  const ranAt = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
  const result = parseClickReport({ target: "https://voni.cc/landing", ranAt }, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_ran_at");
});

test("a report ten minutes in the future is rejected", () => {
  const ranAt = new Date(NOW.getTime() + 10 * 60_000).toISOString();
  const result = parseClickReport({ target: "https://voni.cc/landing", ranAt }, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_ran_at");
});

test("an unparsable ranAt is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", ranAt: "yesterday" },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_ran_at");
});

test("a report with a producer and runner OS keeps both", () => {
  const result = parseClickReport(
    {
      target: "https://voni.cc/landing",
      producer: "github",
      runnerOs: "ubuntu",
    },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.producer, "github");
  assert.equal(result.value.runnerOs, "ubuntu");
});

test("an absent producer is Grafana, and the old Grafana payload is unchanged", () => {
  const grafana = {
    target: "https://voni.cc/landing",
    source: "gmail.com",
    finalUrl: "https://voni.cc/landing",
    status: 200,
    ms: 42,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    device: "desktop",
    browser: "Chrome",
    ranAt: "2026-11-17T11:59:00.000Z",
  };
  const result = parseClickReport(grafana, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.producer, "grafana");
  assert.equal(result.value.runnerOs, null);
  // Every field the old reporter sent still parses to exactly what it did
  // before the two new columns existed.
  assert.deepEqual(
    { ...result.value, producer: undefined, runnerOs: undefined },
    {
      target: "https://voni.cc/landing",
      source: "gmail.com",
      finalUrl: "https://voni.cc/landing",
      status: 200,
      ms: 42,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      device: "desktop",
      browser: "Chrome",
      ranAt: new Date("2026-11-17T11:59:00.000Z"),
      producer: undefined,
      runnerOs: undefined,
    },
  );
});

test("a null producer and a null runner OS parse to the defaults", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", producer: null, runnerOs: null },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.producer, "grafana");
  assert.equal(result.value.runnerOs, null);
});

test("an unknown producer is rejected with a fixed reason", () => {
  for (const producer of ["selenium", "githubb", "unknown", ""]) {
    const result = parseClickReport(
      { target: "https://voni.cc/landing", producer },
      NOW,
    );
    assert.equal(result.ok, false, `producer ${JSON.stringify(producer)} was accepted`);
    if (result.ok) continue;
    assert.equal(result.reason, "bad_producer");
  }
});

test("an allowlisted producer is accepted case-insensitively", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", producer: " GitHub " },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.producer, "github");
});

test("a non-string producer is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", producer: 2 },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_producer");
});

test("an OS outside the allowlist is rejected with a fixed reason", () => {
  for (const runnerOs of ["linux", "darwin", "windows-11", "ubuntu; rm -rf /"]) {
    const result = parseClickReport(
      { target: "https://voni.cc/landing", producer: "github", runnerOs },
      NOW,
    );
    assert.equal(result.ok, false, `runnerOs ${JSON.stringify(runnerOs)} was accepted`);
    if (result.ok) continue;
    assert.equal(result.reason, "bad_runner_os");
  }
});

test("an allowlisted OS is accepted case-insensitively, like the device class", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", producer: "github", runnerOs: "Ubuntu" },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.runnerOs, "ubuntu");
});

test("a non-string runner OS is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", producer: "github", runnerOs: true },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_runner_os");
});

test("a blank runner OS is not the same as absent and is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", producer: "github", runnerOs: "   " },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_runner_os");
});

test("a report carrying an explicit grafana producer still parses", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", producer: "grafana" },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.producer, "grafana");
});

test("unknown extra keys are ignored", () => {
  const result = parseClickReport(
    {
      target: "https://voni.cc/landing",
      source: "gmail.com",
      grafanaRunId: "abc",
      nested: { anything: [1, 2, 3] },
    },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value).sort(), [
    "browser",
    "device",
    "finalUrl",
    "ms",
    "producer",
    "ranAt",
    "runnerOs",
    "source",
    "status",
    "target",
    "userAgent",
  ]);
});

test("a report with an identity parses all three fields", () => {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
  const result = parseClickReport(
    {
      target: "https://voni.cc/landing",
      userAgent,
      device: "desktop",
      browser: "Chrome",
    },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.userAgent, userAgent);
  assert.equal(result.value.device, "desktop");
  assert.equal(result.value.browser, "Chrome");
});

test("an identity that was not observed is null, not empty", () => {
  const result = parseClickReport(
    {
      target: "https://voni.cc/landing",
      userAgent: "  ",
      device: "",
      browser: null,
    },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.userAgent, null);
  assert.equal(result.value.device, null);
  assert.equal(result.value.browser, null);
});

test("an unknown device is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", device: "toaster" },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_device");
});

test("a non-string device is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", device: 3 },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_device");
});

test("an over-long user agent is rejected rather than truncated", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", userAgent: `Mozilla/5.0 ${"a".repeat(400)}` },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_user_agent");
});

test("an over-long browser name is rejected", () => {
  const result = parseClickReport(
    { target: "https://voni.cc/landing", browser: "b".repeat(41) },
    NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad_browser");
});

test("a non-object body is rejected without echoing it", () => {
  for (const raw of [null, [], "target", 42]) {
    const result = parseClickReport(raw, NOW);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.reason, "not_object");
  }
});

test("auth: a missing header is refused", () => {
  assert.equal(isClickReportAuthorized(null, "s3cret"), false);
  assert.equal(isClickReportAuthorized("", "s3cret"), false);
});

test("auth: an unset expected secret is refused", () => {
  assert.equal(isClickReportAuthorized("s3cret", undefined), false);
  assert.equal(isClickReportAuthorized("s3cret", ""), false);
  assert.equal(isClickReportAuthorized("", ""), false);
});

test("auth: the matching secret is accepted", () => {
  assert.equal(isClickReportAuthorized("s3cret", "s3cret"), true);
});

test("auth: a wrong secret is refused", () => {
  assert.equal(isClickReportAuthorized("s3cret", "s3creT"), false);
  assert.equal(isClickReportAuthorized("s3cret ", "s3cret"), false);
  assert.equal(isClickReportAuthorized("s3cret-extra", "s3cret"), false);
});
