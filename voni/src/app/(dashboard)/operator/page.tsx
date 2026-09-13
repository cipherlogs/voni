import { Suspense } from "react";
import { desc, isNotNull } from "drizzle-orm";
import { OperatorDenied, OperatorView, type OperatorData } from "@/components/operator-view";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/lib/db";
import { agents, integrationChecks } from "@/lib/db/schema";
import { organization } from "@/lib/db/auth-schema";
import { secret } from "@/lib/env";
import { isPlatformAdmin } from "@/lib/platform/admin";
import { getPlatformConfig } from "@/lib/platform/config";
import { credentialSummary } from "@/lib/platform/credentials";
import { listAccounts } from "@/lib/platform/llm-accounts";
import { CREDENTIAL_NAMES, LLM_PROVIDER_IDS, type CredentialName, type LlmProviderId } from "@/lib/platform/types";
import { requireCtxOrRedirect } from "@/lib/session";

/**
 * Generic operator frame: paints without awaiting authorization or data.
 */
function OperatorFrame() {
  return (
    <div data-testid="operator-shell" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform operator</h1>
        <p className="text-muted-foreground text-sm">
          Administrative controls. Access is allowlist-restricted.
        </p>
      </div>
      <div role="status" aria-label="Loading operator console" className="flex flex-col gap-6">
        {[0, 1].map((section) => (
          <div key={section} className="grid grid-cols-1 gap-10 md:grid-cols-3" aria-hidden>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-48" />
            </div>
            <div className="sm:max-w-3xl md:col-span-2">
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Authorization decision first: session check, then allowlist validation.
 * Denial renders here; administrative content only loads after the allowlist
 * passes. Never fetches admin data for non-operators.
 */
async function OperatorGate() {
  const ctx = await requireCtxOrRedirect("/operator");
  if (!(await isPlatformAdmin(ctx.email))) return <OperatorDenied />;

  const [config, credentialEntries, accountLists, checks, organizations, savedAgents, bootstrap] = await Promise.all([
    getPlatformConfig(),
    Promise.all(CREDENTIAL_NAMES.map(async (name) => [name, await credentialSummary(name)] as const)),
    Promise.all(LLM_PROVIDER_IDS.map((id) => listAccounts(id))),
    db.select().from(integrationChecks).orderBy(desc(integrationChecks.testedAt)).limit(50),
    db.select({ id: organization.id, name: organization.name }).from(organization),
    db.select({ id: agents.id, name: agents.name, organizationId: agents.organizationId }).from(agents).where(isNotNull(agents.assemblyaiAgentId)),
    Promise.all(["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "VONI_ADMIN_EMAILS", "VONI_CREDENTIALS_ENCRYPTION_KEY", "VONI_API_URL", "VONI_TOOL_SECRET", "PUBLIC_HOST"].map(async (name) => ({ name, configured: Boolean(await secret(name)) }))),
  ]);
  const credentials = Object.fromEntries(credentialEntries.map(([name, value]) => [name, { configured: value.configured, source: value.source }])) as OperatorData["credentials"];
  const llmAccounts = Object.fromEntries(LLM_PROVIDER_IDS.map((providerId, index) => [providerId, accountLists[index].map((account) => ({ id: account.id, label: account.label, status: account.status, enabled: account.enabled, cooldownUntil: account.cooldownUntil?.toISOString() ?? null }))])) as Record<LlmProviderId, OperatorData["llmAccounts"][LlmProviderId]>;
  const latestChecks = Object.values(checks.reduce<Record<string, (typeof checks)[number]>>((result, check) => { if (!result[check.service]) result[check.service] = check; return result; }, {})).map((check) => ({ ...check, testedAt: check.testedAt.toISOString() }));
  return <OperatorView data={{ config, credentials: credentials as Record<CredentialName, { configured: boolean; source: string }>, llmAccounts, checks: latestChecks, organizations, agents: savedAgents, bootstrap }} />;
}

export default function OperatorPage() {
  return (
    <Suspense fallback={<OperatorFrame />}>
      <OperatorGate />
    </Suspense>
  );
}
