"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  PROVIDER_CATALOG,
  matchCatalogTool,
  overlapLabels,
  providerToolKey,
  type ProviderId,
} from "@/lib/providers/registry";
import {
  voicesByLanguage,
  INPUT_LANGUAGES,
  ACCENT_LABEL,
  voiceLabel,
  inputLanguage,
  type Voice,
} from "@/lib/agents/voices";

/**
 * The editable config form: four flat side-label sections (Identity /
 * Mission / Conversation / Tools and channels) following the
 * blocks.so form-layout-03 idiom — a `grid grid-cols-1 gap-10
 * md:grid-cols-3` per section with the h2 + muted description on the
 * left, fields clamped to `md:col-span-2`, and `Separator my-8` between
 * sections — ending in the composed ConfigFormFooter bar.
 */

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
 * Channel rows in the Tools-and-channels section, matching the mockup's
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
 * A flat form-layout-03 section: h2 + muted description left, fields right.
 * Adapted from blocks.so form-layout-03 (MIT ©2025 Ephraim Duncan), whose
 * block renders sections in `grid grid-cols-1 gap-10 md:grid-cols-3` with a
 * `sm:max-w-3xl md:col-span-2` field column, minus its centered demo shell
 * (the host page owns page chrome) and its demo footer buttons (ours lives
 * in ConfigFormFooter).
 */
function FormLayoutSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
        <div>
          <h2
            id={id}
            className="text-balance font-semibold text-foreground"
          >
            {title}
          </h2>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            {description}
          </p>
        </div>
        <div className="sm:max-w-3xl md:col-span-2">{children}</div>
      </div>
    </section>
  );
}

/**
 * Picker over connected-provider tools (GOAL 4B): checkbox rows grouped by
 * provider with overlap hints where the catalog says tools achieve the same
 * thing ("X and Y achieve the same thing — pick one"), plus a "Connect
 * more in Settings" link-out. Unconnected providers render as a single
 * disabled prompt row pointing at /settings instead of their tools.
 *
 * Selections live in `config.tools` as namespaced `"<provider>.<tool>"`
 * keys so they round-trip through the existing JSON config storage.
 */
function ProviderToolPicker({
  connectedProviders,
  selectedKeys,
  onToggle,
}: {
  connectedProviders: ProviderId[];
  selectedKeys: Set<string>;
  onToggle: (key: string, enabled: boolean) => void;
}) {
  const connected = useMemo(
    () => new Set<string>(connectedProviders),
    [connectedProviders],
  );
  if (PROVIDER_CATALOG.length === 0) return null;
  return (
    <Field>
      <FieldLabel>Provider tools</FieldLabel>
      <div className="flex flex-col gap-2">
        {PROVIDER_CATALOG.filter((provider) =>
          connected.has(provider.id),
        ).map((provider) => (
          <fieldset key={provider.id}>
            <legend className="text-xs font-medium text-muted-foreground">
              {provider.label}
            </legend>
            <div className="mt-1 flex flex-col gap-2">
              {provider.tools.map((tool) => {
                const key = providerToolKey(provider.id, tool.id);
                const id = `provider-tool-${provider.id}-${tool.id}`;
                const enabled = selectedKeys.has(key);
                const overlaps = overlapLabels(tool);
                return (
                  <div
                    key={tool.id}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border px-3 py-2.5"
                  >
                    <Checkbox
                      id={id}
                      checked={enabled}
                      onCheckedChange={(checked: boolean) =>
                        onToggle(key, checked)
                      }
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <FieldLabel
                        htmlFor={id}
                        className="cursor-pointer text-sm font-medium"
                      >
                        {tool.label}
                      </FieldLabel>
                      <FieldDescription className="text-xs">
                        {tool.description}
                      </FieldDescription>
                      {overlaps.length > 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {tool.label} and {overlaps.join(", ")} achieve the
                          same thing — pick one.
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        {PROVIDER_CATALOG.filter(
          (provider) => !connected.has(provider.id),
        ).map((provider) => (
          <div
            key={provider.id}
            className="flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-sm font-medium">
                {provider.label}
              </strong>
              <span className="text-xs text-muted-foreground">
                {provider.description}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/settings" />}
            >
              Connect
            </Button>
          </div>
        ))}
      </div>
      <FieldDescription>
        <Link href="/settings" className="underline underline-offset-4">
          Connect more in Settings
        </Link>
      </FieldDescription>
    </Field>
  );
}

/**
 * A built-in voice tool rendered in the tools table: checkbox in the select
 * column, plain name, a "waits for result" Badge when the registry marks it
 * hold-mode. The row action menu is display-only — tool catalog rows have no
 * per-row destructive action, so "View details" is disabled scaffolding
 * carried for the table-05 shape.
 */
function BuiltinToolRow({
  name,
  description,
  hold,
  enabled,
  onToggle,
}: {
  name: string;
  description: string;
  hold: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <ToolTableRow
      id={`tool-${name}`}
      checked={enabled}
      onCheckedChange={onToggle}
      name={name}
      description={description}
      status={
        hold ? (
          <Badge variant="secondary" className="whitespace-nowrap">
            waits for result
          </Badge>
        ) : (
          <Badge variant="outline" className="whitespace-nowrap">
            instant
          </Badge>
        )
      }
    />
  );
}

/**
 * One selectable row in the connected-tools table: table-05's checkbox +
 * name + status-Badge shape over tools data. The last column stays empty for
 * now — the block's row-actions menu arrives with the first per-tool action
 * that needs it, not before.
 */
function ToolTableRow({
  id,
  checked,
  onCheckedChange,
  name,
  description,
  status,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  name: ReactNode;
  description: ReactNode;
  status: ReactNode;
}) {
  return (
    <TableRow data-state={checked && "selected"}>
      <TableCell>
        <Checkbox
          id={id}
          aria-label={`Select ${typeof name === "string" ? name : "tool"}`}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel htmlFor={id} className="cursor-pointer font-medium">
            {name}
          </FieldLabel>
          <span className="text-xs text-muted-foreground">{description}</span>
        </div>
      </TableCell>
      <TableCell>{status}</TableCell>
    </TableRow>
  );
}

/**
 * Form footer (form-layout-01 terminal bar idiom): a Separator plus a
 * right-aligned action row following the house rule — secondary actions left,
 * primary save right — matching WizardFooter's secondary-left/primary-right
 * layout (`justify-between` with both slots, `justify-end` when there is no
 * secondary).
 *
 * The footer is normal document flow everywhere — the bar renders inline
 * after the last section on all screen sizes, never fixed or sticky.
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
  connectedProviders = [],
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
   * Provider ids the workspace has connected (e.g. from /settings). The
   * picker shows checkbox rows for connected providers and a Connect prompt
   * for the rest. Defaults to none connected, so the picker degrades to the
   * link-out rather than an empty list.
   */
  connectedProviders?: string[];
  /**
   * Whether there are unsaved edits. Kept as a prop (the host page already
   * computes it from its own last-saved snapshot) but no longer rendered
   * here — the floating pill owns the unsaved indicator.
   */
  isDirty?: boolean;
  /** Optional secondary action rendered left of the primary save (e.g. Delete). */
  footerSecondary?: ReactNode;
  /** Optional actions composed immediately before Save (e.g. Test agent). */
  footerPrimaryActions?: ReactNode;
}) {
  void isDirty;
  const [name, setName] = useState(initialName);
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [saving, setSaving] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [ideaGuidance, setIdeaGuidance] = useState<string | null>(null);

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
    setIdeaGuidance(null);
    set(
      "toolIdeas",
      (config.toolIdeas ?? []).filter((idea) => idea.name !== ideaName),
    );
  };

  const enableIdea = (idea: ToolIdea) => {
    // A matching built-in wins over a new provider pick: one enabled name
    // instead of a duplicate tool that does the same job.
    const match = TOOL_REGISTRY.find(
      (t) =>
        t.name === idea.name ||
        t.name.includes(idea.name) ||
        idea.name.includes(t.name),
    );
    if (match) {
      toggleTool(match.name, true);
      dismissIdea(idea.name);
      return;
    }
    // Otherwise the nearest connected-provider tool wins; with none
    // connected (or no catalog match) the row stays and explains which
    // provider to connect instead of drafting a webhook that has no URL.
    const catalog = matchCatalogTool(`${idea.label} ${idea.name}`);
    if (
      catalog &&
      connectedProviders.includes(catalog.provider.id)
    ) {
      toggleTool(
        providerToolKey(catalog.provider.id, catalog.tool.id),
        true,
      );
      dismissIdea(idea.name);
      return;
    }
    setIdeaGuidance(
      catalog
        ? `“${idea.label}” looks like ${catalog.provider.label} ${catalog.tool.label} — connect ${catalog.provider.label} in Settings to enable it.`
        : `No connected provider offers “${idea.label}” yet — connect the provider that owns it in Settings.`,
    );
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

  // Collapsed header counts: enabled voice tools (built-ins plus provider
  // picks already in config.tools), legacy custom rows, and channel state.
  const enabledBuiltins = config.tools.filter((t) =>
    TOOL_REGISTRY.some((tool) => tool.name === t),
  ).length;
  const enabledProviderTools = config.tools.length - enabledBuiltins;
  const legacyCustomCount = (config.customTools ?? []).length;
  const enabledToolCount =
    enabledBuiltins + enabledProviderTools + legacyCustomCount;
  const channelsOn = config.channels.length;
  const phoneOn = config.channels.includes("phone");
  const whatsappOn = config.channels.includes("whatsapp");
  const selectedProviderKeys = useMemo(
    () => new Set(config.tools),
    [config.tools],
  );
  const allBuiltinSelected =
    TOOL_REGISTRY.length > 0 &&
    TOOL_REGISTRY.every((tool) => config.tools.includes(tool.name));

  return (
    <div className="flex flex-col gap-3">
      <FormLayoutSection
        id="config-identity-heading"
        title="Identity"
        description="Name, voice, and language callers hear."
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
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
              <FieldLabel htmlFor="identity-role">Role</FieldLabel>
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
              <FieldLabel htmlFor="agent-language">Language</FieldLabel>
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
            <FieldLabel htmlFor="agent-voice">Voice</FieldLabel>
            <Select
              items={voiceItems}
              value={config.voiceId}
              // A voice is required — ignore a clear.
              onValueChange={(value) => {
                if (value) set("voiceId", String(value));
              }}
            >
              <SelectTrigger
                id="agent-voice"
                aria-label="Voice"
                className="w-full max-w-md"
              >
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
        </FieldGroup>
      </FormLayoutSection>

      <Separator className="my-8" />
      <FormLayoutSection
        id="config-mission-heading"
        title="Mission"
        description={`What ${agentLabel} is trying to accomplish on every call.`}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mission">Mission statement</FieldLabel>
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
            <FieldLabel htmlFor="greeting">Greeting</FieldLabel>
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
        </FieldGroup>
      </FormLayoutSection>

      <Separator className="my-8" />
      <FormLayoutSection
        id="config-conversation-heading"
        title="Conversation"
        description={`Details ${agentLabel} listens for before booking.`}
      >
        <FieldGroup>
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
            <FieldLabel htmlFor="knowledge">House rules</FieldLabel>
            <Textarea
              id="knowledge"
              className="min-h-[76px] resize-y [field-sizing:fixed]"
              value={config.knowledge}
              placeholder="Never quote fees you can't verify."
              onChange={(e) => set("knowledge", e.target.value)}
            />
          </Field>
        </FieldGroup>
      </FormLayoutSection>

      <Separator className="my-8" />
      <FormLayoutSection
        id="config-tools-heading"
        title="Tools and channels"
        description={`What ${agentLabel} can do, and where it answers.`}
      >
        <Collapsible
          open={toolsOpen}
          onOpenChange={setToolsOpen}
          className="flex flex-col gap-3"
        >
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className="group/button h-auto w-full justify-start px-3 py-3 text-left"
              />
            }
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <span className="font-medium">Connected tools</span>
              <Badge variant="secondary">
                Tools · {enabledToolCount}
              </Badge>
              <Badge variant="outline">
                Channels · {channelsOn === CHANNELS.length ? "all on" : `${channelsOn} on`} · phone{" "}
                {phoneOn ? "on" : "off"} · whatsapp {whatsappOn ? "on" : "off"}
              </Badge>
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              className="ml-auto shrink-0 transition-transform group-data-panel-open/button:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3">
            {/* Suggested for this agent: LLM tool ideas from the wizard brief.
                Enabling maps to the nearest built-in or connected-provider
                tool; with no match the row stays and points at the provider
                to connect. Dismissing drops the card. */}
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
                {ideaGuidance ? (
                  <FieldError className="text-xs">{ideaGuidance}</FieldError>
                ) : null}
              </Field>
            ) : null}

            {/* Connected tools: table-05's checkbox/name/status shape over
                tools data. The select-all box mirrors the whole registry; the
                name column reads the catalog entry; the status column carries
                the hold-mode badge as information. */}
            <Field>
              <FieldLabel>Connected tools</FieldLabel>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          aria-label="Select all tools"
                          checked={allBuiltinSelected}
                          onCheckedChange={(checked: boolean) => {
                            for (const tool of TOOL_REGISTRY) {
                              toggleTool(tool.name, checked);
                            }
                          }}
                        />
                      </TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {TOOL_REGISTRY.map((tool) => (
                      <BuiltinToolRow
                        key={tool.name}
                        name={tool.name}
                        description={tool.description}
                        hold={tool.mode === "hold"}
                        enabled={config.tools.includes(tool.name)}
                        onToggle={(enabled) =>
                          toggleTool(tool.name, enabled)
                        }
                      />
                    ))}
                    {/* Legacy webhook rows stay read-only so saved agents
                        never lose tools: disconnect only. An entry whose url
                        failed validation at enable time cannot execute — the
                        "Needs URL" badge says so instead of failing silently
                        on the next call. */}
                    {(config.customTools ?? []).map((tool: CustomTool) => (
                      <TableRow key={tool.id}>
                        <TableCell />
                        <TableCell>
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <strong className="text-sm font-medium">
                              {tool.label}
                            </strong>
                            <span className="text-xs text-muted-foreground">
                              {tool.description}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-2">
                            {tool.mode === "hold" ? (
                              <Badge
                                variant="secondary"
                                className="whitespace-nowrap"
                              >
                                waits for result
                              </Badge>
                            ) : null}
                            <Badge
                              variant="outline"
                              className="whitespace-nowrap"
                            >
                              custom
                            </Badge>
                            {!tool.url ? (
                              <Badge
                                variant="secondary"
                                className="whitespace-nowrap"
                              >
                                Needs URL
                              </Badge>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => removeCustomTool(tool.id)}
                            >
                              Disconnect
                            </Button>
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Field>

            <ProviderToolPicker
              connectedProviders={connectedProviders as ProviderId[]}
              selectedKeys={selectedProviderKeys}
              onToggle={toggleTool}
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
          </CollapsibleContent>
        </Collapsible>
      </FormLayoutSection>

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
          </>
        }
      />
    </div>
  );
}
