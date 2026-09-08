import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

test("bridge config rejects missing and non-exact bearer secrets without returning configuration", async () => {
  const previous = process.env.VONI_TOOL_SECRET;
  process.env.VONI_TOOL_SECRET = "bridge-secret";
  try {
    for (const authorization of [undefined, "Bearer wrong", "bearer bridge-secret", "Bearer  bridge-secret"]) {
      const headers = authorization ? { authorization } : undefined;
      const response = await GET(new Request("http://localhost/api/internal/bridge-config", { headers }));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized." });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally {
    if (previous === undefined) delete process.env.VONI_TOOL_SECRET;
    else process.env.VONI_TOOL_SECRET = previous;
  }
});
