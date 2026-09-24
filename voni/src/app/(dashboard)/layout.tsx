import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CopilotShell } from "@/components/copilot/copilot-shell";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { VoniLogo } from "@/components/voni-logo";
import { ShellAuthBridge, ShellAuthProvider } from "@/components/shell-auth";
import { SidebarStateRestore } from "@/components/app-sidebar";
import { ShellCopilotProvider, ShellJobsProvider, ShellSidebar } from "@/components/shell-frame";
import { auth } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";
import { devBypassEnabled, DEV_BYPASS_USER } from "@/lib/dev-bypass";
import { isPlatformAdmin } from "@/lib/platform/admin";
import { ViewTransition } from "react";

/**
 * Server authentication resolver. Runs inside its own Suspense boundary so
 * the generic frame above prerenders into the static shell (Task 8).
 *
 * Performs the existing checks unchanged: session (+ dev bypass), safe login
 * redirect when missing, operator allowlist. Publishes a narrow snapshot for
 * presentation/provider readiness only — never for server authorization.
 * Expected failures (e.g. unreachable auth store) resolve to `unavailable`
 * so the shell explains itself instead of erroring; the error is logged
 * server-side where dev/prod logs can see it.
 */
async function ShellAuthResolver() {
  const requestHeaders = await headers();
  let session;
  try {
    session = devBypassEnabled()
      ? { user: DEV_BYPASS_USER }
      : await auth.api.getSession({ headers: requestHeaders });
  } catch (error) {
    // Unreachable auth store (or similar): stay disabled and explain in the
    // shell instead of erroring the whole dashboard. Logged server-side.
    console.error("[shell-auth] session lookup unavailable:", error);
    return <ShellAuthBridge snapshot={{ status: "unavailable" }} />;
  }
  if (!session) {
    // Outside try: redirect() throws to interrupt rendering — let it fly.
    const nextPath = safeNextPath(requestHeaders.get("x-voni-next-path"));
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  let platformAdmin = false;
  try {
    platformAdmin = await isPlatformAdmin(session.user.email);
  } catch (error) {
    console.error("[shell-auth] operator check unavailable:", error);
  }
  return (
    <ShellAuthBridge
      snapshot={{
        status: "authenticated",
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image ?? null,
        },
        platformAdmin,
      }}
    />
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // User-controlled collapse: open by default on desktop until the user
    // explicitly collapses once, remembered in the sidebar_state cookie.
    // The icon variant stays fixed full-height; the provider must stay
    // uncontrolled (defaultOpen, not open) so the rail trigger and
    // cmd/ctrl+B can actually toggle it. No cookie yet means no explicit
    // choice, so the default (open) wins; SidebarStateRestore applies the
    // remembered value only when the cookie exists.
    // Mobile opens via its own openMobile state, unaffected by this.
    // The icon rail keeps the default width: sidebar-03 rows are standard
    // height, so the demo's 3rem geometry holds without an override.
    //
    // No desktop top bar: search, voice, and jobs status live in the rail,
    // and every page renders its own title. Below md the sidebar is a closed
    // Sheet whose own trigger is hidden, so a mobile-only strip carries the
    // trigger — without it phones have no way to navigate. Provider order is load-bearing —
    // auth first, then jobs, then voice — because the sidebar reads all
    // three (account menu, jobs badge and bell, voice row) and each
    // provider gates on the snapshot above it.
    <SidebarProvider defaultOpen={true}>
      <ShellAuthProvider>
        <SidebarStateRestore />
        <ShellJobsProvider>
          <ShellCopilotProvider>
            <ShellSidebar />
            <SidebarInset>
              <header className="bg-background sticky top-0 z-20 flex h-12 items-center gap-2 border-b px-4 md:hidden">
                <SidebarTrigger className="-ml-1" />
                <VoniLogo size="sm" wordmark />
              </header>
              <ViewTransition name="dashboard-content" default="dashboard-route">
                <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
                  {children}
                </div>
              </ViewTransition>
              <CopilotShell />
            </SidebarInset>
          </ShellCopilotProvider>
        </ShellJobsProvider>
        <Suspense fallback={null}>
          <ShellAuthResolver />
        </Suspense>
      </ShellAuthProvider>
    </SidebarProvider>
  );
}
