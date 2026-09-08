import { secret } from "@/lib/env";
import { getPlatformConfig } from "@/lib/platform/config";

/**
 * Shared gate for the internal endpoints the telephony bridge calls.
 *
 * Same shape as `/api/internal/bridge-config`: a bearer secret both sides hold,
 * and an organization the *server* chooses. The bridge never names the
 * workspace it wants — it is a trusted process, but "trusted" only extends to
 * the one workspace an operator selected in Settings, and accepting an org id
 * over the wire would turn a leaked secret into access to every tenant.
 */
export type BridgeAuth =
  | { ok: true; organizationId: string }
  | { ok: false; status: number; error: string };

export async function authorizeBridge(request: Request): Promise<BridgeAuth> {
  const expected = await secret("VONI_TOOL_SECRET");
  const supplied = request.headers.get("authorization");
  if (!expected || supplied !== `Bearer ${expected}`) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }

  if (
    process.env.NODE_ENV === "production" &&
    new URL(request.url).protocol !== "https:" &&
    request.headers.get("x-forwarded-proto") !== "https"
  ) {
    return { ok: false, status: 400, error: "HTTPS is required." };
  }

  const config = await getPlatformConfig();
  if (!config.bridgeOrganizationId) {
    return {
      ok: false,
      status: 503,
      error: "No bridge workspace is selected in Settings → Platform.",
    };
  }
  return { ok: true, organizationId: config.bridgeOrganizationId };
}

export function bridgeError(status: number, error: string) {
  return Response.json(
    { ok: false, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
