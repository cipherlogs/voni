"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CHANNELS,
  TOOL_REGISTRY,
  type AgentConfig,
  type CustomTool,
  type DetectField,
  type ToolIdea,
} from "@/lib/agents/config";
import { CREDENTIAL_NAMES, type CredentialName } from "@/lib/platform/types";
import {
  voicesByLanguage,
  INPUT_LANGUAGES,
  ACCENT_LABEL,
  voiceLabel,
  inputLanguage,
  type Voice,
} from "@/lib/agents/voices";

/**
 * The editable config form, rebuilt against the approved
 * approved single-column detail layout: four cards (Identity / Mission /
 * Conversation / Tools and channels) and a composed footer bar.
 *
 * The previous version exposed roughly sixty controls — every field the
 * compiler could produce, on the theory that a generated config is a draft
 * that may need heavy editing. In practice that buried the handful of
 * settings anyone actually changes. The schema was cut to match
 * (`src/lib/agents/config.ts`), so what is left here is the whole config
 * surface, not a filtered view of it.
 */

/**
 * Form density follows the campaign/new reference (DESIGN.md §4): base `h-8`
 * controls from `ui/` with width caps only — no per-form geometry overrides.
 * `Field`/`FieldLabel`/`FieldDescription` supply the label, gap, and hint
 * sizing; sections stack at `gap-3`.
 */

/**
 * Add-custom-tool composer: name + description + mode + webhook URL +
 * optional credential picker. Emits a CustomTool on valid submit and clears.
 * A blank URL drafts nothing — the row stays local until it can execute.
 */
function AddCustomToolForm({
  existingIds,
  onAdd,
}: {
  existingIds: Set<string>;
  onAdd: (tool: CustomTool) => void;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<CustomTool["mode"]>("interactive");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState<string | null>(null);

  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
  const duplicate = slug.length > 0 && existingIds.has(slug);
  const parsedUrl = (() => {
    try {
      return url.trim() ? new URL(url.trim()) : null;
    } catch {
      return null;
    }
  })();
  const urlInvalid = url.trim().length > 0 && !parsedUrl;
  const canAdd =
    label.trim().length > 0 &&
    description.trim().length > 0 &&
    parsedUrl !== null &&
    !duplicate;

  return (
    <Field>
      <FieldLabel>Add custom tool</FieldLabel>
      <div className="flex flex-col gap-3 rounded-[10px] border px-3 py-2.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="custom-tool-label">Name</FieldLabel>
            <Input
              id="custom-tool-label"
              className="max-w-md"
              value={label}
              placeholder="Check order status"
              onChange={(e) => {
                setLabel(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="custom-tool-mode">Waits for result</FieldLabel>
            <Select
              items={{ interactive: "No — talks over it", hold: "Yes — waits" }}
              value={mode}
              onValueChange={(value) =>
                setMode(value === "hold" ? "hold" : "interactive")
              }
            >
              <SelectTrigger id="custom-tool-mode" aria-label="Waits for result">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="interactive">No — talks over it</SelectItem>
                  <SelectItem value="hold">Yes — waits</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="custom-tool-description">What it does</FieldLabel>
          <Textarea
            id="custom-tool-description"
            className="min-h-[76px] resize-y [field-sizing:fixed]"
            value={description}
            placeholder="Looks up the caller's latest order by phone number."
            onChange={(e) => {
              setDescription(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field data-invalid={urlInvalid}>
            <FieldLabel htmlFor="custom-tool-url">Webhook URL</FieldLabel>
            <Input
              id="custom-tool-url"
              inputMode="url"
              className="max-w-md"
              value={url}
              placeholder="https://example.com/tools/order-status"
              aria-invalid={urlInvalid || undefined}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="custom-tool-credential">
              Credential (optional)
            </FieldLabel>
            <Select
              items={{
                "": "None",
                ...Object.fromEntries(
                  CREDENTIAL_NAMES.map((name) => [name, name]),
                ),
              }}
              value={credential}
              onValueChange={(value) => setCredential(String(value ?? ""))}
            >
              <SelectTrigger
                id="custom-tool-credential"
                aria-label="Credential"
              >
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">None</SelectItem>
                  {CREDENTIAL_NAMES.map((name: CredentialName) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {duplicate ? (
          <FieldError className="text-xs">
            A tool with this name already exists — rename it.
          </FieldError>
        ) : null}
        {urlInvalid ? (
          <FieldError className="text-xs">
            Enter a valid https URL for the webhook.
          </FieldError>
        ) : null}
        {error ? <FieldError className="text-xs">{error}</FieldError> : null}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canAdd}
            onClick={() => {
              if (!parsedUrl) {
                setError("Enter a valid https URL for the webhook.");
                return;
              }
              if (parsedUrl.protocol !== "https:") {
                setError("Custom tool webhooks must use https.");
                return;
              }
              onAdd({
                id: slug || `custom_${Date.now().toString(36)}`,
                label: label.trim(),
                description: description.trim(),
                mode,
                kind: "webhook",
                url: parsedUrl.toString(),
                ...(credential ? { authCredentialName: credential } : {}),
              });
              setLabel("");
              setDescription("");
              setUrl("");
              setMode("interactive");
              setCredential("");
              setError(null);
            }}
          >
            Add custom tool
          </Button>
        </div>
      </div>
      <FieldDescription>
        Calls your URL with the tool arguments as JSON. The bearer credential
        is sent as an Authorization header when set.
      </FieldDescription>
    </Field>
  );
}

/** `languageCodes: []` — automatic detection across all 18 recognised
 *  languages, which the docs recommend for a mixed-language line. Carried as
 *  its own option because "unset" is more capable here than a pinned list,
 *  not less, and a select with no empty choice would quietly remove it. */
const AUTO_LANGUAGE = "__auto__";

/**
 * Per-row pacing picker (Base UI resolves the closed trigger's text from
 * `items`): one control per detect row. The Checkbox enables the row; this
 * picker chooses how the agent asks — never a second toggle beside the first.
 */
const PACE_ITEMS = {
  normal: "Ask normally",
  slow: "Read back slowly",
} as const;

/**
 * Channel rows in the Tools-and-channels card, matching the mockup's
 * `.switchrow` rows (title + description on the left, Switch on the right).
 */
const CHANNEL_META = [
  {
    value: "phone",
    title: "Phone calls",
    description: "Inbound and test calls in the browser.",
  },
  {
    value: "whatsapp",
    title: "WhatsApp",
    description: "Follow-ups and viewing confirmations.",
  },
] as const;

/**
 * Form footer (form-layout-01 terminal bar idiom): a Separator plus a
 * right-aligned action row following the house rule — secondary actions left,
 * primary save right — matching WizardFooter's secondary-left/primary-right
 * layout (`justify-between` with both slots, `justify-end` when there is no
 * secondary).
 *
 * The footer is normal document flow everywhere — the bar renders inline
 * after the last card on all screen sizes, never fixed or sticky.
 */
export function ConfigFormFooter({
  secondary,
  primary,
  className,
}: {
  secondary?: ReactNode;
  primary: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Separator />
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 pt-4",
          secondary ? "justify-between" : "justify-end",
        )}
      >
        {secondary ? (
          <span className="flex min-w-0 flex-wrap items-center gap-3">
            {secondary}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-3">
          {primary}
        </span>
      </div>
    </div>
  );
}

export function AgentConfigForm({
  initialName,
  initialConfig,
  submitLabel,
  onSubmit,
  onChange,
  isDirty = false,
  footerSecondary,
  footerPrimaryActions,
  phoneReady,
  whatsappReady,
}: {
  initialName: string;
  initialConfig: AgentConfig;
  submitLabel: string;
  onSubmit: (name: string, config: AgentConfig) => Promise<void>;
  /** Fires on every edit, so a live test call can use the unsaved config. Name is included so a live test call can mirror unsaved name edits. */
  onChange?: (config: AgentConfig, name: string) => void;
  /**
   * Channel integration state, derived server-side from platform config +
   * credentials. Null means unknown (link to setup rather than claim
   * readiness). Kept optional so the creation-review screen renders without
   * a server round trip — omission falls back to the toggle-only rows.
   */
  phoneReady?: boolean | null;
  whatsappReady?: boolean | null;
  /**
   * Whether there are unsaved edits, for the footer's "• Unsaved changes"
   * marker. Deliberately a prop rather than derived here: the host page
   * already computes this from its own last-saved snapshot and feeds the same
   * value to the test rail's version strip. Two independent computations
   * would drift, and the footer chip and the rail pill would then contradict
   * each other on one screen.
   */
  isDirty?: boolean;
  /** Optional secondary action rendered left of the primary save (e.g. Delete). */
  footerSecondary?: ReactNode;
  /** Optional actions composed immediately before Save (e.g. Test agent). */
  footerPrimaryActions?: ReactNode;
}) {
  const [name, setName] = useState(initialName);
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [saving, setSaving] = useState(false);

  /**
   * Every detail this agent has ever been configured to detect, seeded once
   * from the incoming config. Unchecking a row removes the field from
   * `config.detect`; the full set stays here so re-checking restores it (with
   * its description and pacing flag) in its original position rather than
   * losing it on the first misclick. There is no add-a-field UI any more, so
   * this set is fixed for the life of the form.
   */
  const [knownDetect, setKnownDetect] = useState<DetectField[]>(
    () => initialConfig.detect,
  );
  const selectedDetect = useMemo(
    () => new Set(config.detect.map((d) => d.key)),
    [config.detect],
  );

  /**
   * Base UI resolves a select trigger's text from `items`, not from the
   * `SelectItem` children — without these maps the closed trigger shows the
   * raw stored value (`en`, `vera`) instead of a label.
   */
  const languageItems = useMemo<Record<string, string>>(
    () => ({
      [AUTO_LANGUAGE]: "Automatic (detects 18 languages)",
      ...Object.fromEntries(
        INPUT_LANGUAGES.map((lang) => [
          lang.code,
          `${lang.label}${lang.canSpeak ? "" : " · understands only"}`,
        ]),
      ),
    }),
    [],
  );
  const voiceItems = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        voicesByLanguage().flatMap((group) =>
          group.voices.map((voice) => [
            voice.id,
            `${voiceLabel(voice.id)} — ${ACCENT_LABEL[voice.accent]}`,
          ]),
        ),
      ),
    [],
  );

  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  // In an effect, not inside `set`: notifying a parent during render is a
  // React error, and this way it also fires for the initial config.
  useEffect(() => {
    onChange?.(config, name);
  }, [config, name, onChange]);

  /** The agent name is one field now: it names the record *and* is what the
   *  agent says on the call. Two inputs for the same idea was the single
   *  most confusing thing on this screen. */
  const setAgentName = (next: string) => {
    setName(next);
    setConfig((c) => ({ ...c, identity: { ...c.identity, name: next } }));
  };

  const toggleDetect = (key: string, checked: boolean) => {
    const next = new Set(selectedDetect);
    if (checked) next.add(key);
    else next.delete(key);
    // Re-checking restores the field from the known set below, pacing flag
    // included — an uncheck/recheck round-trip never drops it.
    set(
      "detect",
      knownDetect.filter((f) => next.has(f.key)),
    );
  };

  /**
   * Row-level pacing toggle: marks a detect field `sensitive` so the voice
   * agent slows down and captures it digit-by-digit ("spoken as a sequence").
   * The compiler only emits the `prepare_sensitive_capture` pacing instruction
   * for flagged fields, so an unflagged field keeps the plain ask. Written to
   * both the live config and the known set — unchecking a row then re-checking
   * it restores the field from the known set, so the pacing choice must ride
   * along or the round-trip silently drops it.
   */
  const toggleDetectSensitive = (key: string, sensitive: boolean) => {
    setKnownDetect((known) =>
      known.map((f) => (f.key === key ? { ...f, sensitive } : f)),
    );
    set(
      "detect",
      config.detect.map((f) => (f.key === key ? { ...f, sensitive } : f)),
    );
  };

  const toggleChannel = (channel: (typeof CHANNELS)[number]) => {
    const next = config.channels.includes(channel)
      ? config.channels.filter((c) => c !== channel)
      : [...config.channels, channel];
    // At least one channel must stay selected — an agent with none can never
    // be dispatched. Deselecting the last one is ignored.
    if (next.length === 0) return;
    set("channels", next);
  };

  const toggleTool = (toolName: string, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...config.tools, toolName])]
      : config.tools.filter((t) => t !== toolName);
    set("tools", next);
  };

  const dismissIdea = (ideaName: string) => {
    set(
      "toolIdeas",
      (config.toolIdeas ?? []).filter((idea) => idea.name !== ideaName),
    );
  };

  const enableIdea = (idea: ToolIdea) => {
    // A matching built-in wins over a new custom row: one enabled name
    // instead of a duplicate webhook that does the same job.
    const match = TOOL_REGISTRY.find(
      (t) =>
        t.name === idea.name ||
        t.name.includes(idea.name) ||
        idea.name.includes(t.name),
    );
    if (match) toggleTool(match.name, true);
    else {
      // No wall-clock fallback: an un-sluggable idea name rejects at the
      // schema layer instead of minting a random id mid-render.
      const id = idea.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 60);
      if (!id) return;
      addCustomTool({
        id,
        label: idea.label,
        description: idea.description,
        mode: "interactive",
        kind: "webhook",
        url: "",
      });
    }
    dismissIdea(idea.name);
  };

  const addCustomTool = (tool: CustomTool) => {
    if ((config.customTools ?? []).some((t) => t.id === tool.id)) return;
    set("customTools", [...(config.customTools ?? []), tool]);
  };

  const removeCustomTool = (id: string) => {
    set("customTools", (config.customTools ?? []).filter((t) => t.id !== id));
  };

  const agentLabel = name.trim() || "this agent";
  // A config can legitimately pin several recognition languages even though
  // this select writes one at a time. Surface the rest rather than letting the
  // trigger imply the others are gone.
  const extraLanguages = config.languageCodes
    .slice(1)
    .map((code) => inputLanguage(code)?.label ?? code);

  return (
    <div className="flex flex-col gap-3">
      <section aria-labelledby="config-identity-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="config-identity-heading" className="text-balance font-semibold text-foreground">
            Identity
          </h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            Name, voice, and language callers hear.
          </p>
        </div>
          <Card className="rounded-xl border">
            <CardContent className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="agent-name">
              Agent name
            </FieldLabel>
            <Input
              id="agent-name"
              className="max-w-md"
              value={name}
              placeholder="Vera"
              data-invalid={!name.trim() || undefined}
              aria-invalid={!name.trim() || undefined}
              onChange={(e) => setAgentName(e.target.value)}
            />
          </Field>

          <div className="grid gap-3 lg:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="identity-role">
                Role
              </FieldLabel>
              <Input
                id="identity-role"
                className="max-w-md"
                value={config.identity.role}
                placeholder="Property viewing coordinator"
                data-invalid={!config.identity.role.trim() || undefined}
                aria-invalid={!config.identity.role.trim() || undefined}
                onChange={(e) =>
                  set("identity", { ...config.identity, role: e.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-language">
                Language
              </FieldLabel>
              <Select
                items={languageItems}
                value={
                  config.languageCodes.length === 0
                    ? AUTO_LANGUAGE
                    : config.languageCodes[0]
                }
                onValueChange={(value) =>
                  set(
                    "languageCodes",
                    !value || value === AUTO_LANGUAGE ? [] : [String(value)],
                  )
                }
              >
                <SelectTrigger
                  id="agent-language"
                  aria-label="Language"
                  className="w-full max-w-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={AUTO_LANGUAGE}>
                      Automatic (detects 18 languages)
                    </SelectItem>
                    {INPUT_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.label}
                        {lang.canSpeak ? null : (
                          <span className="opacity-60">understands only</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {extraLanguages.length > 0 ? (
                <FieldDescription>
                  Also pinned: {extraLanguages.join(", ")}. Choosing a language
                  here replaces the whole list.
                </FieldDescription>
              ) : null}
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="agent-voice">
              Voice
            </FieldLabel>
            <Select
              items={voiceItems}
              value={config.voiceId}
              // A voice is required — ignore a clear.
              onValueChange={(value) => {
                if (value) set("voiceId", String(value));
              }}
            >
              <SelectTrigger id="agent-voice" aria-label="Voice" className="w-full max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Grouped by the language each voice speaks: the catalog is
                    closed and six-deep, and a flat list hides which voices can
                    answer a Spanish or German caller at all. */}
                {voicesByLanguage().map((group) => (
                  <SelectGroup key={group.language}>
                    <SelectLabel>{group.language}</SelectLabel>
                    {group.voices.map((voice: Voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voiceLabel(voice.id)}
                        <span className="opacity-60">
                          {ACCENT_LABEL[voice.accent]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Switching voice starts a fresh session. The current test call ends
              and a new one begins in the new voice.
            </FieldDescription>
          </Field>
            </CardContent>
          </Card>
      </section>

      <Separator />
      <section aria-labelledby="config-mission-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="config-mission-heading" className="text-balance font-semibold text-foreground">
            Mission
          </h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            What {agentLabel} is trying to accomplish on every call.
          </p>
        </div>
          <Card className="rounded-xl border">
            <CardContent className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="mission">
              Mission statement
            </FieldLabel>
            <Textarea
              id="mission"
              className="min-h-[76px] resize-y [field-sizing:fixed]"
              value={config.mission}
              placeholder="Qualify inbound property inquiries and book viewings"
              data-invalid={!config.mission.trim() || undefined}
              aria-invalid={!config.mission.trim() || undefined}
              onChange={(e) => set("mission", e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="greeting">
              Greeting
            </FieldLabel>
            <Input
              id="greeting"
              value={config.greeting}
              placeholder="Hi, this is Vera. How can I help you today?"
              data-invalid={!config.greeting.trim() || undefined}
              aria-invalid={!config.greeting.trim() || undefined}
              onChange={(e) => set("greeting", e.target.value)}
            />
          </Field>
          <p className="rounded-[10px] border border-border bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
            Suggested first line to test: “Hi, I&apos;m looking for a 2-bedroom
            near Riverside under $2,400.”
          </p>
            </CardContent>
          </Card>
      </section>

      <Separator />
      {/* Detect rows retain the form-layout-03 settings-row idiom. */}
      <section aria-labelledby="config-conversation-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="config-conversation-heading" className="text-balance font-semibold text-foreground">
            Conversation
          </h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            Details {agentLabel} listens for before booking.
          </p>
        </div>
          <Card className="rounded-xl border">
            <CardContent className="flex flex-col gap-3">
          <Field>
            <FieldLabel>Detect and remember</FieldLabel>
            <div className="flex flex-col gap-2">
              {knownDetect.map((field, i) => {
                const id = `detect-${field.key || i}`;
                const paceId = `detect-pace-${field.key || i}`;
                const selected = selectedDetect.has(field.key);
                const fieldSensitive = config.detect.some(
                  (d) => d.key === field.key && d.sensitive,
                );
                return (
                  <div
                    key={field.key || i}
                    className="flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <Checkbox
                        id={id}
                        checked={selected}
                        onCheckedChange={(checked: boolean) =>
                          toggleDetect(field.key, checked)
                        }
                      />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <FieldLabel
                          htmlFor={id}
                          className="cursor-pointer text-sm font-medium"
                        >
                          {field.label}
                        </FieldLabel>
                        {field.description ? (
                          <FieldDescription className="text-xs">
                            {field.description}
                          </FieldDescription>
                        ) : null}
                      </div>
                    </div>
                    <Select
                      items={PACE_ITEMS}
                      value={selected && fieldSensitive ? "slow" : "normal"}
                      disabled={!selected}
                      onValueChange={(value) =>
                        toggleDetectSensitive(field.key, value === "slow")
                      }
                    >
                      <SelectTrigger
                        id={paceId}
                        aria-label={
                          fieldSensitive
                            ? `Turn off slow read-back for ${field.label}`
                            : `Turn on slow read-back for ${field.label}`
                        }
                        title={
                          fieldSensitive
                            ? `Read back slowly for ${field.label} is on — the agent spells it out digit by digit`
                            : `Read back slowly for ${field.label} is off`
                        }
                        size="sm"
                        className="w-40"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="normal">Ask normally</SelectItem>
                          <SelectItem value="slow">Read back slowly</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
            <FieldDescription>
              Unchecked details are still answered if the caller mentions them,
              but {agentLabel} won&apos;t ask for them. “Read back slowly”
              marks a field the agent spells out digit by digit — phone
              numbers, emails, and other details the caller spells out.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="knowledge">
              House rules
            </FieldLabel>
            <Textarea
              id="knowledge"
              className="min-h-[76px] resize-y [field-sizing:fixed]"
              value={config.knowledge}
              placeholder="Never quote fees you can't verify."
              onChange={(e) => set("knowledge", e.target.value)}
            />
          </Field>
            </CardContent>
          </Card>
      </section>

      <Separator />
      {/* Tool and channel rows retain the form-layout-03 settings-row idiom. */}
      <section aria-labelledby="config-tools-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="config-tools-heading" className="text-balance font-semibold text-foreground">
            Tools and channels
          </h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            What {agentLabel} can do, and where it answers.
          </p>
        </div>
          <Card className="rounded-xl border">
            <CardContent className="flex flex-col gap-3">
          {/* Suggested for this agent: LLM tool ideas from the wizard brief.
              Enabling maps to the nearest built-in when one matches, or
              drafts a custom webhook row below; dismissing drops the card. */}
          {(config.toolIdeas ?? []).length > 0 ? (
            <Field>
              <FieldLabel>Suggested for this agent</FieldLabel>
              <div className="flex flex-col gap-2">
                {(config.toolIdeas ?? []).map((idea) => (
                  <div
                    key={idea.name}
                    className="flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <strong className="text-sm font-medium">
                        {idea.label}
                      </strong>
                      <span className="text-xs text-muted-foreground">
                        {idea.description}
                      </span>
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => enableIdea(idea)}
                      >
                        Enable
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => dismissIdea(idea.name)}
                      >
                        Dismiss
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            </Field>
          ) : null}

          {/* Connected tools: one enable checkbox per row plus the hold-mode
              badge as information. Unchecking removes the tool from the
              config — re-enabling below restores it. */}
          <Field>
            <FieldLabel>Connected tools</FieldLabel>
            <div className="flex flex-col gap-2">
              {TOOL_REGISTRY.map((tool) => {
                const enabled = config.tools.includes(tool.name);
                const id = `tool-${tool.name}`;
                return (
                  <div
                    key={tool.name}
                    className="flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <Checkbox
                        id={id}
                        checked={enabled}
                        onCheckedChange={(checked: boolean) =>
                          toggleTool(tool.name, checked)
                        }
                      />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <FieldLabel
                          htmlFor={id}
                          className="cursor-pointer text-sm font-medium"
                        >
                          {tool.name}
                        </FieldLabel>
                        <FieldDescription className="text-xs">
                          {tool.description}
                        </FieldDescription>
                      </div>
                    </div>
                    {tool.mode === "hold" ? (
                      <Badge variant="secondary" className="whitespace-nowrap">
                        waits for result
                      </Badge>
                    ) : null}
                  </div>
                );
              })}
              {(config.customTools ?? []).map((tool) => (
                <div
                  key={tool.id}
                  className="flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <strong className="text-sm font-medium">
                      {tool.label}
                    </strong>
                    <span className="text-xs text-muted-foreground">
                      {tool.description}
                    </span>
                  </div>
                  <span className="flex shrink-0 items-center gap-2">
                    {tool.mode === "hold" ? (
                      <Badge variant="secondary" className="whitespace-nowrap">
                        waits for result
                      </Badge>
                    ) : null}
                    <Badge variant="outline" className="whitespace-nowrap">
                      custom
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeCustomTool(tool.id)}
                    >
                      Disconnect
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </Field>

          <AddCustomToolForm
            existingIds={new Set([
              ...TOOL_REGISTRY.map((t) => t.name),
              ...(config.customTools ?? []).map((t) => t.id),
            ])}
            onAdd={addCustomTool}
          />

          {CHANNEL_META.map((channel) => {
            const id = `channel-${channel.value}`;
            const enabled = config.channels.includes(channel.value);
            const ready =
              channel.value === "phone" ? phoneReady : whatsappReady;
            return (
              <div
                key={channel.value}
                className="flex items-center justify-between gap-3 border-t pt-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <FieldLabel htmlFor={id} className="text-sm font-medium">
                    {channel.title}
                  </FieldLabel>
                  <FieldDescription className="text-xs">
                    {ready === false
                      ? `${channel.description} Needs setup — connect it before this channel can answer.`
                      : channel.description}
                  </FieldDescription>
                  {ready === false ? (
                    <span className="flex flex-wrap items-center gap-2 pt-1">
                      <Badge variant="secondary">Needs setup</Badge>
                      <Link
                        href={
                          channel.value === "phone" ? "/numbers" : "/settings"
                        }
                        className="text-xs underline underline-offset-4"
                      >
                        {channel.value === "phone"
                          ? "Connect a number"
                          : "Open settings"}
                      </Link>
                    </span>
                  ) : null}
                </div>
                <Switch
                  id={id}
                  checked={enabled}
                  onCheckedChange={() => toggleChannel(channel.value)}
                />
              </div>
            );
          })}
            </CardContent>
          </Card>
      </section>

      <ConfigFormFooter
        secondary={footerSecondary}
        primary={
          <>
            {footerPrimaryActions}
            <LoadingButton
              disabled={!name.trim()}
              pending={saving}
              pendingText="Saving…"
              onClick={async () => {
                setSaving(true);
                try {
                  await onSubmit(name, config);
                } catch (error) {
                  toast.add({
                    type: "error",
                    title: "Could not save",
                    description:
                      error instanceof Error
                        ? error.message
                        : "Check your connection and try again.",
                  });
                } finally {
                  setSaving(false);
                }
              }}
            >
              {submitLabel}
            </LoadingButton>
            {isDirty ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full bg-chart-2"
                />
                Unsaved changes
              </span>
            ) : null}
          </>
        }
      />
    </div>
  );
}
