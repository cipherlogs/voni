'use client';

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/login-01` (https://blocks.so/r/login-01.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project:
 * - Email/password form removed — Voni is Google-only sign-in (Better Auth).
 *   The Google action is the vendored anchor, rewired to LoadingButton +
 *   the real signIn.social handler via props.
 * - flex-col gap stack instead of space-y; Label replaced with paragraph
 *   copy (no form fields remain); terms line dropped (no email form).
 * - Ticket 02: the root fills its page (`flex-1`) instead of locking the
 *   viewport (`min-h-dvh`), so the shared SiteFooter sits at the bottom of
 *   short auth pages without pushing past the viewport.
 */

import Link from 'next/link';
import type { JSX, SVGProps } from 'react';
import { Separator } from '@/components/ui/separator';
import { LoadingButton } from '@/components/loading-button';

const GoogleIcon = (
  props: JSX.IntrinsicAttributes & SVGProps<SVGSVGElement>
) => (
  <svg fill="currentColor" viewBox="0 0 24 24" {...props}>
    <path d="M3.06364 7.50914C4.70909 4.24092 8.09084 2 12 2C14.6954 2 16.959 2.99095 18.6909 4.60455L15.8227 7.47274C14.7864 6.48185 13.4681 5.97727 12 5.97727C9.39542 5.97727 7.19084 7.73637 6.40455 10.1C6.2045 10.7 6.09086 11.3409 6.09086 12C6.09086 12.6591 6.2045 13.3 6.40455 13.9C7.19084 16.2636 9.39542 18.0227 12 18.0227C13.3454 18.0227 14.4909 17.6682 15.3864 17.0682C16.4454 16.3591 17.15 15.3 17.3818 14.05H12V10.1818H21.4181C21.5364 10.8363 21.6 11.5182 21.6 12.2273C21.6 15.2727 20.5091 17.8363 18.6181 19.5773C16.9636 21.1046 14.7 22 12 22C8.09084 22 4.70909 19.7591 3.06364 16.4909C2.38638 15.1409 2 13.6136 2 12C2 10.3864 2.38638 8.85911 3.06364 7.50914Z" />
  </svg>
);

export default function Login01({
  title,
  description,
  pending,
  pendingText,
  onGoogle,
  switchLine,
  switchHref,
  switchLabel,
}: {
  title: string;
  description: string;
  pending: boolean;
  pendingText: string;
  onGoogle: () => void;
  switchLine: string;
  switchHref: string;
  switchLabel: string;
}) {
  return (
    <div className="flex w-full flex-1 items-center justify-center">
      <div className="flex flex-1 flex-col justify-center px-4 py-10 lg:px-6">
        <div className="sm:mx-auto sm:w-full sm:max-w-sm">
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-balance text-center font-semibold text-foreground text-xl">
              {title}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed text-balance">
              {description}
            </p>
          </div>

          <div className="mt-6 flex flex-col gap-4">
            <LoadingButton
              className="inline-flex h-10 w-full items-center justify-center gap-2"
              onClick={onGoogle}
              pending={pending}
              pendingText={pendingText}
              variant="outline"
              icon={<GoogleIcon aria-hidden={true} className="size-5" />}
            >
              Continue with Google
            </LoadingButton>
          </div>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <Separator className="w-full" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                Google-only sign-in
              </span>
            </div>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            {switchLine}{' '}
            <Link
              className="cursor-pointer rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              href={switchHref}
            >
              {switchLabel}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
