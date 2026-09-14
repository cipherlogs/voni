"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, CircleDot, KeyRound } from "lucide-react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { ConnectionTestButton } from "@/components/connection-test-button";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updatePlatformConfiguration, type SettingsActionState } from "@/app/(dashboard)/settings/actions";
import type { LlmAccountStatus } from "@/lib/platform/llm-accounts";
import type { CredentialName, LlmProviderId, PlatformConfigValues } from "@/lib/platform/types";

const INITIAL: SettingsActionState = { ok: false };

function SaveDefaultsButton() {
  const { pending } = useFormStatus();
  return <LoadingButton type="submit" pending={pending} pendingText="Saving…">Save platform defaults</LoadingButton>;
}
const CREDENTIAL_LABELS: Record<CredentialName, string> = {
  assemblyai_api_key: "AssemblyAI",
  telnyx_api_key: "Telnyx",
  cartesia_api_key: "Cartesia",
};
const CREDENTIAL_SERVICES: Record<CredentialName, string> = {
  assemblyai_api_key: "assemblyai",
  telnyx_api_key: "telnyx",
  cartesia_api_key: "cartesia",
};
const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  groq: "Groq",
  cerebras: "Cerebras",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};

export type OperatorData = {
  credentials: Record<CredentialName, { configured: boolean; source: string }>;
  llmAccounts: Record<LlmProviderId, Array<{
    id: string;
    label: string;
    status: LlmAccountStatus;
    enabled: boolean;
    cooldownUntil: string | null;
  }>>;
  config: PlatformConfigValues;
  checks: Array<{ service: string; status: "passed" | "failed"; latencyMs: number; error: string | null; testedAt: string }>;
  organizations: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; organizationId: string }>;
  bootstrap: Array<{ name: string; configured: boolean }>;
};

export function OperatorDenied() {
  return (
    <div className="flex flex-col gap-6">
      <RouteBrief route="/operator" brief="Operator access denied. This account is not allowlisted as a platform administrator. Do not report navigation as completed." />
      <h1 className="text-2xl font-semibold tracking-tight">Operator access</h1>
      <Alert variant="destructive">
        <KeyRound />
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>This area is limited to allowlisted platform administrators.</AlertDescription>
      </Alert>
    </div>
  );
}

export function OperatorView({ data }: { data: OperatorData }) {
  const [state, action] = useActionState(updatePlatformConfiguration, INITIAL);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <RouteBrief route="/operator" brief={`Platform operator area. Access granted. ${data.bootstrap.filter((item) => item.configured).length} of ${data.bootstrap.length} deployment values are set. Credential values are never available here. Provider and bridge default changes require confirmation.`} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform operator</h1>
        <p className="text-muted-foreground text-sm">Readiness, connection health, and non-secret platform defaults.</p>
      </div>

      <Alert>
        <KeyRound />
        <AlertTitle>Credentials stay out of the browser</AlertTitle>
        <AlertDescription>Rotate encrypted credentials with <code>npm run operator:credential</code>. The command reads the value from stdin and never accepts it as an argument.</AlertDescription>
      </Alert>

      <section aria-labelledby="operator-bootstrap-heading" className="flex flex-col gap-6">
        <div>
          <h2 id="operator-bootstrap-heading" className="text-balance font-semibold text-foreground">Bootstrap readiness</h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">Required deployment values are shown by name only.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {data.bootstrap.map((item) => <div key={item.name} className="flex items-center justify-between rounded-lg border p-4 text-sm"><span className="font-mono text-xs">{item.name}</span><Badge variant={item.configured ? "secondary" : "outline"}>{item.configured ? "Set" : "Missing"}</Badge></div>)}
        </div>
      </section>

      <Separator />

      <section aria-labelledby="operator-credentials-heading" className="flex flex-col gap-6">
        <div>
          <h2 id="operator-credentials-heading" className="text-balance font-semibold text-foreground">Service credentials</h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">Status and origin only. Values and rotation controls are server-only.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {(Object.keys(CREDENTIAL_LABELS) as CredentialName[]).map((name) => (
            <div key={name} className="grid gap-3 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{CREDENTIAL_LABELS[name]}</span><Badge variant={data.credentials[name].configured ? "secondary" : "outline"}>{data.credentials[name].configured ? "Ready" : "Missing"}</Badge></div>
              <p className="text-muted-foreground text-xs">Source: {data.credentials[name].source}</p>
              <ConnectionTestButton service={CREDENTIAL_SERVICES[name]} />
            </div>
          ))}
        </div>
      </section>

      <Separator />

      <section aria-labelledby="operator-llm-heading" className="flex flex-col gap-6">
        <div>
          <h2 id="operator-llm-heading" className="text-balance font-semibold text-foreground">LLM account status</h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">Health is visible; account keys and lifecycle controls remain in the operator CLI.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {(Object.keys(PROVIDER_LABELS) as LlmProviderId[]).map((providerId) => (
            <div key={providerId} className="grid gap-2 rounded-lg border p-4">
              <p className="font-medium">{PROVIDER_LABELS[providerId]}</p>
              {data.llmAccounts[providerId].length ? data.llmAccounts[providerId].map((account) => (
                <div key={account.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>{account.label}</span>
                  <div className="flex items-center gap-2"><Badge variant={account.status === "ok" ? "secondary" : "outline"}>{account.status === "cooldown" && account.cooldownUntil ? `Cooling until ${new Date(account.cooldownUntil).toLocaleTimeString()}` : account.status === "ok" ? "Ready" : "Disabled"}</Badge><ConnectionTestButton service={providerId} accountId={account.id} /></div>
                </div>
              )) : <p className="text-muted-foreground text-sm">No accounts configured.</p>}
            </div>
          ))}
        </div>
      </section>

      <Separator />

      <section aria-labelledby="operator-defaults-heading" className="flex flex-col gap-6">
        <div>
          <h2 id="operator-defaults-heading" className="text-balance font-semibold text-foreground">Provider and bridge defaults</h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">These identifiers and routing defaults contain no provider secrets.</p>
        </div>
        <form action={action} className="grid gap-5">
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              {(["groq", "cerebras", "gemini", "openrouter"] as const).map((provider) => <Field key={provider}><FieldLabel htmlFor={`${provider}-model`}>{PROVIDER_LABELS[provider]} model</FieldLabel><Input id={`${provider}-model`} name={`${provider}Model`} defaultValue={data.config[`${provider}Model`]} /></Field>)}
            </FieldGroup>
            <Field><FieldLabel htmlFor="llm-order">LLM fallback order</FieldLabel><Input id="llm-order" name="llmProviderOrder" defaultValue={data.config.llmProviderOrder.join(", ")} /><p className="text-muted-foreground text-xs">Use each provider once, separated by commas.</p></Field>
            <FieldGroup className="grid gap-4 md:grid-cols-2"><Field><FieldLabel htmlFor="connection-id">Telnyx Call Control connection ID</FieldLabel><Input id="connection-id" name="telnyxConnectionId" defaultValue={data.config.telnyxConnectionId ?? ""} /></Field><Field><FieldLabel htmlFor="caller-number">Default caller number</FieldLabel><Input id="caller-number" name="telnyxCallerNumber" type="tel" defaultValue={data.config.telnyxCallerNumber ?? ""} /></Field><Field><FieldLabel htmlFor="cartesia-voice">Cartesia voice ID</FieldLabel><Input id="cartesia-voice" name="cartesiaVoiceId" defaultValue={data.config.cartesiaVoiceId ?? ""} /></Field></FieldGroup>
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              <Field><FieldLabel htmlFor="bridge-workspace">Bridge workspace</FieldLabel><Select name="bridgeOrganizationId" defaultValue={data.config.bridgeOrganizationId ?? "none"}><SelectTrigger id="bridge-workspace" aria-label="Bridge workspace" className="w-full"><SelectValue placeholder="Select workspace" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">Not selected</SelectItem>{data.organizations.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="bridge-agent">Saved Voni agent</FieldLabel><Select name="bridgeAgentId" defaultValue={data.config.bridgeAgentId ?? "none"}><SelectTrigger id="bridge-agent" aria-label="Saved Voni agent" className="w-full"><SelectValue placeholder="Select agent" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">Not selected</SelectItem>{data.agents.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
            </FieldGroup>
            {state.error || state.message ? <Alert variant={state.error ? "destructive" : "default"}><AlertTitle>{state.error ? "Could not save" : "Done"}</AlertTitle><AlertDescription>{state.error ?? state.message}</AlertDescription></Alert> : null}
            <div>
              <Separator />
              <div className="flex items-center justify-end gap-3 pt-4">
                <SaveDefaultsButton />
              </div>
            </div>
        </form>
      </section>

      <Separator />

      <section aria-labelledby="operator-checks-heading" className="flex flex-col gap-6">
        <div>
          <h2 id="operator-checks-heading" className="text-balance font-semibold text-foreground">Latest connection tests</h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">Status, latency, time, and sanitized errors only.</p>
        </div>
        <div className="flex flex-col gap-2">
          {data.checks.length ? data.checks.map((check) => <div key={check.service} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4 text-sm"><span className="flex items-center gap-2">{check.status === "passed" ? <CheckCircle2 className="size-4" /> : <CircleDot className="size-4" />}<span className="font-medium">{check.service}</span></span><span className="text-muted-foreground">{check.status} · {check.latencyMs} ms · {new Date(check.testedAt).toLocaleString()}</span>{check.error ? <span className="text-destructive w-full">{check.error}</span> : null}</div>) : <Empty><EmptyHeader><EmptyMedia variant="icon"><CircleDot /></EmptyMedia><EmptyDescription>No connection tests yet.</EmptyDescription></EmptyHeader></Empty>}
        </div>
      </section>
    </div>
  );
}
