'use client';

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/onboarding-01` (https://blocks.so/r/onboarding-01.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: steps/progress + expandable StepCard
 * rows kept as a wizard progress header (title + completed count +
 * Progress track) and step sections with agent-setup content;
 * Dismiss/Show-again flow + overflow DropdownMenu NOT adopted (wizard
 * steps are never dismissible); min-h-dvh centered wrapper NOT adopted
 * (wizard is inline); CircularProgress svg ring replaced with the
 * Progress primitive; Collapsible primitive stays uninstalled —
 * expand/collapse uses conditional render; @tabler/icons-react
 * REJECTED -> lucide (Check, CircleDashed, ChevronRight); space-y
 * stacks rebuilt as flex+gap.
 */

import { Check, ChevronRight, CircleDashed } from 'lucide-react';
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

const steps = [
  {
    id: 'identity',
    title: 'Name your agent',
    description:
      'Give the agent a name and role so callers know who is speaking.',
    completed: true,
    actionLabel: 'Edit identity',
    actionHref: '#',
  },
  {
    id: 'greeting',
    title: 'Write the greeting',
    description:
      'Set the opening line the agent uses on every answered call.',
    completed: false,
    actionLabel: 'Write greeting',
    actionHref: '#',
  },
  {
    id: 'number',
    title: 'Connect a number',
    description:
      'Attach a phone number so the agent can place and receive calls.',
    completed: false,
    actionLabel: 'Connect number',
    actionHref: '#',
  },
  {
    id: 'test',
    title: 'Run a test call',
    description:
      'Preview the voice and timing before the agent goes live.',
    completed: false,
    actionLabel: 'Start test call',
    actionHref: '#',
  },
];

interface WizardStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  actionLabel: string;
  actionHref: string;
}

function StepIndicator({ completed }: { completed: boolean }) {
  if (completed) {
    return (
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary">
        <Check aria-hidden="true" className="size-3 text-primary-foreground" />
      </span>
    );
  }
  return (
    <CircleDashed
      aria-hidden="true"
      className="mt-0.5 size-5 shrink-0 text-muted-foreground/40"
    />
  );
}

export default function Onboarding01() {
  const [currentSteps, setCurrentSteps] = useState<WizardStep[]>(steps);
  const [openStepId, setOpenStepId] = useState<string | null>(() => {
    const firstIncomplete = steps.find((s) => !s.completed);
    return firstIncomplete?.id ?? steps[0]?.id ?? null;
  });

  const completedCount = currentSteps.filter((s) => s.completed).length;
  const percent =
    currentSteps.length > 0
      ? (completedCount / currentSteps.length) * 100
      : 0;

  const handleStepClick = (stepId: string) => {
    setOpenStepId(openStepId === stepId ? null : stepId);
  };

  const handleStepAction = (step: WizardStep) => {
    const updated = currentSteps.map((s) =>
      s.id === step.id ? { ...s, completed: true } : s,
    );
    setCurrentSteps(updated);
    const nextIncomplete = updated.find((s) => !s.completed);
    setOpenStepId(nextIncomplete?.id ?? null);
  };

  return (
    <section className="w-full max-w-lg">
      <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-xs">
        <div className="mb-4 flex flex-col gap-3">
          <div className="ml-2 flex items-baseline justify-between gap-3">
            <h3 className="text-balance font-semibold text-foreground">
              Set up your agent
            </h3>
            <p className="shrink-0 text-muted-foreground text-sm">
              <span className="font-medium text-foreground">
                {completedCount}
              </span>
              {' / '}
              <span className="font-medium text-foreground">
                {currentSteps.length}
              </span>{' '}
              completed
            </p>
          </div>
          <Progress
            aria-label={`${completedCount} of ${currentSteps.length} steps completed`}
            value={percent}
          />
        </div>

        <div className="flex flex-col">
          {currentSteps.map((step, index) => {
            const isOpen = openStepId === step.id;
            const isFirst = index === 0;
            const prevStep = currentSteps[index - 1];
            const isPrevOpen = prevStep && openStepId === prevStep.id;

            const showBorderTop = !(isFirst || isOpen || isPrevOpen);

            return (
              <div
                className={cn(
                  'group',
                  isOpen && 'rounded-lg',
                  showBorderTop && 'border-border border-t',
                )}
                key={step.id}
              >
                <div
                  className={cn(
                    'block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                    isOpen && 'rounded-lg',
                  )}
                  onClick={() => handleStepClick(step.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleStepClick(step.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div
                    className={cn(
                      'relative overflow-hidden rounded-lg transition-colors',
                      isOpen && 'border border-border bg-muted',
                    )}
                  >
                    <div className="relative flex items-center justify-between gap-3 py-3 pr-2 pl-4">
                      <div className="flex w-full gap-3">
                        <div className="shrink-0">
                          <StepIndicator completed={step.completed} />
                        </div>
                        <div className="mt-0.5 grow">
                          <h4
                            className={cn(
                              'font-semibold',
                              step.completed
                                ? 'text-primary'
                                : 'text-foreground',
                            )}
                          >
                            {step.title}
                          </h4>
                          {isOpen && (
                            <div>
                              <p className="mt-2 text-pretty text-muted-foreground text-sm sm:max-w-64 md:max-w-xs">
                                {step.description}
                              </p>
                              <a
                                className={cn(
                                  buttonVariants({ size: 'sm' }),
                                  'mt-3',
                                )}
                                href={step.actionHref}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleStepAction(step);
                                }}
                              >
                                {step.actionLabel}
                              </a>
                            </div>
                          )}
                        </div>
                      </div>
                      {!isOpen && (
                        <ChevronRight
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex justify-end border-t border-border pt-4">
          <Button size="sm" type="button">
            Continue
          </Button>
        </div>
      </div>
    </section>
  );
}
