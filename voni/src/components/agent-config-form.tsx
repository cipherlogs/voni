"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
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
  type Voice,
} from "@/lib/agents/voices";

/**
 * The editable config form (plan Section F: "NL prompt -> generation ->
 * editable shadcn form -> Publish").
 *
 * The generated config is a draft, never a commitment — Section T flags that
 * "NL-generated configs may need heavy editing", and on free-tier models that
 * is the expected case rather than the exception. So every field the compiler
 * produces is editable here, including the ones users rarely touch.
 */

/** A list of short strings, edited one line each. Used for intents/blockers/knowledge. */
function StringList({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {hint ? (
        <FieldDescription>{hint}</FieldDescription>
      ) : null}
      <div className="flex flex-col gap-2">
        {values.map((value, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={value}
              placeholder={placeholder}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label} item ${i + 1}`}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...values, ""])}
      >
        <Plus />
        Add
      </Button>
    </Field>
  );
}

function DetectFields({
  values,
  onChange,
}: {
  values: DetectField[];
  onChange: (next: DetectField[]) => void;
}) {
  const update = (i: number, patch: Partial<DetectField>) => {
    const next = [...values];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  return (
    <Field>
      <FieldLabel>What to find out</FieldLabel>
      <FieldDescription>
        Asked one at a time during the call, never as a list.
      </FieldDescription>

      {values.map((field, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <Input
              className="font-medium"
              value={field.label}
              placeholder="Budget"
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${field.label || "field"}`}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </div>
          <Input
            value={field.description}
            placeholder="What exactly to learn"
            onChange={(e) => update(i, { description: e.target.value })}
          />
          <div className="flex items-start gap-3">
            <Switch
              id={`sensitive-${i}`}
              checked={field.sensitive}
              onCheckedChange={(checked: boolean) =>
                update(i, { sensitive: checked })
              }
            />
            <FieldContent className="flex flex-col gap-1">
              <FieldLabel htmlFor={`sensitive-${i}`} className="text-sm">
                Spoken as a sequence
              </FieldLabel>
              {/*
                This is not a cosmetic toggle. The live call runs with a very
                short silence threshold to keep replies fast, which means the
                agent will interrupt someone partway through a phone number or
                a budget. Flagging a field is what tells the call to wait
                longer while that specific answer is being given.
              */}
              <FieldDescription>
                Phone numbers, emails, budgets, dates. The agent waits longer
                before replying so it doesn&apos;t cut the caller off mid-answer.
              </FieldDescription>
            </FieldContent>
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() =>
          onChange([
            ...values,
            { key: "", label: "", description: "", sensitive: false },
          ])
        }
      >
        <Plus />
        Add field
      </Button>
    </Field>
  );
}

export function AgentConfigForm({
  initialName,
  initialConfig,
  submitLabel,
  onSubmit,
  onChange,
}: {
  initialName: string;
  initialConfig: AgentConfig;
  submitLabel: string;
  onSubmit: (name: string, config: AgentConfig) => Promise<void>;
  /** Fires on every edit, so a live test call can use the unsaved config. */
  onChange?: (config: AgentConfig) => void;
}) {
  const [name, setName] = useState(initialName);
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  // In an effect, not inside `set`: notifying a parent during render is a
  // React error, and this way it also fires for the initial config.
  useEffect(() => {
    onChange?.(config);
  }, [config, onChange]);

  const toggleTool = (tool: string) =>
    set(
      "tools",
      config.tools.includes(tool)
        ? config.tools.filter((t) => t !== tool)
        : [...config.tools, tool],
    );

  const sensitiveCount = config.detect.filter((d) => d.sensitive).length;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
            <FieldDescription>
              Internal label. Not spoken on the call.
            </FieldDescription>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Abu Dhabi inbound qualifier"
            />
          </Field>

          <FieldGroup className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="identity-name">Says its name is</FieldLabel>
              <Input
                id="identity-name"
                value={config.identity.name}
                onChange={(e) =>
                  set("identity", { ...config.identity, name: e.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="identity-role">Role</FieldLabel>
              <Input
                id="identity-role"
                value={config.identity.role}
                onChange={(e) =>
                  set("identity", { ...config.identity, role: e.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="identity-company">Company</FieldLabel>
              <Input
                id="identity-company"
                value={config.identity.company}
                placeholder="Optional"
                onChange={(e) =>
                  set("identity", {
                    ...config.identity,
                    company: e.target.value,
                  })
                }
              />
            </Field>
          </FieldGroup>

          <Field>
            <FieldLabel htmlFor="greeting">Greeting</FieldLabel>
            <FieldDescription>
              The first thing the caller hears — and the only line spoken with
              no thinking pause in front of it, so it sets the impression.
              Short, ending in an easy question.
            </FieldDescription>
            <Input
              id="greeting"
              value={config.greeting}
              onChange={(e) => set("greeting", e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel>Voice</FieldLabel>
            <FieldDescription>
              The language the agent speaks in. Fixed for the whole call — the
              API won&apos;t let it change once a conversation has started.
            </FieldDescription>
            {voicesByLanguage().map((group) => (
              <div key={group.language} className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-[11px] uppercase tracking-wide">
                  {group.language}
                </span>
                <ToggleGroup
                  value={[config.voiceId]}
                  onValueChange={(values) => {
                    // A voice is required — ignore deselecting the last one.
                    const next = Array.isArray(values) ? values[0] : values;
                    if (next) set("voiceId", next);
                  }}
                  variant="outline"
                  size="sm"
                  aria-label={`${group.language} voices`}
                  className="flex flex-wrap"
                >
                  {group.voices.map((voice: Voice) => (
                    <ToggleGroupItem
                      key={voice.id}
                      value={voice.id}
                      aria-label={`${voiceLabel(voice.id)} — ${ACCENT_LABEL[voice.accent]}`}
                    >
                      {voiceLabel(voice.id)}
                      <span className="opacity-60">
                        {ACCENT_LABEL[voice.accent]}
                      </span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ))}
          </Field>

          <Field>
            <FieldLabel>Languages it listens for</FieldLabel>
            {/*
              The asymmetry has to be visible here or the UI lies: the agent
              recognises 18 languages but speaks 6. Selecting Arabic is a real,
              supported setup — it means "understand Arabic callers" — but the
              reply still comes back in the voice's language, so the unspoken
              ones are marked rather than hidden or silently dropped.
            */}
            <p className="text-muted-foreground text-xs">
              Leave all off to detect automatically — that covers every
              supported language and handles callers switching mid-sentence.
              Pin languages only for a region-specific line.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {INPUT_LANGUAGES.map((lang) => {
                const on = config.languageCodes.includes(lang.code);
                return (
                  <Button
                    key={lang.code}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    onClick={() =>
                      set(
                        "languageCodes",
                        on
                          ? config.languageCodes.filter((c) => c !== lang.code)
                          : [...config.languageCodes, lang.code],
                      )
                    }
                  >
                    <span aria-hidden>{lang.flag}</span>
                    {lang.label}
                    {!lang.canSpeak ? (
                      <span className="opacity-60">understands only</span>
                    ) : null}
                  </Button>
                );
              })}
            </div>
            {config.languageCodes.some(
              (c) => !INPUT_LANGUAGES.find((l) => l.code === c)?.canSpeak,
            ) ? (
              <p className="text-muted-foreground flex items-start gap-2 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Some selected languages have no voice yet. Callers can speak
                them and the agent will understand, but it replies in{" "}
                {voiceLabel(config.voiceId)}&apos;s language.
              </p>
            ) : null}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mission</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="mission">What this agent is for</FieldLabel>
            <Textarea
              id="mission"
              rows={2}
              value={config.mission}
              onChange={(e) => set("mission", e.target.value)}
            />
          </Field>
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="success">Done when</FieldLabel>
              <Textarea
                id="success"
                rows={2}
                value={config.successCondition}
                onChange={(e) => set("successCondition", e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="fallback">If that&apos;s not reachable</FieldLabel>
              <Textarea
                id="fallback"
                rows={2}
                value={config.fallback}
                onChange={(e) => set("fallback", e.target.value)}
              />
            </Field>
          </FieldGroup>
          <Field>
            <FieldLabel htmlFor="followup">Follow-up policy</FieldLabel>
            <Input
              id="followup"
              value={config.followUpPolicy}
              placeholder="e.g. Retry once next day, then WhatsApp"
              onChange={(e) => set("followUpPolicy", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <DetectFields
            values={config.detect}
            onChange={(next) => set("detect", next)}
          />
          {sensitiveCount > 0 ? (
            <p className="text-muted-foreground flex items-start gap-2 text-xs">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {sensitiveCount} field{sensitiveCount === 1 ? "" : "s"} marked as
              spoken sequences. The call slows its turn-taking while those are
              being answered.
            </p>
          ) : null}
          <Separator />
          <StringList
            label="Intents to recognise"
            hint="Where the conversation can go."
            values={config.intents}
            onChange={(next) => set("intents", next)}
            placeholder="Wants to view a specific property"
          />
          <Separator />
          <StringList
            label="Objections to expect"
            values={config.blockers}
            onChange={(next) => set("blockers", next)}
            placeholder="Needs to consult a partner first"
          />
          <Separator />
          <StringList
            label="Rules and facts"
            hint="Hard constraints. These go into the call prompt verbatim."
            values={config.knowledge}
            onChange={(next) => set("knowledge", next)}
            placeholder="Never invent property information"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tools and channels</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <Field>
            <FieldLabel>Tools</FieldLabel>
            <FieldDescription>
              What the agent can actually do mid-call. Anything not backed by a
              tool, it will say it needs to check rather than guess.
            </FieldDescription>
            <div className="flex flex-col gap-2 pt-1">
              {TOOL_REGISTRY.map((tool) => {
                const on = config.tools.includes(tool.name);
                return (
                  <Field key={tool.name} orientation="horizontal">
                    <Switch
                      id={`tool-${tool.name}`}
                      checked={on}
                      onCheckedChange={() => toggleTool(tool.name)}
                    />
                    <FieldContent className="flex flex-col gap-0.5">
                      <FieldLabel
                        htmlFor={`tool-${tool.name}`}
                        className="font-mono text-xs"
                      >
                        {tool.name}
                        {tool.mode === "hold" ? (
                          <Badge variant="outline" className="ml-2">
                            waits for result
                          </Badge>
                        ) : null}
                      </FieldLabel>
                      <FieldDescription>
                        {tool.description}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                );
              })}
            </div>
          </Field>

          <Separator />

          <Field>
            <FieldLabel>Channels</FieldLabel>
            <ToggleGroup
              multiple
              value={[...config.channels]}
              onValueChange={(values) => {
                const next = (Array.isArray(values) ? values : [])
                  .filter((c) => (CHANNELS as readonly string[]).includes(c)) as (typeof CHANNELS)[number][];
                // At least one channel must stay selected — an agent with
                // none can never be dispatched. Deselecting the last one is
                // ignored, same as before.
                if (next.length === 0) return;
                set("channels", next);
              }}
              variant="outline"
              size="sm"
              aria-label="Channels"
              className="flex gap-2 pt-1"
            >
              {CHANNELS.map((channel) => (
                <ToggleGroupItem
                  key={channel}
                  value={channel}
                  aria-label={channel === "phone" ? "Phone" : "WhatsApp"}
                >
                  {channel === "phone" ? "Phone" : "WhatsApp"}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <LoadingButton
          disabled={!name.trim()}
          pending={saving}
          pendingText="Saving…"
          onClick={async () => {
            setSaving(true);
            try {
              await onSubmit(name, config);
            } catch (error) {
              toast.add({ type: "error", title: "Could not save", description: error instanceof Error ? error.message : "Check your connection and try again.",
              });
            } finally {
              setSaving(false);
            }
          }}
        >
          {submitLabel}
        </LoadingButton>
      </div>
    </div>
  );
}
