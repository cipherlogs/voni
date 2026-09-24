"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Shared form spacing + footer compositions.
 *
 * Canonical pattern: blocks.so form-layout-03 — flat side-label sections, no
 * Card chrome around form groups. Forms are not surfaces, so FormCard renders
 * a plain wrapper: spacing comes from the sections and their `my-8`
 * separators, never from card padding. Only true surfaces (stat/dashboard
 * cards, status alerts, empty states, dialogs) keep Card.
 *
 * Token map (spec):
 * - Page title → description: 8px (gap-2).
 * - Page heading → first content section: 24px mobile, 32px md+ (mb-6 md:mb-8).
 * - Side-label section: `grid grid-cols-1 gap-10 md:grid-cols-3`; heading
 *   left, fields in `sm:max-w-3xl md:col-span-2`; sections divided by
 *   `Separator my-8`.
 * - Single-section stacks (one group, wizard chrome, review summaries) keep
 *   `flex flex-col gap-6` via FormCardSections.
 *
 * Widths stay page-specific — these compositions never set max-width.
 */

export function PageHeading({
  title,
  meta,
  description,
  actions,
  className,
}: {
  title: string;
  /** Inline status beside the title (e.g. a StatusDot). */
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 md:mb-8", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {meta}
          </div>
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
 * Flat form container. Intentionally NOT a Card: form groups are not surfaces,
 * so there is no border, background, or padding here. Single-section consumers
 * stack through FormCardSections; multi-section forms place FormSection blocks
 * divided by FormSectionSeparator directly inside.
 */
export function FormCard({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div data-slot="form-card" className={cn(className)} {...props}>
      {children}
    </div>
  );
}

export function FormCardSections({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-6", className)}
      {...props}
    />
  );
}

/**
 * One flat side-label section (form-layout-03): heading left, fields right,
 * stacking on mobile. Pass the heading node (usually FormSectionHeading, or
 * the wizard's StepHeading which keeps its step-focus behavior) and the field
 * content as children; section labelling flows through standard section props
 * such as `aria-labelledby`.
 */
export function FormSection({
  heading,
  className,
  children,
  ...props
}: React.ComponentProps<"section"> & {
  heading: ReactNode;
}) {
  return (
    <section
      className={cn("grid grid-cols-1 gap-10 md:grid-cols-3", className)}
      {...props}
    >
      <div>{heading}</div>
      <div className="flex flex-col gap-6 sm:max-w-3xl md:col-span-2">{children}</div>
    </section>
  );
}

/**
 * The left-column heading for a FormSection: h2 (settings groups under a page
 * h1) or h3 (nested groups, e.g. the CSV import under the campaign h2).
 */
export function FormSectionHeading({
  level = 2,
  id,
  title,
  description,
}: {
  level?: 2 | 3;
  id?: string;
  title: string;
  description?: string;
}) {
  const Tag = level === 3 ? "h3" : "h2";
  return (
    <>
      <Tag id={id} className="text-balance font-semibold">
        {title}
      </Tag>
      {description ? (
        <p className="mt-1 text-pretty text-muted-foreground text-sm leading-6">
          {description}
        </p>
      ) : null}
    </>
  );
}

/**
 * The ruled divider between flat sections (and before the action row):
 * `Separator my-8`, per the canonical pattern.
 */
export function FormSectionSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return <Separator className={cn("my-8", className)} {...props} />;
}

/**
 * The one form action row (blocks.so form-layout-01/02/03): a ruled line,
 * then Cancel/Back and the primary action grouped at the bottom right.
 * On mobile the group stacks full width with the primary on top
 * (`flex-col-reverse`). `start` is only for a destructive action (Delete),
 * kept on the far left so it never sits next to Save.
 */
export function FormActions({
  start,
  children,
  className,
}: {
  start?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="form-actions" className={cn(className)}>
      <Separator />
      <div className="flex flex-col-reverse gap-3 pt-4 sm:flex-row sm:items-center">
        {start ? (
          <div className="flex flex-col gap-3 sm:mr-auto sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">
            {start}
          </div>
        ) : null}
        <div className="flex flex-col-reverse gap-3 sm:ml-auto sm:flex-row sm:items-center [&>*]:w-full sm:[&>*]:w-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Wizard footer: FormActions with Back beside the primary action. Back is
 * hidden (not just disabled) where there is nowhere to go back to.
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
    <FormActions className={className}>
      {backDisabled ? null : (
        <Button
          type="button"
          variant="outline"
          className="pointer-coarse:min-h-11"
          onClick={onBack}
        >
          <ArrowLeft data-icon="inline-start" aria-hidden />
          {backLabel}
        </Button>
      )}
      {primary}
    </FormActions>
  );
}
