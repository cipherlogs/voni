"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
  type DetectField,
} from "@/lib/agents/config";
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
 * `.impeccable/mockups/agents-id-b-split.html` mockup: four cards
 * (Identity / Mission / Conversation / Tools and channels) and a footer bar.
 *
 * The previous version exposed roughly sixty controls — every field the
 * compiler could produce, on the theory that a generated config is a draft
 * that may need heavy editing. In practice that buried the handful of
 * settings anyone actually changes. The schema was cut to match
 * (`src/lib/agents/config.ts`), so what is left here is the whole config
 * surface, not a filtered view of it.
 */

/** Shared control geometry: phones get shadcn `h-8`-equivalent sizing with
 * `text-base` (keeps iOS no-zoom behavior); 42px restores at `md:`. */
const CONTROL = "w-full rounded-[10px] px-3 py-2 text-base md:min-h-[42px] md:py-2.5 md:text-sm";
// Border-only elevation (house border-OR-shadow floor): the mockup's ambient
// shadow lives on the edit-agent statusline, not on form cards or footers.
const CARD = "gap-3.5 rounded-xl border pt-4 pb-[18px]";
const CARD_HEAD = "px-[18px]";
const CARD_BODY = "flex flex-col gap-3 px-[18px]";
const LABEL = "text-[13px] font-semibold";
const HINT = "mt-1.5 text-xs";

/** `languageCodes: []` — automatic detection across all 18 recognised
 *  languages, which the docs recommend for a mixed-language line. Carried as
 *  its own option because "unset" is more capable here than a pinned list,
 *  not less, and a select with no empty choice would quietly remove it. */
const AUTO_LANGUAGE = "__auto__";

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
 * Form footer (the mockup's `.footer-actions`): a bordered bar following the
 * house rule — secondary actions left, primary save right — matching
 * WizardFooter's secondary-left/primary-right layout (`justify-between` with
 * both slots, `justify-end` when there is no secondary).
 *
 * The footer is normal document flow everywhere — the bordered bar renders
 * inline after the last card on all screen sizes, never fixed or sticky.
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
    <div className={className ?? "lg:pt-4"}>
      <div
        className={cn(
          "flex items-center gap-4 lg:rounded-xl lg:border lg:bg-card lg:px-[18px] lg:py-3.5",
          secondary ? "justify-between" : "justify-end",
        )}
      >
        {secondary ? (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {secondary}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
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
}: {
  initialName: string;
  initialConfig: AgentConfig;
  submitLabel: string;
  onSubmit: (name: string, config: AgentConfig) => Promise<void>;
  /** Fires on every edit, so a live test call can use the unsaved config. Name is included so a live test call can mirror unsaved name edits. */
  onChange?: (config: AgentConfig, name: string) => void;
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

  const toolsByName = useMemo(
    () => new Map(TOOL_REGISTRY.map((t) => [t.name as string, t])),
    [],
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

  const agentLabel = name.trim() || "this agent";
  // A config can legitimately pin several recognition languages even though
  // this select writes one at a time. Surface the rest rather than letting the
  // trigger imply the others are gone.
  const extraLanguages = config.languageCodes
    .slice(1)
    .map((code) => inputLanguage(code)?.label ?? code);

  return (
    <div className="flex flex-col gap-4">
      <Card className={CARD}>
        <CardHeader className={CARD_HEAD}>
          <CardTitle className="font-semibold tracking-[-0.01em]">Identity</CardTitle>
          <CardDescription className="text-[13px]">
            Name, voice, and language callers hear.
          </CardDescription>
        </CardHeader>
        <CardContent className={CARD_BODY}>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="agent-name" className={LABEL}>
              Agent name
            </FieldLabel>
            <Input
              id="agent-name"
              className={cn(CONTROL, "max-w-md")}
              value={name}
              placeholder="Vera"
              data-invalid={!name.trim() || undefined}
              aria-invalid={!name.trim() || undefined}
              onChange={(e) => setAgentName(e.target.value)}
            />
          </Field>

          <div className="grid gap-3 lg:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="identity-role" className={LABEL}>
                Role
              </FieldLabel>
              <Input
                id="identity-role"
                className={cn(CONTROL, "max-w-md")}
                value={config.identity.role}
                placeholder="Property viewing coordinator"
                data-invalid={!config.identity.role.trim() || undefined}
                aria-invalid={!config.identity.role.trim() || undefined}
                onChange={(e) =>
                  set("identity", { ...config.identity, role: e.target.value })
                }
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="agent-language" className={LABEL}>
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
                  className={cn(CONTROL, "max-w-xs")}
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
                <FieldDescription className={HINT}>
                  Also pinned: {extraLanguages.join(", ")}. Choosing a language
                  here replaces the whole list.
                </FieldDescription>
              ) : null}
            </Field>
          </div>

          <Field className="gap-1.5">
            <FieldLabel htmlFor="agent-voice" className={LABEL}>
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
              <SelectTrigger id="agent-voice" aria-label="Voice" className={cn(CONTROL, "max-w-md")}>
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
            <FieldDescription className={HINT}>
              Switching voice starts a fresh session. The current test call ends
              and a new one begins in the new voice.
            </FieldDescription>
          </Field>
        </CardContent>
      </Card>

      <Card className={CARD}>
        <CardHeader className={CARD_HEAD}>
          <CardTitle className="font-semibold tracking-[-0.01em]">Mission</CardTitle>
          <CardDescription className="text-[13px]">
            What {agentLabel} is trying to accomplish on every call.
          </CardDescription>
        </CardHeader>
        <CardContent className={CARD_BODY}>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="mission" className={LABEL}>
              Mission statement
            </FieldLabel>
            <Textarea
              id="mission"
              className={`${CONTROL} min-h-[76px] resize-y [field-sizing:fixed]`}
              value={config.mission}
              placeholder="Qualify inbound property inquiries and book viewings"
              data-invalid={!config.mission.trim() || undefined}
              aria-invalid={!config.mission.trim() || undefined}
              onChange={(e) => set("mission", e.target.value)}
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="greeting" className={LABEL}>
              Greeting
            </FieldLabel>
            <Input
              id="greeting"
              className={CONTROL}
              value={config.greeting}
              placeholder="Hi, this is Vera. How can I help you today?"
              data-invalid={!config.greeting.trim() || undefined}
              aria-invalid={!config.greeting.trim() || undefined}
              onChange={(e) => set("greeting", e.target.value)}
            />
          </Field>
          <p className="rounded-[10px] border border-dashed bg-muted/50 px-3 py-2.5 text-[13px] text-muted-foreground">
            Suggested first line to test: “Hi, I&apos;m looking for a 2-bedroom
            near Riverside under $2,400.”
          </p>
        </CardContent>
      </Card>

      <Card className={CARD}>
        <CardHeader className={CARD_HEAD}>
          <CardTitle className="font-semibold tracking-[-0.01em]">Conversation</CardTitle>
          <CardDescription className="text-[13px]">
            Details {agentLabel} listens for before booking.
          </CardDescription>
        </CardHeader>
        <CardContent className={CARD_BODY}>
          <Field className="gap-1.5">
            <FieldLabel className={LABEL}>Detect and remember</FieldLabel>
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
                      <div className="flex min-w-0 flex-col">
                        <FieldLabel
                          htmlFor={id}
                          className="cursor-pointer text-[13px] font-semibold"
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
                    <Switch
                      id={paceId}
                      checked={selected ? fieldSensitive : false}
                      disabled={!selected}
                      onCheckedChange={(checked: boolean) =>
                        toggleDetectSensitive(field.key, checked)
                      }
                      title={
                        fieldSensitive
                          ? `Read back slowly for ${field.label} is on — the agent spells it out digit by digit`
                          : `Read back slowly for ${field.label} is off`
                      }
                      aria-label={
                        fieldSensitive
                          ? `Turn off slow read-back for ${field.label}`
                          : `Turn on slow read-back for ${field.label}`
                      }
                    />
                  </div>
                );
              })}
            </div>
            <FieldDescription className={HINT}>
              Unchecked details are still answered if the caller mentions them,
              but {agentLabel} won&apos;t ask for them. The slow read-back
              switch marks a field to read back slowly — phone numbers, emails,
              and other details the caller spells out.
            </FieldDescription>
          </Field>

          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge" className={LABEL}>
              House rules
            </FieldLabel>
            <Textarea
              id="knowledge"
              className={`${CONTROL} min-h-[76px] resize-y [field-sizing:fixed]`}
              value={config.knowledge}
              placeholder="Never quote fees you can't verify."
              onChange={(e) => set("knowledge", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className={CARD}>
        <CardHeader className={CARD_HEAD}>
          <CardTitle className="font-semibold tracking-[-0.01em]">
            Tools and channels
          </CardTitle>
          <CardDescription className="text-[13px]">
            What {agentLabel} can do, and where it answers.
          </CardDescription>
        </CardHeader>
        <CardContent className={CARD_BODY}>
          {/* Read-only: which tools an agent has is decided by its template,
              not per-agent here. The badge marks the ones the call stops and
              waits on instead of talking over — `mode: "hold"` in the
              registry — so an empty badge is information too. */}
          {config.tools.map((toolName) => {
            const tool = toolsByName.get(toolName);
            return (
              <div
                key={toolName}
                className="flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-col">
                  <strong className="text-[13px] font-semibold">{toolName}</strong>
                  {tool ? (
                    <small className="text-xs text-muted-foreground">
                      {tool.description}
                    </small>
                  ) : null}
                </div>
                {tool?.mode === "hold" ? (
                  <Badge variant="secondary" className="whitespace-nowrap">
                    waits for result
                  </Badge>
                ) : null}
              </div>
            );
          })}

          {CHANNEL_META.map((channel) => {
            const id = `channel-${channel.value}`;
            return (
              <div
                key={channel.value}
                className="flex items-center justify-between gap-3 border-t pt-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <FieldLabel htmlFor={id} className="text-[13px] font-semibold">
                    {channel.title}
                  </FieldLabel>
                  <FieldDescription className="text-xs">
                    {channel.description}
                  </FieldDescription>
                </div>
                <Switch
                  id={id}
                  checked={config.channels.includes(channel.value)}
                  onCheckedChange={() => toggleChannel(channel.value)}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <ConfigFormFooter
        secondary={footerSecondary}
        primary={
          <>
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
                  className="inline-block size-2 rounded-full bg-amber-600"
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
