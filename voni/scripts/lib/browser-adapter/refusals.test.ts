/**
 * The certifying adapter's refusal surface: a fake pipeline, a test build, a
 * missing key, vendor build, capture sink or target is named before Chromium
 * opens. None of these may read as a pass.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FAKE_KEYS,
  fakeStackProbe,
  probeRunInput,
  removeTree,
  writeCorpus,
} from "./fixtures";
import {
  fakePipelineReason,
  isLoopbackHost,
  preflightBrowserRun,
  refusalCodeFor,
  testBuildReason,
} from "./refusals";
import { CLEAN_VENDOR_BUILDS } from "../protocol-adapter/fixtures";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv17-refusals-"));
}

function preflightInput(root: string, overrides: Record<string, unknown> = {}) {
  const input = probeRunInput({
    corpusDir: join(root, "corpus"),
    runRoot: join(root, "runs"),
    eventsDir: join(root, "events"),
    capturesDir: join(root, "captures"),
  });
  return {
    scenarioName: "golden-flow-smoke",
    target: "local" as const,
    locale: undefined,
    corpusDir: join(root, "corpus"),
    knownProperties: new Set(["G1", "E1"]),
    env: FAKE_KEYS,
    appUrl: input.appUrl ?? "http://127.0.0.1:3100",
    pipelineUrl: input.pipelineUrl ?? "https://localhost:8766",
    vendorBuilds: CLEAN_VENDOR_BUILDS,
    vendorBuildsPath: join(root, "vendor-builds.json"),
    soundscapes: {},
    probe: fakeStackProbe(),
    ...overrides,
  };
}

test("a fake pipeline host is named before any call", () => {
  assert.match(fakePipelineReason("https://pipeline.invalid") ?? "", /fake host/);
  assert.equal(fakePipelineReason("https://localhost:8766"), null);
});

test("the e2e test build is named before any call", () => {
  assert.match(
    testBuildReason({ NEXT_PUBLIC_VONI_E2E_CAPTURE: "1" }) ?? "",
    /test build can never certify/,
  );
  assert.match(testBuildReason({ VONI_INSTANT_TEST_BUILD: "1" }) ?? "", /e2e test build/);
  assert.equal(testBuildReason(FAKE_KEYS), null);
});

test("a local certificate needs a loopback app and pipeline", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("voni.example.com"), false);
});

test("refusal codes map the first named cause", () => {
  assert.equal(refusalCodeFor([{ item: "fake-pipeline", detail: "" }]), "fake-pipeline");
  assert.equal(refusalCodeFor([{ item: "test-build", detail: "" }]), "test-build");
  assert.equal(refusalCodeFor([{ item: "META_API_KEY", detail: "" }]), "missing-key");
  assert.equal(refusalCodeFor([{ item: "vendor-build:tts", detail: "" }]), "missing-vendor-build");
  assert.equal(refusalCodeFor([{ item: "pipeline-build", detail: "" }]), "missing-vendor-build");
  assert.equal(refusalCodeFor([{ item: "capture-unavailable", detail: "" }]), "capture-unavailable");
  assert.equal(refusalCodeFor([{ item: "soundscape:tv", detail: "" }]), "missing-soundscape");
  assert.equal(refusalCodeFor([{ item: "scenario:golden", detail: "" }]), "missing-scenario");
  assert.equal(refusalCodeFor([{ item: "corpus", detail: "" }]), "missing-corpus");
});

test("a healthy real stack passes preflight and reports the pipeline build", async () => {
  const root = tempRoot();
  try {
    writeCorpus(join(root, "corpus"), [{ name: "golden-flow-smoke" }]);
    const answer = await preflightBrowserRun(preflightInput(root));
    assert.equal(answer.ok, true);
    if (answer.ok) {
      assert.equal(answer.pipelineBuild, "pipeline-build-1");
      assert.equal(answer.target.appUrl, "http://127.0.0.1:3100");
      assert.equal(answer.scenario.name, "golden-flow-smoke");
    }
  } finally {
    removeTree(root);
  }
});

test("a production build without the dev capture sink refuses by name", async () => {
  const root = tempRoot();
  try {
    writeCorpus(join(root, "corpus"), [{ name: "golden-flow-smoke" }]);
    const answer = await preflightBrowserRun(
      preflightInput(root, {
        probe: fakeStackProbe({ "POST /api/dev/call-marks": { status: 404 } }),
      }),
    );
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.ok(answer.missing.some((item) => item.item === "capture-unavailable"));
      assert.equal(refusalCodeFor(answer.missing), "capture-unavailable");
    }
  } finally {
    removeTree(root);
  }
});

test("an unversioned pipeline refuses: a certificate records the image it ran (RR-03)", async () => {
  const root = tempRoot();
  try {
    writeCorpus(join(root, "corpus"), [{ name: "golden-flow-smoke" }]);
    const answer = await preflightBrowserRun(
      preflightInput(root, {
        probe: fakeStackProbe({
          "GET /healthz": { status: 200, body: { status: "ok", buildVersion: "unversioned" } },
        }),
      }),
    );
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.ok(answer.missing.some((item) => item.item === "pipeline-build"));
      assert.equal(refusalCodeFor(answer.missing), "missing-vendor-build");
    }
  } finally {
    removeTree(root);
  }
});

test("an unready pipeline refuses before any call", async () => {
  const root = tempRoot();
  try {
    writeCorpus(join(root, "corpus"), [{ name: "golden-flow-smoke" }]);
    const answer = await preflightBrowserRun(
      preflightInput(root, {
        probe: fakeStackProbe({ "GET /readyz": { status: 503 } }),
      }),
    );
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.ok(answer.missing.some((item) => item.item === "pipeline-unreachable"));
    }
  } finally {
    removeTree(root);
  }
});

test("a remote target has no capture evidence and refuses", async () => {
  const root = tempRoot();
  try {
    writeCorpus(join(root, "corpus"), [{ name: "golden-flow-smoke" }]);
    const answer = await preflightBrowserRun(
      preflightInput(root, { target: "staging" }),
    );
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.ok(answer.missing.some((item) => item.item === "target"));
      assert.equal(refusalCodeFor(answer.missing), "target-invalid");
    }
  } finally {
    removeTree(root);
  }
});

test("a local target with a remote stack is a target mismatch", async () => {
  const root = tempRoot();
  try {
    writeCorpus(join(root, "corpus"), [{ name: "golden-flow-smoke" }]);
    const answer = await preflightBrowserRun(
      preflightInput(root, {
        appUrl: "https://voni.example.com",
        pipelineUrl: "https://pipeline.example.com",
      }),
    );
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.ok(answer.missing.some((item) => item.item === "target-mismatch"));
    }
  } finally {
    removeTree(root);
  }
});

test("a missing soundscape refuses rather than mixing silence", async () => {
  const root = tempRoot();
  try {
    writeCorpus(join(root, "corpus"), [
      { name: "golden-flow-smoke", soundscape: { id: "living-room-tv" } },
    ]);
    const answer = await preflightBrowserRun(preflightInput(root));
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.ok(answer.missing.some((item) => item.item === "soundscape:living-room-tv"));
      assert.equal(refusalCodeFor(answer.missing), "missing-soundscape");
    }
  } finally {
    removeTree(root);
  }
});
