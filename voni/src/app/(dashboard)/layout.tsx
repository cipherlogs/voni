import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { JobsProvider } from "@/components/jobs/jobs-provider";
import { JobPill } from "@/components/jobs/job-pill";
import { CopilotProvider } from "@/components/copilot/copilot-provider";
import { CopilotShell } from "@/components/copilot/copilot-shell";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { auth } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";
import { devBypassEnabled, DEV_BYPASS_USER } from "@/lib/dev-bypass";
import { ViewTransition } from "react";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  const session = devBypassEnabled()
    ? { user: DEV_BYPASS_USER }
    : await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    const nextPath = safeNextPath(requestHeaders.get("x-voni-next-path"));
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  return (
    // Desktop sidebar stays permanently icon-collapsed; mobile still opens
    // via its own openMobile state and is unaffected by this. The wider
    // icon rail gives the enlarged nav buttons room to breathe instead of
    // exactly filling the column.
    <SidebarProvider
      open={false}
      style={{ "--sidebar-width-icon": "4.5rem" } as React.CSSProperties}
    >
      <AppSidebar user={session.user} />
      <SidebarInset>
        <JobsProvider>
          <CopilotProvider>
            <AppHeader />
            <ViewTransition name="dashboard-content" default="dashboard-route">
              {/* Bottom clearance tracks the fixed JobPill height so a
                visible pill can never cover trailing actions (e.g. the
                agent review's Save button) on long scrolled pages. The
                pill publishes --job-pill-h live and resets it to 0px on
                unmount, so this is plain page breathing room when idle. */}
              <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 pb-[calc(var(--job-pill-h,0px)+2rem)] md:p-6 lg:p-8">
                {children}
              </div>
            </ViewTransition>
            <JobPill />
            <CopilotShell />
          </CopilotProvider>
        </JobsProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}
