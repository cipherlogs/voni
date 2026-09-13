/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/onboarding-06` (https://blocks.so/r/onboarding-06.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: ul/li timeline kept (absolute
 * connector + status-conditional marker + two-line text);
 * min-h-dvh centered full-height wrapper NOT adopted (wizard is
 * inline); static steps data model NOT adopted (live job state drives
 * entries in the real page — entries arrive via props);
 * @tabler/icons-react REJECTED -> lucide (Check for finished,
 * filled dot for current, bordered ring dot for upcoming);
 * space-x/space-y stacks rebuilt as flex+gap.
 * +0 npm deps; cn from @/lib/utils.
 */

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type TimelineState = 'done' | 'current' | 'upcoming';

export interface TimelineEntry {
  id: string;
  state: TimelineState;
  title: string;
  description: string;
  time: string;
}

interface Onboarding06Props {
  title?: string;
  entries: TimelineEntry[];
}

export default function Onboarding06({
  title = 'Deployment progress',
  entries,
}: Onboarding06Props) {
  return (
    <section className="w-full sm:max-w-lg">
      <h3 className="font-medium text-foreground">{title}</h3>
      <ul className="mt-6 flex flex-col gap-6">
        {entries.map((entry, entryIdx) => (
          <li className="relative flex gap-x-3" key={entry.id}>
            <div
              className={cn(
                'absolute top-0 left-0 flex w-6 justify-center',
                entryIdx === entries.length - 1 ? 'h-6' : '-bottom-6',
              )}
            >
              <span aria-hidden className="w-px bg-border" />
            </div>
            <div className="flex items-start gap-2.5">
              <div className="relative flex size-6 flex-none items-center justify-center bg-background">
                {entry.state === 'done' ? (
                  <Check aria-hidden className="size-5 text-primary" />
                ) : entry.state === 'current' ? (
                  <div
                    aria-hidden
                    className="size-2.5 rounded-full bg-primary ring-4 ring-background"
                  />
                ) : (
                  <div
                    aria-hidden
                    className="size-3 rounded-full border border-border bg-background ring-4 ring-background"
                  />
                )}
              </div>
              <div>
                <p className="mt-0.5 font-medium text-foreground text-sm">
                  {entry.title}{' '}
                  <span className="font-normal text-muted-foreground/60">
                    &#8729; {entry.time}
                  </span>
                </p>
                <p className="mt-0.5 text-muted-foreground text-sm leading-6">
                  {entry.description}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
