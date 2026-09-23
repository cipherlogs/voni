/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/onboarding-05` (https://blocks.so/r/onboarding-05.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: vertical spine + status dot +
 * actor/action/time sentence kept as a deployment/generation
 * statusline pattern; static steps data model NOT adopted (live job
 * state drives entries in the real page — entries arrive via props);
 * per-user avatar hues +
 * marker borders remapped to semantic tokens (muted avatar,
 * primary/active dots); space-x/space-y stacks rebuilt as flex+gap;
 * min-h-dvh centered wrapper NOT adopted (statusline renders inline).
 * +0 npm deps; cn from @/lib/utils.
 */

import { cn } from '@/lib/utils';

export type StatuslineState = 'done' | 'active' | 'pending';

export interface StatuslineEntry {
  id: string;
  state: StatuslineState;
  actor: string;
  actorInitial: string;
  action: string;
  time: string;
}

interface Onboarding05Props {
  title?: string;
  description?: string;
  entries: StatuslineEntry[];
}

export default function Onboarding05({
  title = 'Generation activity',
  description = 'Live updates from this job',
  entries,
}: Onboarding05Props) {
  return (
    <section className="w-full sm:max-w-lg">
      <h3 className="font-medium text-foreground">{title}</h3>
      <p className="mt-1 text-muted-foreground text-sm leading-6">
        {description}
      </p>
      <ul className="mt-6 flex flex-col gap-6 pb-2">
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
            <div className="flex items-start gap-2">
              <div className="flex items-center gap-2">
                <div className="relative flex size-6 flex-none items-center justify-center bg-background">
                  {entry.state === 'done' ? (
                    <div className="size-2.5 rounded-full bg-primary ring-4 ring-background" />
                  ) : entry.state === 'active' ? (
                    <div className="size-2.5 rounded-full bg-primary ring-4 ring-muted" />
                  ) : (
                    <div className="size-2.5 rounded-full border border-muted-foreground/40 bg-background ring-4 ring-background" />
                  )}
                </div>
                <span
                  aria-hidden
                  className="inline-flex size-6 flex-none items-center justify-center rounded-full bg-muted text-muted-foreground text-xs"
                >
                  {entry.actorInitial}
                </span>
              </div>
              <p className="mt-0.5 font-medium text-foreground text-sm">
                {entry.actor}
                <span className="font-normal text-muted-foreground">
                  {' '}
                  {entry.action}
                </span>
                <span className="font-normal text-muted-foreground/60">
                  {' '}
                  · {entry.time}
                </span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
