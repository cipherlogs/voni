"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { RouteBrief } from "@/components/copilot/route-brief";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  KeyRound,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModeToggle } from "@/components/mode-toggle";
import { ConnectionTestButton } from "@/components/connection-test-button";
import { ManualLlmGuidance } from "@/components/manual-llm-guidance";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { signOut } from "@/lib/auth-client";
import type { CredentialName, CredentialSummary, LlmProviderId, PlatformConfigValues } from "@/lib/platform/types";
import type { LlmAccountStatus } from "@/lib/platform/llm-accounts";
import {
  ACCENT_LABEL,
  INPUT_LANGUAGES,
  inputLanguage,
  voicesByLanguage,
  voiceLabel,
} from "@/lib/agents/voices";
import { prefsPairingNote, type CopilotVoicePrefs } from "@/lib/copilot/voice-prefs";
import {
  addLlmAccount,
  removeLlmAccount,
  removePlatformCredential,
  setLlmAccountEnabled,
  updateCopilotVoicePrefs,
  updatePlatformConfiguration,
  updatePlatformCredential,
  updateWorkspaceSettings,
  type SettingsActionState,
} from "@/app/(dashboard)/settings/actions";

const INITIAL: SettingsActionState = { ok: false };

function SubmitButton({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "outline" | "destructive" }) {
  const { pending } = useFormStatus();
  return (
    <LoadingButton type="submit" variant={variant} pending={pending}>
      {children}
    </LoadingButton>
  );
}

function ActionFeedback({ state }: { state: SettingsActionState }) {
  if (!state.message && !state.error) return null;
  return (
    <Alert variant={state.error ? "destructive" : "default"} className="status-enter">
      {state.error ? <AlertCircle /> : <CheckCircle2 />}
      <AlertTitle>{state.error ? "Could not save" : "Done"}</AlertTitle>
      <AlertDescription>{state.error ?? state.message}</AlertDescription>
    </Alert>
  );
}

const CREDENTIAL_LABELS: Record<CredentialName, string> = {
  assemblyai_api_key: "AssemblyAI API key",
  telnyx_api_key: "Telnyx API key",
  cartesia_api_key: "Cartesia API key",
};

const CREDENTIAL_SERVICES: Record<CredentialName, string> = {
  assemblyai_api_key: "assemblyai",
  telnyx_api_key: "telnyx",
  cartesia_api_key: "cartesia",
};

const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
  groq: "Groq",
  cerebras: "Cerebras",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};

const ACCOUNT_STATUS_LABEL: Record<LlmAccountStatus, string> = {
  ok: "Ready",
  cooldown: "Cooling down",
  disabled: "Disabled",
};

const ACCOUNT_STATUS_VARIANT: Record<LlmAccountStatus, "secondary" | "outline" | "destructive"> = {
  ok: "secondary",
  cooldown: "outline",
  disabled: "outline",
};

type LlmAccountView = {
  id: string;
  providerId: LlmProviderId;
  label: string;
  maskedPreview: string;
  enabled: boolean;
  status: LlmAccountStatus;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastError: string | null;
};

function LlmAccountRow({ account }: { account: LlmAccountView }) {
  const [toggleState, toggleAction] = useActionState(setLlmAccountEnabled, INITIAL);
  const [removeState, removeAction] = useActionState(removeLlmAccount, INITIAL);
  const feedback = removeState.error || removeState.message ? removeState : toggleState;
  return (
    <div className="list-enter grid gap-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{account.label}</span>{" "}
          <span className="text-muted-foreground font-mono text-xs">{account.maskedPreview}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={ACCOUNT_STATUS_VARIANT[account.status]}>
            {account.status === "cooldown" && account.cooldownUntil
              ? `Cooling down until ${new Date(account.cooldownUntil).toLocaleTimeString()}`
              : ACCOUNT_STATUS_LABEL[account.status]}
          </Badge>
          <ConnectionTestButton service={account.providerId} accountId={account.id} />
          <form action={toggleAction}>
            <input type="hidden" name="accountId" value={account.id} />
            <input type="hidden" name="enabled" value={String(!account.enabled)} />
            <SubmitButton variant="outline">{account.enabled ? "Disable" : "Enable"}</SubmitButton>
          </form>
          <form action={removeAction}>
            <input type="hidden" name="accountId" value={account.id} />
            <SubmitButton variant="destructive">Remove</SubmitButton>
          </form>
        </div>
      </div>
      {account.lastError ? <p className="text-destructive text-xs">{account.lastError}</p> : null}
      <ActionFeedback state={feedback} />
    </div>
  );
}

function LlmProviderAccounts({ providerId, accounts }: { providerId: LlmProviderId; accounts: LlmAccountView[] }) {
  const [addState, addAction] = useActionState(addLlmAccount, INITIAL);
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <p className="font-medium">{LLM_PROVIDER_LABELS[providerId]}</p>
      {accounts.length ? (
        <div className="grid gap-2">
          {accounts.map((account) => <LlmAccountRow key={account.id} account={account} />)}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">No accounts added yet.</p>
      )}
      <form action={addAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <input type="hidden" name="providerId" value={providerId} />
        <div className="grid gap-1">
          <Label htmlFor={`${providerId}-label`}>Label</Label>
          <Input id={`${providerId}-label`} name="label" placeholder={`${LLM_PROVIDER_LABELS[providerId]} #${accounts.length + 1}`} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${providerId}-value`}>API key</Label>
          <Input id={`${providerId}-value`} name="value" type="password" autoComplete="off" />
        </div>
        <div><SubmitButton variant="outline">Add account</SubmitButton></div>
      </form>
      <ActionFeedback state={addState} />
    </div>
  );
}

function CredentialRow({ name, summary }: { name: CredentialName; summary: CredentialSummary & { updatedAt?: string } }) {
  const [saveState, saveAction] = useActionState(updatePlatformCredential, INITIAL);
  const [removeState, removeAction] = useActionState(removePlatformCredential, INITIAL);
  return (
    <div className="list-enter grid gap-3 rounded-lg border p-4 lg:grid-cols-[minmax(11rem,1fr)_minmax(14rem,1.5fr)_auto] lg:items-end">
      <div className="self-center">
        <p className="font-medium">{CREDENTIAL_LABELS[name]}</p>
        <p className="text-muted-foreground text-xs">
          {summary.configured ? `${summary.maskedPreview} · ${summary.source}` : "Not configured"}
        </p>
      </div>
      <form action={saveAction} className="grid gap-2">
        <input type="hidden" name="credential" value={name} />
        <Label htmlFor={`${name}-value`}>New value</Label>
        <Input id={`${name}-value`} name="value" type="password" autoComplete="off" placeholder="Leave blank to preserve current value" />
        <ActionFeedback state={saveState} />
        <div><SubmitButton>Save</SubmitButton></div>
      </form>
      <div className="flex flex-wrap gap-2">
        <ConnectionTestButton service={CREDENTIAL_SERVICES[name]} />
        {summary.source === "database" ? (
          <form action={removeAction}>
            <input type="hidden" name="credential" value={name} />
            <SubmitButton variant="destructive">Remove</SubmitButton>
          </form>
        ) : null}
      </div>
      <div className="lg:col-span-3"><ActionFeedback state={removeState} /></div>
    </div>
  );
}

type PlatformData = {
  credentials: Record<CredentialName, CredentialSummary & { updatedAt?: string }>;
  llmAccounts: Record<LlmProviderId, LlmAccountView[]>;
  config: PlatformConfigValues;
  checks: Array<{ service: string; status: "passed" | "failed"; latencyMs: number; error: string | null; testedAt: string }>;
  organizations: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; organizationId: string }>;
  bootstrap: Array<{ name: string; configured: boolean }>;
};

function VoiceCopilotCard({ prefs }: { prefs: CopilotVoicePrefs }) {
  const [saveState, saveAction] = useActionState(updateCopilotVoicePrefs, INITIAL);
  const [voiceId, setVoiceId] = useState(prefs.voiceId);
  const [language, setLanguage] = useState(prefs.language);
  const note = prefsPairingNote({ voiceId, language });
  // The copilot provider lives outside this tab: tell it to reload prefs so
  // the next conversation uses the saved voice without a page refresh.
  useEffect(() => {
    if (saveState.ok) window.dispatchEvent(new CustomEvent("voni:voice-prefs-changed"));
  }, [saveState]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice copilot</CardTitle>
        <CardDescription>
          Who talks back when you tap the mic. Only affects your conversations —
          nothing here changes what callers hear on the phone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveAction} className="grid max-w-xl gap-5">
          <div className="grid gap-2">
            <Label htmlFor="copilot-voice">Voice</Label>
            <Select name="voiceId" value={voiceId} onValueChange={(value) => setVoiceId(value ?? prefs.voiceId)}>
              <SelectTrigger id="copilot-voice" className="w-full">
                <SelectValue placeholder="Pick a voice" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ivy">Ivy (default)</SelectItem>
                {voicesByLanguage().map((group) => (
                  <SelectGroup key={group.code}>
                    <SelectLabel>{group.language}</SelectLabel>
                    {group.voices
                      .filter((voice) => voice.id !== "ivy")
                      .map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>
                          {voiceLabel(voice.id)} · {ACCENT_LABEL[voice.accent]}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="copilot-language">Language</Label>
            <Select name="language" value={language} onValueChange={(value) => setLanguage(value ?? prefs.language)}>
              <SelectTrigger id="copilot-language" className="w-full">
                <SelectValue placeholder="Pick a language" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect — understand any language</SelectItem>
                {INPUT_LANGUAGES.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.flag} {lang.label}
                    {lang.canSpeak ? "" : " · understands only"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {inputLanguage(language)?.canSpeak === false
                ? "This language is understood but has no voice yet — the copilot answers in English."
                : "Pinning a language sharpens recognition for it; auto-detect follows whatever you speak."}
            </p>
            {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
          </div>
          <ActionFeedback state={saveState} />
          <div><SubmitButton>Save voice copilot</SubmitButton></div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Single source for the Settings tabs — rendered below and fed to the voice
 * copilot's app manifest, so voice always knows every tab by name.
 */
export const SETTINGS_TABS = [
  { value: "account", label: "Account" },
  { value: "voice", label: "Voice copilot" },
  { value: "workspace", label: "Workspace" },
  { value: "services", label: "Services" },
  { value: "appearance", label: "Appearance" },
  { value: "platform", label: "Platform", adminOnly: true },
] as const;

export function SettingsView({
  user,
  workspace,
  services,
  voicePrefs,
  platform,
}: {
  user: { name: string; email: string; image: string | null };
  workspace: { name: string; timezone: string; humanTransferNumber: string; canEdit: boolean };
  services: Array<{ id: string; label: string; configured: boolean }>;
  voicePrefs: CopilotVoicePrefs;
  platform: PlatformData | null;
}) {
  const [workspaceState, workspaceAction] = useActionState(updateWorkspaceSettings, INITIAL);
  const [platformState, platformAction] = useActionState(updatePlatformConfiguration, INITIAL);
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [activeTab, setActiveTab] = useState("account");
  const visibleTabs = SETTINGS_TABS.filter((tab) => !("adminOnly" in tab) || platform);
  const initials = user.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    const { error } = await signOut();
    if (error) {
      setSigningOut(false);
      toast.error("Could not sign out", {
        description: "Check your connection and try again.",
      });
      return;
    }
    // See app-sidebar.tsx: replace() keeps the signed-in page out of history,
    // refresh() drops the client router cache that still holds it.
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief route="/settings" brief={`Settings. Current tab: ${visibleTabs.find((tab) => tab.value === activeTab)?.label ?? activeTab}. Available tabs: ${visibleTabs.map((tab) => tab.label).join(", ")}. ${services.filter((service) => service.configured).length} of ${services.length} services configured. Workspace edits ${workspace.canEdit ? "allowed" : "disabled"}. Voice and language preferences require confirmed edits and a confirmed save. Credentials must be entered manually.`} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your account, workspace, and service readiness.</p>
      </div>
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="max-w-full justify-start overflow-x-auto" variant="line">
          {visibleTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="account" className="pt-4">
          <Card>
            <CardHeader><CardTitle>Account</CardTitle><CardDescription>Your Google profile and session.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <Avatar size="lg">{user.image ? <AvatarImage src={user.image} alt="" /> : null}<AvatarFallback>{initials || "V"}</AvatarFallback></Avatar>
                <div><p className="font-medium">{user.name}</p><p className="text-muted-foreground text-sm">{user.email}</p></div>
              </div>
              <LoadingButton variant="outline" onClick={handleSignOut} pending={signingOut} pendingText="Signing out…" icon={<LogOut />}>Sign out</LoadingButton>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="voice" className="pt-4">
          <VoiceCopilotCard prefs={voicePrefs} />
        </TabsContent>

        <TabsContent value="workspace" className="pt-4">
          <Card>
            <CardHeader><CardTitle>Workspace</CardTitle><CardDescription>Customer-facing defaults for this organization.</CardDescription></CardHeader>
            <CardContent>
              <form action={workspaceAction} className="grid max-w-xl gap-5">
                <div className="grid gap-2"><Label htmlFor="workspace-name">Workspace name</Label><Input id="workspace-name" name="name" defaultValue={workspace.name} disabled={!workspace.canEdit} /></div>
                <div className="grid gap-2"><Label htmlFor="timezone">Timezone</Label><Input id="timezone" name="timezone" value="Asia/Dubai" readOnly /></div>
                <div className="grid gap-2"><Label htmlFor="transfer-number">Human transfer number</Label><Input id="transfer-number" name="humanTransferNumber" type="tel" defaultValue={workspace.humanTransferNumber} placeholder="+971501234567" disabled={!workspace.canEdit} /><p className="text-muted-foreground text-xs">Used only for this workspace when an agent transfers a live call.</p></div>
                {!workspace.canEdit ? <Alert><ShieldCheck /><AlertTitle>Owner access required</AlertTitle><AlertDescription>Only a workspace owner can change these values.</AlertDescription></Alert> : null}
                <ActionFeedback state={workspaceState} />
                {workspace.canEdit ? <div><SubmitButton>Save workspace</SubmitButton></div> : null}
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="services" className="pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {services.map((service) => (
              <Card key={service.id} className="interactive-card">
                <CardHeader><CardTitle className="flex items-center justify-between gap-3 text-base">{service.label}<Badge variant={service.configured ? "secondary" : "outline"}>{service.configured ? "Ready" : "Needs setup"}</Badge></CardTitle><CardDescription>{service.configured ? "Voni-managed capacity is configured." : "A Voni operator must finish platform setup."}</CardDescription></CardHeader>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="appearance" className="pt-4">
          <Card><CardHeader><CardTitle>Appearance</CardTitle><CardDescription>Use light, dark, or your system setting.</CardDescription></CardHeader><CardContent><ModeToggle /></CardContent></Card>
        </TabsContent>

        {platform ? (
          <TabsContent value="platform" className="space-y-5 pt-4">
            <Alert><KeyRound /><AlertTitle>Operator-only platform settings</AlertTitle><AlertDescription>Database overrides are encrypted. Bootstrap infrastructure remains environment-only.</AlertDescription></Alert>
            <Card>
              <CardHeader><CardTitle>Bootstrap readiness</CardTitle><CardDescription>Required deployment values are shown by name only.</CardDescription></CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                {platform.bootstrap.map((item) => <div key={item.name} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"><span className="font-mono text-xs">{item.name}</span><Badge variant={item.configured ? "secondary" : "outline"}>{item.configured ? "Set" : "Missing"}</Badge></div>)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Credentials</CardTitle><CardDescription>Blank inputs keep the current value. Remove deletes only the database override.</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                {(Object.keys(CREDENTIAL_LABELS) as CredentialName[]).map((name) => <CredentialRow key={name} name={name} summary={platform.credentials[name]} />)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>LLM provider accounts</CardTitle>
                <CardDescription>
                  Several operator-owned accounts can be added per provider. A failing or rate-limited account
                  cools down and is skipped in favor of the next one automatically. Meta always runs first,
                  cannot be configured here, and uses META_API_KEY from .dev.vars locally or a Worker secret
                  in production.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <ManualLlmGuidance />
                </div>
                {(Object.keys(LLM_PROVIDER_LABELS) as LlmProviderId[]).map((providerId) => (
                  <LlmProviderAccounts key={providerId} providerId={providerId} accounts={platform.llmAccounts[providerId]} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Provider and bridge defaults</CardTitle><CardDescription>Temporary bridge selection remains explicit until campaign and number binding replaces it.</CardDescription></CardHeader>
              <CardContent>
                <form action={platformAction} className="grid gap-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    {(["groq", "cerebras", "gemini", "openrouter"] as const).map((provider) => <div key={provider} className="grid gap-2"><Label htmlFor={`${provider}-model`}>{provider[0].toUpperCase() + provider.slice(1)} model</Label><Input id={`${provider}-model`} name={`${provider}Model`} defaultValue={platform.config[`${provider}Model`]} /></div>)}
                  </div>
                  <div className="grid gap-2"><Label htmlFor="llm-order">LLM fallback order</Label><Input id="llm-order" name="llmProviderOrder" defaultValue={platform.config.llmProviderOrder.join(", ")} /><p className="text-muted-foreground text-xs">Use each provider once, separated by commas.</p></div>
                  <div className="grid gap-4 md:grid-cols-2"><div className="grid gap-2"><Label htmlFor="connection-id">Telnyx Call Control connection ID</Label><Input id="connection-id" name="telnyxConnectionId" defaultValue={platform.config.telnyxConnectionId ?? ""} /></div><div className="grid gap-2"><Label htmlFor="caller-number">Default caller number</Label><Input id="caller-number" name="telnyxCallerNumber" type="tel" defaultValue={platform.config.telnyxCallerNumber ?? ""} /></div><div className="grid gap-2"><Label htmlFor="cartesia-voice">Cartesia voice ID</Label><Input id="cartesia-voice" name="cartesiaVoiceId" defaultValue={platform.config.cartesiaVoiceId ?? ""} /></div></div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid gap-2"><Label>Bridge workspace</Label><Select name="bridgeOrganizationId" defaultValue={platform.config.bridgeOrganizationId ?? "none"}><SelectTrigger aria-label="Bridge workspace" className="w-full"><SelectValue placeholder="Select workspace" /></SelectTrigger><SelectContent><SelectItem value="none">Not selected</SelectItem>{platform.organizations.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></div>
                    <div className="grid gap-2"><Label>Saved Voni agent</Label><Select name="bridgeAgentId" defaultValue={platform.config.bridgeAgentId ?? "none"}><SelectTrigger aria-label="Saved Voni agent" className="w-full"><SelectValue placeholder="Select agent" /></SelectTrigger><SelectContent><SelectItem value="none">Not selected</SelectItem>{platform.agents.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></div>
                  </div>
                  <ActionFeedback state={platformState} />
                  <div><SubmitButton>Save platform defaults</SubmitButton></div>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Latest connection tests</CardTitle><CardDescription>Only status, latency, time, and sanitized errors are retained.</CardDescription></CardHeader>
              <CardContent className="space-y-2">
                {platform.checks.length ? platform.checks.map((check) => <div key={check.service} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"><span className="flex items-center gap-2">{check.status === "passed" ? <CheckCircle2 className="size-4" /> : <CircleDot className="size-4" />}<span className="font-medium">{check.service}</span></span><span className="text-muted-foreground">{check.status} · {check.latencyMs} ms · {new Date(check.testedAt).toLocaleString()}</span>{check.error ? <span className="w-full text-destructive">{check.error}</span> : null}</div>) : <p className="text-muted-foreground text-sm">No connection tests yet.</p>}
              </CardContent>
            </Card>
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
