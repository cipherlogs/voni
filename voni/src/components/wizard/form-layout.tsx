"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Shared form spacing + footer compositions.
 *
 * Token map (spec):
 * - Page title → description: 8px (gap-2).
 * - Page heading → first content section: 24px mobile, 32px md+ (mb-6 md:mb-8).
 * - Form sections: 24px apart (gap-6).
 * - Wizard card padding: 16px mobile, 24px md+ (p-4 md:p-6 + card var).
 * - Card header → content: 24px (gap-6).
 *
 * Widths stay page-specific — these compositions never set max-width.
 */

export function PageHeading({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 md:mb-8", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="text-muted-foreground text-sm">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
    </div>
  );
}

/**
 * Spacious card variant for forms. Do NOT use for dashboard/stat cards —
 * those keep the default compact padding.
 */
export function FormCard({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Card>) {
  return (
    <Card
      data-slot="form-card"
      className={cn(
        "gap-6 py-4 md:py-6 md:[--card-spacing:--spacing(6)]",
        className,
      )}
      {...props}
    >
      {children}
    </Card>
  );
}

export function FormCardSections({
  className,
  ...props
}: React.ComponentProps<typeof CardContent>) {
  return (
    <CardContent
      className={cn("flex flex-col gap-6", className)}
      {...props}
    />
  );
}

/**
 * One consistent wizard footer: Back left, primary action right (primary
 * takes remaining width on mobile via `w-full md:w-auto` on the button).
 * Sticky above the JobPill + safe-area inset with reserved clearance.
 * Deliberately never switches to static flow on focus — flipping position on
 * focus moves the button between mousedown and mouseup, eating real clicks.
 */
export function WizardFooter({
  onBack,
  backDisabled,
  backLabel = "Back",
  primary,
  className,
}: {
  onBack: () => void;
  backDisabled?: boolean;
  backLabel?: string;
  primary: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="wizard-footer"
      className={cn(
        "sticky bottom-[calc(var(--job-pill-h,0px)+env(safe-area-inset-bottom))] z-10",
        className,
      )}
    >
      <div className="border-t bg-background pt-4">
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            className="pointer-coarse:min-h-11"
            disabled={backDisabled}
            onClick={onBack}
          >
            <ArrowLeft data-icon="inline-start" aria-hidden />
            {backLabel}
          </Button>
          <span className="flex min-w-0 flex-1 justify-end md:flex-none">
            {primary}
          </span>
        </div>
      </div>
    </div>
  );
}
