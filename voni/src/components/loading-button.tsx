"use client";

import type { ComponentProps, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The house pattern for any async trigger: spinner + disabled while pending,
 * optionally swapping the label so the user can tell something is happening
 * rather than reading a click as a no-op. Presentational only — callers wire
 * `pending` from whatever they already track (`useTransition`, a local
 * `useState`, or `useFormStatus` for a form action).
 */
export function LoadingButton({
  pending,
  pendingText,
  icon,
  children,
  disabled,
  ...props
}: ComponentProps<typeof Button> & {
  pending: boolean;
  pendingText?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Button disabled={pending || disabled} {...props}>
      {pending ? <LoaderCircle className="animate-spin" /> : icon}
      {pending && pendingText !== undefined ? pendingText : children}
    </Button>
  );
}
