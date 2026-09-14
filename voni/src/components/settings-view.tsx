"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { RouteBrief } from "@/components/copilot/route-brief";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import {
  AlertCircle,
  CheckCircle2,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ModeToggle } from "@/components/mode-toggle";
import { FormCard, FormCardSections } from "@/components/wizard/form-layout";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TIMEZONE_OPTIONS } from "@/lib/timezones";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { signOut } from "@/lib/auth-client";
import {
  ACCENT_LABEL,
  INPUT_LANGUAGES,
  inputLanguage,
  voicesByLanguage,
  voiceLabel,
} from "@/lib/agents/voices";
import { prefsPairingNote, type CopilotVoicePrefs } from "@/lib/copilot/voice-prefs";
import { SETTINGS_TABS } from "@/lib/settings-tabs";
import {
  updateCopilotVoicePrefs,
  updateWorkspaceSettings,
  type SettingsActionState,
} from "@/app/(dashboard)/settings/actions";

const INITIAL: SettingsActionState = { ok: false };

// Single source lives in @/lib/settings-tabs (plain module importable from
// server components); re-exported here so existing import paths keep working.
export { SETTINGS_TABS } from "@/lib/settings-tabs";

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
  name,
  canEdit,
}: {
  name: string;
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
        defaultValue={name}
        disabled={!canEdit}
      />
    </Field>
  );
}

/**
 * Workspace timezone: editable from the named list, defaulting to the
 * stored zone when a legacy value is not in the list. Base UI's Select
 * needs a controlled value, so this mirrors the form-data pattern its
 * sibling voice selects use — with a hidden input carrying the post.
 */
function WorkspaceTimezoneField({
  timezone,
  canEdit,
}: {
  timezone: string;
  canEdit: boolean;
}) {
  const fallback = TIMEZONE_OPTIONS.includes(
    timezone as (typeof TIMEZONE_OPTIONS)[number],
  )
    ? timezone
    : TIMEZONE_OPTIONS[0];
  const [zone, setZone] = useState(fallback);
  return (
    <Field>
      <FieldLabel htmlFor="workspace-timezone">Timezone</FieldLabel>
      <input type="hidden" name="timezone" value={zone} />
      <Select
        value={zone}
        onValueChange={(value) => setZone(value ?? zone)}
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
    <FormCard>
      <FormCardSections>
        <div>
          <h2 className="text-balance font-semibold text-foreground">Voice copilot</h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            Who talks back when you tap the mic. Only affects your conversations —
            nothing here changes what callers hear on the phone.
          </p>
        </div>
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
          <div>
            <Separator />
            <div className="flex items-center justify-end gap-3 pt-4">
              <SubmitButton>Save voice copilot</SubmitButton>
            </div>
          </div>
        </form>
      </FormCardSections>
    </FormCard>
  );
}

/**
 * Settings tabs are sourced from @/lib/settings-tabs (also fed to the voice
 * copilot's app manifest), so voice always knows every tab by name.
 */
export function SettingsView({
  user,
  workspace,
  services,
  voicePrefs,
}: {
  user: { name: string; email: string; image: string | null };
  workspace: {
    name: string;
    timezone: string;
    humanTransferNumber: string;
    canEdit: boolean;
  };
  services: Array<{ id: string; label: string; configured: boolean }>;
  voicePrefs: CopilotVoicePrefs;
}) {
  const [workspaceState, workspaceAction] = useActionState(updateWorkspaceSettings, INITIAL);
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [activeTab, setActiveTab] = useState("account");
  const visibleTabs = SETTINGS_TABS;
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
    <div className="flex flex-col gap-6">
      <RouteBrief route="/settings" brief={`Settings. Current tab: ${visibleTabs.find((tab) => tab.value === activeTab)?.label ?? activeTab}. Available tabs: ${visibleTabs.map((tab) => tab.label).join(", ")}. ${services.filter((service) => service.configured).length} of ${services.length} services configured. Workspace edits ${workspace.canEdit ? "allowed" : "disabled"}. Voice and language preferences require confirmed edits and a confirmed save. Platform credentials are operator-managed outside customer settings.`} />
      {/* Heading lives in the page shell (settings/page.tsx) so it paints
          before data resolves; it is intentionally not duplicated here. */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="max-w-full justify-start overflow-x-auto" variant="line">
          {visibleTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="account" className="pt-4">
          <FormCard>
            <FormCardSections>
              <div>
                <h2 className="text-balance font-semibold text-foreground">Account</h2>
                <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">Your Google profile and session.</p>
              </div>
              <div className="flex max-w-xl flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <Avatar size="lg">{user.image ? <AvatarImage src={user.image} alt="" /> : null}<AvatarFallback>{initials || "V"}</AvatarFallback></Avatar>
                  <div><p className="font-medium">{user.name}</p><p className="text-muted-foreground text-sm">{user.email}</p></div>
                </div>
                <LoadingButton variant="outline" onClick={handleSignOut} pending={signingOut} pendingText="Signing out…" icon={<LogOut />}>Sign out</LoadingButton>
              </div>
            </FormCardSections>
          </FormCard>
        </TabsContent>

        <TabsContent value="voice" className="pt-4">
          <VoiceCopilotCard prefs={voicePrefs} />
        </TabsContent>

        <TabsContent value="workspace" className="pt-4">
          <FormCard>
            <FormCardSections>
              <div>
                <h2 className="text-balance font-semibold text-foreground">Workspace</h2>
                <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">Customer-facing defaults for this organization.</p>
              </div>
              <form action={workspaceAction} className="grid max-w-xl gap-5">
                <FieldGroup>
                  <WorkspaceNameField
                    name={workspace.name}
                    canEdit={workspace.canEdit}
                  />
                  <WorkspaceTimezoneField
                    timezone={workspace.timezone}
                    canEdit={workspace.canEdit}
                  />
                  <Field><FieldLabel htmlFor="transfer-number">Human transfer number</FieldLabel><Input id="transfer-number" name="humanTransferNumber" type="tel" defaultValue={workspace.humanTransferNumber} placeholder="+971501234567" disabled={!workspace.canEdit} /><p className="text-muted-foreground text-xs">Used only for this workspace when an agent transfers a live call.</p></Field>
                </FieldGroup>
                {!workspace.canEdit ? <Alert><ShieldCheck /><AlertTitle>Owner access required</AlertTitle><AlertDescription>Only a workspace owner can change these values.</AlertDescription></Alert> : null}
                <ActionFeedback state={workspaceState} />
                {workspace.canEdit ? (
                  <div>
                    <Separator />
                    <div className="flex items-center justify-end gap-3 pt-4">
                      <SubmitButton>Save workspace</SubmitButton>
                    </div>
                  </div>
                ) : null}
              </form>
            </FormCardSections>
          </FormCard>
        </TabsContent>

        <TabsContent value="services" className="pt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        </TabsContent>

        <TabsContent value="appearance" className="pt-4">
          <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
            <div>
              <h2 className="text-balance font-semibold text-foreground">Appearance</h2>
              <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">Use light, dark, or your system setting.</p>
            </div>
            <div className="sm:max-w-3xl md:col-span-2">
              <ModeToggle />
            </div>
          </div>
        </TabsContent>

      </Tabs>
    </div>
  );
}
