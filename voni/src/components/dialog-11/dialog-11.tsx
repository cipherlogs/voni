'use client';

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/dialog-11` (https://blocks.so/r/dialog-11.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: modal shell NOT adopted (Dialog,
 * DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogClose
 * cut — this is an inline page wizard, never a modal, so the
 * sm:max-w-2xl dialog shell is gone); two-pane idiom rebuilt as an
 * inline two-column section; left column becomes step intro
 * (wizard-appropriate WandSparkles lucide in place of AppWindowIcon,
 * heading, description, Separator, help text) + footer abort/confirm
 * bar (outline Cancel, primary Continue); right numbered rows become
 * Plan/Personality sections; space-x/space-y stacks rebuilt as
 * flex+gap; Selects rewired from upstream items={} to house controlled
 * Select + SelectGroup + function-child SelectValue.
 */

import { WandSparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

export default function Dialog11() {
  const [plan, setPlan] = useState('starter');
  const [personality, setPersonality] = useState('friendly');

  return (
    <section className="flex w-full flex-col gap-6 md:flex-row">
      <div className="flex flex-col justify-between gap-6 md:w-80 md:border-r md:pr-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="inline-flex shrink-0 items-center justify-center rounded-sm bg-muted p-3">
              <WandSparkles
                aria-hidden={true}
                className="size-5 text-foreground"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <h3 className="text-balance font-medium text-foreground text-sm">
                Agent setup
              </h3>
              <p className="text-pretty text-muted-foreground text-sm">
                Configure your new voice agent
              </p>
            </div>
          </div>
          <Separator className="my-4" />
          <h4 className="text-balance font-medium text-foreground text-sm">
            Plan
          </h4>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            Pick the capacity tier this agent runs on.
          </p>
          <h4 className="mt-6 text-balance font-medium text-foreground text-sm">
            Personality
          </h4>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
            Choose how the agent sounds on live calls.
          </p>
        </div>
        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <Button type="button" variant="outline">
            Cancel
          </Button>
          <Button size="sm" type="button">
            Continue
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="inline-flex size-6 items-center justify-center rounded-sm bg-muted text-foreground text-sm">
              1
            </div>
            <Label
              className="font-medium text-foreground text-sm"
              htmlFor="plan"
            >
              Select plan
            </Label>
          </div>
          <Select
            onValueChange={(value) => setPlan(value ?? 'starter')}
            value={plan}
          >
            <SelectTrigger className="w-full" id="plan">
              <SelectValue>
                {(value: string | null) =>
                  value === 'growth'
                    ? 'Growth'
                    : value === 'scale'
                      ? 'Scale'
                      : 'Starter'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="growth">Growth</SelectItem>
                <SelectItem value="scale">Scale</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="inline-flex size-6 items-center justify-center rounded-sm bg-muted text-foreground text-sm">
              2
            </div>
            <Label
              className="font-medium text-foreground text-sm"
              htmlFor="personality"
            >
              Choose personality
            </Label>
          </div>
          <p className="text-pretty text-muted-foreground text-xs">
            Sets the default tone for greetings and follow-ups.
          </p>
          <Select
            onValueChange={(value) => setPersonality(value ?? 'friendly')}
            value={personality}
          >
            <SelectTrigger className="w-full" id="personality">
              <SelectValue>
                {(value: string | null) =>
                  value === 'professional'
                    ? 'Professional'
                    : value === 'concise'
                      ? 'Concise'
                      : 'Friendly'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="friendly">Friendly</SelectItem>
                <SelectItem value="professional">Professional</SelectItem>
                <SelectItem value="concise">Concise</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}
