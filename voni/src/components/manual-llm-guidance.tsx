import Link from "next/link";

/**
 * Operator guidance shown beside generation failures and in Settings →
 * Platform. Provider keys are operator-managed: an allowlisted operator adds
 * them through Settings, and Meta stays environment-only by design.
 */
export function ManualLlmGuidance() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
      <p className="font-medium text-foreground">
        Add a provider key to enable generation
      </p>
      <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-4">
        <li>Open the platform operator area (operator access required).</li>
        <li>Select Groq, Cerebras, Gemini, or OpenRouter.</li>
        <li>Enter a recognizable account label and its API key.</li>
        <li>Add and test the account.</li>
        <li>Add more accounts for the same provider for failover.</li>
        <li>Change the free-provider order under Provider and bridge defaults.</li>
      </ol>
      <p className="text-muted-foreground">
        Meta always runs first, cannot be configured in Settings, and reads{" "}
        <span className="font-mono">META_API_KEY</span> from{" "}
        <span className="font-mono">.dev.vars</span> locally or a Worker secret
        in production. Stored keys are always masked.{" "}
        <Link href="/operator" className="cursor-pointer rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Open platform operator
        </Link>
      </p>
    </div>
  );
}
