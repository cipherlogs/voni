"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import {
  AlertCircle,
  CheckCircle2,
  LogOut,
  Plug,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { SiGmail, SiGoogledocs, SiZoho } from "react-icons/si";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ModeToggle } from "@/components/mode-toggle";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TIMEZONE_OPTIONS } from "@/lib/timezones";
import { signOut } from "@/lib/auth-client";
import {
  ACCENT_LABEL,
  INPUT_LANGUAGES,
  inputLanguage,
  voicesByLanguage,
  voiceLabel,
} from "@/lib/agents/voices";
import { prefsPairingNote, type CopilotVoicePrefs } from "@/lib/copilot/voice-prefs";
import type {
  ProviderMeta,
  ProviderId,
} from "@/lib/providers/registry";
import {
  overlapLabels,
  providerToolKey,
} from "@/lib/providers/registry";
import {
  updateCopilotVoicePrefs,
  updateWorkspaceSettings,
  setProviderConnection,
  type SettingsActionState,
} from "@/app/(dashboard)/settings/actions";
import {
  isVoiceDirty,
  isWorkspaceDirty,
  readSettingsDraft,
  settingsDraftKey,
  useBeforeUnloadGuard,
  writeSettingsDraft,
  type VoiceDraft,
  type WorkspaceDraft,
} from "@/components/settings-draft";
import { cn } from "@/lib/utils";

const INITIAL: SettingsActionState = { ok: false };

export interface AccountInfo {
  name: string;
  email: string;
  image: string | null;
}

export interface WorkspaceInfo {
  name: string;
  timezone: string;
  humanTransferNumber: string;
  canEdit: boolean;
}

export interface ServiceReadiness {
  id: string;
  label: string;
  configured: boolean;
}

/**
 * Flat settings section — the form-layout-03 idiom: side h2 + muted
 * description, fields right, no Card backgrounds. Sections are separated by
 * `<Separator className="my-8" />` at the caller.
 */
function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid grid-cols-1 gap-10 md:grid-cols-3", className)}>
      <div>
        <h2 className="text-balance font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
          {description}
        </p>
      </div>
      <div className="sm:max-w-3xl md:col-span-2">{children}</div>
    </section>
  );
}

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

function WorkspaceNameField({
  value,
  onChange,
  canEdit,
}: {
  value: string;
  onChange: (value: string) => void;
  canEdit: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="workspace-name">
        Workspace name
      </FieldLabel>
      <Input
        id="workspace-name"
        name="name"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={!canEdit}
      />
    </Field>
  );
}

/**
 * Workspace timezone: editable from the named list, defaulting to the
 * stored zone when a legacy value is not in the list. Base UI's Select
 * needs a controlled value, so the owning section holds the state and this
 * field mirrors the form-data pattern its sibling voice selects use —
 * with a hidden input carrying the post.
 */
function WorkspaceTimezoneField({
  value,
  onChange,
  canEdit,
}: {
  value: string;
  onChange: (value: string) => void;
  canEdit: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="workspace-timezone">Timezone</FieldLabel>
      <input type="hidden" name="timezone" value={value} />
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
        disabled={!canEdit}
      >
        <SelectTrigger
          id="workspace-timezone"
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {TIMEZONE_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function serviceInitials(label: string) {
  return label.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

const PROVIDER_ICONS: Record<ProviderId, React.ComponentType<{ className?: string }>> = {
  gmail: SiGmail,
  zoho: SiZoho,
  "google-docs": SiGoogledocs,
};

/**
 * Per-provider connection card (grid-list-02 idiom: Avatar + Card rows).
 * The whole card is one atomic unit: header (icon + name + status badge),
 * the tool list it exposes, and its own connect/disconnect form with
 * per-row pending state (`pendingId` pattern — one row's toggle never
 * disables the others).
 */
function ProviderCard({
  provider,
  connected,
  status,
  pending,
  onToggle,
}: {
  provider: ProviderMeta;
  connected: boolean;
  status: "connected" | "error" | null;
  pending: boolean;
  onToggle: (formData: FormData) => void;
}) {
  const Icon = PROVIDER_ICONS[provider.id];
  const [actionState, action] = useActionState(
    async (_previous: SettingsActionState, formData: FormData) => {
      onToggle(formData);
      return INITIAL;
    },
    INITIAL,
  );
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-4">
          <Avatar className="size-10" data-testid={`provider-avatar-${provider.id}`}>
            <AvatarFallback>
              {Icon ? <Icon className="size-5" aria-hidden /> : provider.label.charAt(0)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="flex items-center justify-between gap-3 font-medium">
              {provider.label}
              <Badge variant={connected ? "secondary" : "outline"}>
                {connected ? "Connected" : status === "error" ? "Error" : "Not connected"}
              </Badge>
            </p>
            <p className="truncate text-pretty text-muted-foreground text-sm">
              {provider.description}
            </p>
          </div>
        </div>
        <ul className="flex flex-col gap-2" aria-label={`${provider.label} tools`}>
          {provider.tools.map((tool) => {
            const overlaps = overlapLabels(tool);
            return (
              <li key={providerToolKey(provider.id, tool.id)} className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2">
                <span className="font-medium text-sm">{tool.label}</span>
                <span className="text-muted-foreground text-xs">{tool.description}</span>
                {overlaps.length > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    Also in: {overlaps.join(", ")} — pick one.
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <form action={action} className="flex items-center justify-end gap-3">
          <input type="hidden" name="providerId" value={provider.id} />
          <input type="hidden" name="connected" value={connected ? "false" : "true"} />
          <LoadingButton
            type="submit"
            variant={connected ? "outline" : "default"}
            size="sm"
            pending={pending}
            pendingText={connected ? "Disconnecting…" : "Connecting…"}
            icon={connected ? <Unplug data-icon="inline-start" /> : <Plug data-icon="inline-start" />}
          >
            {connected ? "Disconnect" : "Connect"}
          </LoadingButton>
        </form>
        <ActionFeedback state={actionState} />
      </CardContent>
    </Card>
  );
}

function ProvidersSection({
  catalog,
  connectedIds,
}: {
  catalog: ProviderMeta[];
  connectedIds: string[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const connectedSet = new Set(connectedIds);
  // Optimistic mirror so a toggle reflects instantly and survives reload via
  // the server-provided connectedIds on the next navigation. Credentials never
  // touch localStorage — this is display state only; the DB row is truth.
  const [optimistic, setOptimistic] = useState<Set<string> | null>(null);
  const visible = (id: string) =>
    optimistic ? optimistic.has(id) : connectedSet.has(id);

  function handleToggle(providerId: string, formData: FormData) {
    const next = new FormData();
    formData.forEach((value, key) => next.append(key, value));
    // The card posts `connected` as "should end up connected"; the server
    // action speaks `connect` the same way.
    next.set("connect", String(formData.get("connected") ?? "true"));
    next.delete("connected");
    const wantConnected = next.get("connect") === "true";
    setError(null);
    setPendingId(providerId);
    setOptimistic((prev) => {
      const base = prev ?? connectedSet;
      const copy = new Set(base);
      if (wantConnected) copy.add(providerId);
      else copy.delete(providerId);
      return copy;
    });
    startTransition(async () => {
      try {
        const result = await setProviderConnection(next);
        if (!result.ok) {
          setOptimistic(null);
          // Inline-only: the section Alert below renders this error, so no
          // duplicate toast.
          setError(result.error ?? "Could not update the provider connection.");
        }
      } catch {
        setOptimistic(null);
        setError("Could not update the provider connection.");
      } finally {
        setPendingId(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {catalog.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            connected={visible(provider.id)}
            status={visible(provider.id) ? "connected" : null}
            pending={pendingId === provider.id}
            onToggle={(formData) => handleToggle(provider.id, formData)}
          />
        ))}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function VoiceCopilotCard({ prefs }: { prefs: CopilotVoicePrefs }) {
  const [saveState, saveAction] = useActionState(updateCopilotVoicePrefs, INITIAL);
  const draftKey = settingsDraftKey("voice");
  // Retain unfinished edits across the route split: a draft left in one
  // section restores when the user navigates back, instead of silently
  // discarding. Server props stay authoritative — a corrupt draft reads null.
  const [voiceId, setVoiceId] = useState(
    () => readSettingsDraft<VoiceDraft>(draftKey)?.voiceId ?? prefs.voiceId,
  );
  const [language, setLanguage] = useState(
    () => readSettingsDraft<VoiceDraft>(draftKey)?.language ?? prefs.language,
  );
  const isDirty = isVoiceDirty({ voiceId, language }, prefs);
  useBeforeUnloadGuard(isDirty);
  useEffect(() => {
    writeSettingsDraft(draftKey, isDirty ? { voiceId, language } : null);
  }, [draftKey, isDirty, voiceId, language]);
  const note = prefsPairingNote({ voiceId, language });
  // The copilot provider lives outside this tab: tell it to reload prefs so
  // the next conversation uses the saved voice without a page refresh.
  useEffect(() => {
    if (!saveState.ok) return;
    writeSettingsDraft(draftKey, null);
    window.dispatchEvent(new CustomEvent("voni:voice-prefs-changed"));
  }, [draftKey, saveState]);
  return (
    <form action={saveAction} className="grid gap-5 max-w-xl">
      <Field>
        <FieldLabel htmlFor="copilot-voice">Voice</FieldLabel>
        <Select name="voiceId" value={voiceId} onValueChange={(value) => setVoiceId(value ?? prefs.voiceId)}>
          <SelectTrigger id="copilot-voice" className="w-full">
            <SelectValue placeholder="Pick a voice" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="ivy">Ivy (default)</SelectItem>
            </SelectGroup>
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
      </Field>
      <Field>
        <FieldLabel htmlFor="copilot-language">Language</FieldLabel>
        <Select name="language" value={language} onValueChange={(value) => setLanguage(value ?? prefs.language)}>
          <SelectTrigger id="copilot-language" className="w-full">
            <SelectValue placeholder="Pick a language" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="auto">Auto-detect — understand any language</SelectItem>
              {INPUT_LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  {lang.flag} {lang.label}
                  {lang.canSpeak ? "" : " · understands only"}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {inputLanguage(language)?.canSpeak === false
            ? "This language is understood but has no voice yet — the copilot answers in English."
            : "Pinning a language sharpens recognition for it; auto-detect follows whatever you speak."}
        </p>
        {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      </Field>
      <ActionFeedback state={saveState} />
      {isDirty ? (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          Unsaved changes — they stay here if you switch sections.
        </p>
      ) : null}
      <div>
        <Separator />
        <div className="flex items-center justify-end gap-3 pt-4">
          <SubmitButton>Save voice copilot</SubmitButton>
        </div>
      </div>
    </form>
  );
}

/**
 * Route sections: one component per `/settings/<tab>` route (ticket 02).
 * Each renders inside the shared section shell (`[tab]/layout.tsx`) with
 * data from its own server leaf — no shared tab state, so one section's
 * reload never remounts another section's form.
 *
 * Dirty-form protection (ticket 03) is explicit per form: voice + workspace
 * retain unfinished edits in a per-section draft and warn on reload/close
 * while dirty; account has no editable fields (sign-out only); providers
 * save immediately per toggle (optimistic + server action, nothing to lose);
 * appearance applies immediately via the theme toggle — so the last three
 * carry no draft by design, not by omission.
 */
export function AccountSection({ user }: { user: AccountInfo }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const initials = user.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    const { error } = await signOut();
    if (error) {
      setSigningOut(false);
      toast.add({ type: "error", title: "Could not sign out", description: "Check your connection and try again." });
      return;
    }
    // See app-sidebar.tsx: replace() keeps the signed-in page out of history,
    // refresh() drops the client router cache that still holds it.
    router.replace("/login");
    router.refresh();
  }

  return (
    <SettingsSection
      title="Account"
      description="Your Google profile and session."
    >
      <div className="flex max-w-xl flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Avatar size="lg">{user.image ? <AvatarImage src={user.image} alt="" /> : null}<AvatarFallback>{initials || "V"}</AvatarFallback></Avatar>
          <div><p className="font-medium">{user.name}</p><p className="text-muted-foreground text-sm">{user.email}</p></div>
        </div>
        <LoadingButton variant="outline" onClick={handleSignOut} pending={signingOut} pendingText="Signing out…" icon={<LogOut data-icon="inline-start" />}>Sign out</LoadingButton>
      </div>
    </SettingsSection>
  );
}

export function VoiceSection({ prefs }: { prefs: CopilotVoicePrefs }) {
  return (
    <SettingsSection
      title="Voice copilot"
      description="Who talks back when you tap the mic. Only affects your conversations — nothing here changes what callers hear on the phone."
    >
      <VoiceCopilotCard prefs={prefs} />
    </SettingsSection>
  );
}

export function WorkspaceSection({ workspace }: { workspace: WorkspaceInfo }) {
  const [workspaceState, workspaceAction] = useActionState(updateWorkspaceSettings, INITIAL);
  const draftKey = settingsDraftKey("workspace");
  const coerceZone = (zone: string) =>
    TIMEZONE_OPTIONS.includes(zone as (typeof TIMEZONE_OPTIONS)[number]) ? zone : TIMEZONE_OPTIONS[0];
  const saved: WorkspaceDraft = {
    name: workspace.name,
    timezone: coerceZone(workspace.timezone),
    humanTransferNumber: workspace.humanTransferNumber,
  };
  // Same retain-across-routes contract as the voice form: unfinished edits
  // restore when the user navigates back. Non-owners render disabled fields
  // that can never go dirty, so no draft is ever written for them. A stale
  // draft outside the zone list falls back the same way a legacy saved value
  // does, so the Select always holds a listed value.
  const [name, setName] = useState(() => readSettingsDraft<WorkspaceDraft>(draftKey)?.name ?? saved.name);
  const [timezone, setTimezone] = useState(() => {
    const draftZone = readSettingsDraft<WorkspaceDraft>(draftKey)?.timezone;
    return draftZone ? coerceZone(draftZone) : saved.timezone;
  });
  const [transferNumber, setTransferNumber] = useState(
    () => readSettingsDraft<WorkspaceDraft>(draftKey)?.humanTransferNumber ?? saved.humanTransferNumber,
  );
  const isDirty =
    workspace.canEdit && isWorkspaceDirty({ name, timezone, humanTransferNumber: transferNumber }, saved);
  useBeforeUnloadGuard(isDirty);
  useEffect(() => {
    if (!workspace.canEdit) return;
    writeSettingsDraft(
      draftKey,
      isDirty ? { name, timezone, humanTransferNumber: transferNumber } : null,
    );
  }, [draftKey, isDirty, name, timezone, transferNumber, workspace.canEdit]);
  useEffect(() => {
    if (workspaceState.ok) writeSettingsDraft(draftKey, null);
  }, [draftKey, workspaceState]);
  return (
    <SettingsSection
      title="Workspace"
      description="Customer-facing defaults for this organization."
    >
      <form action={workspaceAction} className="grid max-w-xl gap-5">
        <FieldGroup>
          <WorkspaceNameField
            value={name}
            onChange={setName}
            canEdit={workspace.canEdit}
          />
          <WorkspaceTimezoneField
            value={timezone}
            onChange={setTimezone}
            canEdit={workspace.canEdit}
          />
          <Field><FieldLabel htmlFor="transfer-number">Human transfer number</FieldLabel><Input id="transfer-number" name="humanTransferNumber" type="tel" value={transferNumber} onChange={(event) => setTransferNumber(event.target.value)} placeholder="+971501234567" disabled={!workspace.canEdit} /><p className="text-muted-foreground text-xs">Used only for this workspace when an agent transfers a live call.</p></Field>
        </FieldGroup>
        {!workspace.canEdit ? <Alert><ShieldCheck /><AlertTitle>Owner access required</AlertTitle><AlertDescription>Only a workspace owner can change these values.</AlertDescription></Alert> : null}
        <ActionFeedback state={workspaceState} />
        {isDirty ? (
          <p aria-live="polite" className="text-muted-foreground text-xs">
            Unsaved changes — they stay here if you switch sections.
          </p>
        ) : null}
        {workspace.canEdit ? (
          <div>
            <Separator />
            <div className="flex items-center justify-end gap-3 pt-4">
              <SubmitButton>Save workspace</SubmitButton>
            </div>
          </div>
        ) : null}
      </form>
    </SettingsSection>
  );
}

export function ServicesSection({
  services,
  providerCatalog,
  connectedProviderIds,
}: {
  services: ServiceReadiness[];
  providerCatalog: ProviderMeta[];
  connectedProviderIds: string[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title="Providers"
        description="Connect the tools your agents can use — email, CRM, and docs. Connections are stored server-side for this workspace."
      >
        <ProvidersSection catalog={providerCatalog} connectedIds={connectedProviderIds} />
      </SettingsSection>
      <Separator className="my-8" />
      <SettingsSection
        title="Service readiness"
        description="Voni-managed platform capacity. Finished by whoever runs your Voni server."
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {services.map((service) => (
            <Card key={service.id}>
              <CardContent className="flex items-center gap-4 p-4">
                <Avatar className="size-10">
                  <AvatarFallback>{serviceInitials(service.label)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center justify-between gap-3 font-medium">
                    {service.label}
                    <Badge variant={service.configured ? "secondary" : "outline"}>
                      {service.configured ? "Ready" : "Needs setup"}
                    </Badge>
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {service.configured
                      ? "Voni-managed capacity is configured."
                      : "Ask your workspace admin, or whoever runs " +
                        "your Voni server, to finish platform setup."}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}

export function AppearanceSection() {
  return (
    <SettingsSection
      title="Appearance"
      description="Use light, dark, or your system setting."
    >
      <ModeToggle />
    </SettingsSection>
  );
}
