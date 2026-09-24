"use client";

import Link from "next/link";
import {
  useActionState,
  useEffect,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useTheme } from "next-themes";
import { StatusDot } from "@/components/status-dot";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import {
  AlertCircle,
  AudioLines,
  CheckCircle2,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  Phone,
  Plug,
  ShieldCheck,
  Sparkles,
  Sun,
  Unplug,
  Volume2,
} from "lucide-react";
import { SiGmail, SiGoogledocs, SiZoho } from "react-icons/si";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  FormCard,
  FormSection,
  FormSectionHeading,
  FormActions,
  FormSectionSeparator,
} from "@/components/wizard/form-layout";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { overlapLabels, providerToolKey } from "@/lib/providers/registry";
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

function SubmitButton({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "outline" | "destructive" }) {
  const { pending } = useFormStatus();
  return (
    <LoadingButton type="submit" variant={variant} pending={pending}>
      {children}
    </LoadingButton>
  );
}

function CancelLink({ href, dirty }: { href: string; dirty: boolean }) {
  return (
    <Button
      nativeButton={false}
      variant="outline"
      render={
        <Link
          href={href}
          onClick={(e) => {
            if (
              dirty &&
              !window.confirm(
                "Leave without saving? Your entries will be lost.",
              )
            ) {
              e.preventDefault();
            }
          }}
        />
      }
    >
      Cancel
    </Button>
  );
}

function SettingsFormFooter({
  cancelHref,
  dirty,
  children,
}: {
  cancelHref: string;
  dirty: boolean;
  children: React.ReactNode;
}) {
  return (
    <FormActions>
      <CancelLink href={cancelHref} dirty={dirty} />
      {children}
    </FormActions>
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
  invalid,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  canEdit: boolean;
  invalid?: boolean;
  error?: string | null;
}) {
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor="workspace-name">
        Workspace name
      </FieldLabel>
      <Input
        id="workspace-name"
        name="name"
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={!canEdit}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={error ? "workspace-name-error" : undefined}
      />
      {error ? <FieldError id="workspace-name-error">{error}</FieldError> : null}
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

const SERVICE_ICONS: Record<string, LucideIcon> = {
  voice: AudioLines,
  phone: Phone,
  llm: Sparkles,
  "voice-note": Volume2,
};

function ServiceIcon({ id }: { id: string }) {
  const Icon = SERVICE_ICONS[id] ?? Plug;
  return (
    <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-full">
      <Icon aria-hidden className="size-5" />
    </span>
  );
}

function serviceHint(service: ServiceReadiness): string {
  if (service.configured) {
    switch (service.id) {
      case "voice":
        return "Speech-to-text for voice agents is configured.";
      case "phone":
        return "Telnyx connection and caller number are set for inbound and outbound calls.";
      case "llm":
        return "An LLM account is enabled for generation.";
      case "voice-note":
        return "Cartesia voice is set for spoken notes.";
      default:
        return "Platform capacity is configured.";
    }
  }
  switch (service.id) {
    case "voice":
      return "Add an AssemblyAI key so voice agents can talk.";
    case "phone":
      return "Add a Telnyx connection and caller number so numbers can ring.";
    case "llm":
      return "Enable an LLM account so generation can run.";
    case "voice-note":
      return "Add a Cartesia voice so notes can speak.";
    default:
      return "Ask whoever runs your Voni server to finish platform setup.";
  }
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
 * disables the others). Status reads from the Badge; the action reads from
 * the Button — never the same family.
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
              <StatusDot
                tone={connected ? "success" : status === "error" ? "danger" : "neutral"}
                className="text-xs font-normal"
              >
                {connected ? "Connected" : status === "error" ? "Error" : "Not connected"}
              </StatusDot>
            </p>
            <p className="truncate text-pretty text-muted-foreground text-sm">
              {provider.description}
            </p>
          </div>
        </div>
        <ul className="flex flex-col gap-3 border-t pt-4" aria-label={`${provider.label} tools`}>
          {provider.tools.map((tool) => {
            const overlaps = overlapLabels(tool);
            return (
              <li key={providerToolKey(provider.id, tool.id)} className="flex flex-col gap-0.5">
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
    <form action={saveAction} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="copilot-voice">Voice</FieldLabel>
          <Select
            name="voiceId"
            items={{
              ivy: "Ivy (default)",
              ...Object.fromEntries(
                voicesByLanguage().flatMap((group) =>
                  group.voices.map((voice) => [
                    voice.id,
                    `${voiceLabel(voice.id)} · ${ACCENT_LABEL[voice.accent]}`,
                  ]),
                ),
              ),
            }}
            value={voiceId}
            onValueChange={(value) => setVoiceId(value ?? prefs.voiceId)}
          >
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
          <Select
            name="language"
            items={{
              auto: "Auto-detect — understand any language",
              ...Object.fromEntries(
                INPUT_LANGUAGES.map((lang) => [
                  lang.code,
                  `${lang.flag} ${lang.label}${lang.canSpeak ? "" : " · understands only"}`,
                ]),
              ),
            }}
            value={language}
            onValueChange={(value) => setLanguage(value ?? prefs.language)}
          >
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
          <FieldDescription>
            {inputLanguage(language)?.canSpeak === false
              ? "This language is understood but has no voice yet — the copilot answers in English."
              : "Pinning a language sharpens recognition for it; auto-detect follows whatever you speak."}
          </FieldDescription>
          {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
        </Field>
      </FieldGroup>
      <ActionFeedback state={saveState} />
      {saveState.error ? <FieldError>{saveState.error}</FieldError> : null}
      {isDirty ? (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          Unsaved changes — they stay here if you switch sections.
        </p>
      ) : null}
      <SettingsFormFooter cancelHref="/settings" dirty={isDirty}>
        <SubmitButton>Save voice copilot</SubmitButton>
      </SettingsFormFooter>
    </form>
  );
}

/**
 * Route sections: one component per `/settings/<tab>` route (ticket 02).
 * Each renders inside the shared section shell (`[tab]/layout.tsx`) with
 * data from its own server leaf — no shared tab state, so one section's
 * reload never remounts another section's form. Composition converges on the
 * campaign-form density: `FormCard > FormSection + FormSectionHeading`,
 * `FieldGroup + Field + FieldError`, `max-w-*` caps, transparent footers
 * outside any filled body.
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
    <FormCard>
      <FormSection
        aria-labelledby="account-profile-heading"
        heading={
          <FormSectionHeading
            id="account-profile-heading"
            title="Profile"
            description="The Google account you signed in with."
          />
        }
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Avatar size="lg">{user.image ? <AvatarImage src={user.image} alt="" /> : null}<AvatarFallback>{initials || "V"}</AvatarFallback></Avatar>
            <div><p className="font-medium">{user.name}</p><p className="text-muted-foreground text-sm">{user.email}</p></div>
          </div>
        </div>
      </FormSection>
      <FormSectionSeparator />
      <FormSection
        aria-labelledby="account-session-heading"
        heading={
          <FormSectionHeading
            id="account-session-heading"
            title="Session"
            description="Sign out of this browser. Other sessions stay signed in."
          />
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            Signed in as {user.email} via Google.
          </p>
          <div className="flex justify-start">
            <LoadingButton variant="outline" onClick={handleSignOut} pending={signingOut} pendingText="Signing out…" icon={<LogOut data-icon="inline-start" />}>Sign out</LoadingButton>
          </div>
        </div>
      </FormSection>
    </FormCard>
  );
}

export function VoiceSection({ prefs }: { prefs: CopilotVoicePrefs }) {
  return (
    <FormCard>
      <FormSection
        aria-labelledby="voice-copilot-heading"
        heading={
          <FormSectionHeading
            id="voice-copilot-heading"
            title="Voice and language"
            description="Only affects your conversations — nothing here changes what callers hear on the phone."
          />
        }
      >
        <VoiceCopilotCard prefs={prefs} />
      </FormSection>
    </FormCard>
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
  const nameError =
    name.trim().length > 0 && name.trim().length < 2
      ? "Use at least 2 characters."
      : null;
  const transferError =
    transferNumber.trim().length > 0 && !/^\+[1-9]\d{7,14}$/.test(transferNumber.trim())
      ? "Use an E.164 number such as +971501234567."
      : null;
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
    <FormCard>
      <FormSection
        aria-labelledby="workspace-defaults-heading"
        heading={
          <FormSectionHeading
            id="workspace-defaults-heading"
            title="Defaults"
            description="Name, timezone, and the number agents transfer live calls to."
          />
        }
      >
        <form action={workspaceAction} className="flex flex-col gap-6">
          <FieldGroup>
            <WorkspaceNameField
              value={name}
              onChange={setName}
              canEdit={workspace.canEdit}
              invalid={Boolean(nameError)}
              error={nameError}
            />
            <WorkspaceTimezoneField
              value={timezone}
              onChange={setTimezone}
              canEdit={workspace.canEdit}
            />
            <Field data-invalid={Boolean(transferError)}>
              <FieldLabel htmlFor="transfer-number">Human transfer number</FieldLabel>
              <Input
                id="transfer-number"
                name="humanTransferNumber"
                type="tel"
                className="w-full"
                value={transferNumber}
                onChange={(event) => setTransferNumber(event.target.value)}
                placeholder="+971501234567"
                disabled={!workspace.canEdit}
                aria-invalid={transferError ? true : undefined}
                aria-describedby={transferError ? "transfer-number-error" : undefined}
              />
              {transferError ? (
                <FieldError id="transfer-number-error">{transferError}</FieldError>
              ) : null}
              <FieldDescription>Used only for this workspace when an agent transfers a live call.</FieldDescription>
            </Field>
          </FieldGroup>
          {!workspace.canEdit ? <Alert><ShieldCheck /><AlertTitle>Owner access required</AlertTitle><AlertDescription>Only a workspace owner can change these values.</AlertDescription></Alert> : null}
          <ActionFeedback state={workspaceState} />
          {isDirty ? (
            <p aria-live="polite" className="text-muted-foreground text-xs">
              Unsaved changes — they stay here if you switch sections.
            </p>
          ) : null}
          {workspace.canEdit ? (
            <SettingsFormFooter cancelHref="/settings" dirty={isDirty}>
              <SubmitButton>Save workspace</SubmitButton>
            </SettingsFormFooter>
          ) : null}
        </form>
      </FormSection>
    </FormCard>
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
    <FormCard>
      <FormSection
        aria-labelledby="services-providers-heading"
        heading={
          <FormSectionHeading
            id="services-providers-heading"
            title="Providers"
            description="Email, CRM, and docs. Connections are stored server-side for this workspace."
          />
        }
      >
        <ProvidersSection catalog={providerCatalog} connectedIds={connectedProviderIds} />
      </FormSection>
      <FormSectionSeparator />
      <FormSection
        aria-labelledby="services-readiness-heading"
        heading={
          <FormSectionHeading
            id="services-readiness-heading"
            title="Service readiness"
            description="Voni-managed platform capacity. Finished by whoever runs your Voni server."
          />
        }
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {services.map((service) => (
            <Card key={service.id}>
              <CardContent className="flex items-center gap-4 p-4">
                <ServiceIcon id={service.id} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center justify-between gap-3 font-medium">
                    {service.label}
                    <StatusDot
                      tone={service.configured ? "success" : "warning"}
                      className="text-xs font-normal"
                    >
                      {service.configured ? "Ready" : "Needs setup"}
                    </StatusDot>
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {serviceHint(service)}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </FormSection>
    </FormCard>
  );
}

function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  // Theme lives in client storage: render no selection until hydrated rather
  // than announcing the server default as the user's choice.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  return (
    <ToggleGroup
      variant="outline"
      value={mounted && theme ? [theme] : []}
      onValueChange={(values) => {
        const next = Array.isArray(values) ? values[0] : undefined;
        if (next) setTheme(next);
      }}
      aria-label="Theme"
    >
      <ToggleGroupItem value="light">
        <Sun data-icon="inline-start" />
        Light
      </ToggleGroupItem>
      <ToggleGroupItem value="dark">
        <Moon data-icon="inline-start" />
        Dark
      </ToggleGroupItem>
      <ToggleGroupItem value="system">
        <Monitor data-icon="inline-start" />
        System
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function AppearanceSection() {
  return (
    <FormCard>
      <FormSection
        aria-labelledby="appearance-theme-heading"
        heading={
          <FormSectionHeading
            id="appearance-theme-heading"
            title="Theme"
            description="Applies to this browser immediately; no save step."
          />
        }
      >
        <div className="flex flex-col gap-3">
          <ThemeChoice />
          <p className="text-muted-foreground text-sm">
            System follows your OS setting.
          </p>
        </div>
      </FormSection>
    </FormCard>
  );
}
