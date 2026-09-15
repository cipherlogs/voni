"use client";

import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import {
  Bot,
  History,
  LayoutDashboard,
  Megaphone,
  Phone,
  PhoneCall,
  Users,
} from "lucide-react";

import { useSidebar } from "@/components/ui/sidebar";
import { DashboardSidebarShell } from "@/components/sidebar-03/app-sidebar";
import DashboardNavigation, {
  type Route,
} from "@/components/sidebar-03/nav-main";

/** Single source for the dashboard nav — also feeds the voice copilot's app manifest. */
export const NAV_ITEMS = [  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Campaigns", url: "/campaigns", icon: Megaphone },
  { title: "Leads", url: "/leads", icon: Users },
  { title: "Calls", url: "/calls", icon: PhoneCall },
  { title: "Phone numbers", url: "/numbers", icon: Phone },
  { title: "Background jobs", url: "/jobs", icon: History },
];

/** Single source for section titles — also feeds the voice copilot's app manifest. */
export const SECTION_TITLES: Array<[string, string]> = [
  ["/dashboard", "Dashboard"],
  ["/agents", "Agents"],
  ["/campaigns", "Campaigns"],
  ["/leads", "Leads"],
  ["/numbers", "Phone numbers"],
  ["/calls", "Calls"],
  ["/jobs", "Background jobs"],
  ["/settings", "Settings"],
];

/** Flat workspace destinations mapped onto the sidebar-03 route shape.
 *  NAV_ITEMS keeps /jobs as the single source for the command menu and the
 *  voice copilot manifest; the nav list filters it so the sidebar shows no
 *  duplicate — jobs status lives solely in the utility group. */
function toRoutes(): Route[] {
  return NAV_ITEMS.filter((item) => item.url !== "/jobs").map((item) => ({
    id: item.url.replace(/^\//, ""),
    title: item.title,
    icon: <item.icon className="size-4" />,
    link: item.url,
  }));
}

export function AppSidebar({
  user,
  platformAdmin = false,
  sessionNote = "Session loading…",
}: {
  /** Absent until the shell auth resolver completes — branding and ordinary
   *  navigation render without it; the account menu stays hidden. */
  user?: { name: string; email: string; image?: string | null };
  platformAdmin?: boolean;
  /** Text status shown in the footer while unauthenticated. */
  sessionNote?: string;
}) {
  // Fixed full-height floating rail, user-collapsible via the header
  // trigger (or cmd/ctrl+B). Open by default on desktop from the
  // layout's defaultOpen until the user explicitly collapses once;
  // the provider remembers the choice in a cookie.
  const routes = toRoutes();
  return (
    <DashboardSidebarShell
      user={user}
      platformAdmin={platformAdmin}
      sessionNote={sessionNote}
      nav={
        // Active-link state reads the URL, so it suspends behind its own
        // boundary: links prerender without active styling, the highlight
        // streams in.
        <Suspense
          fallback={
            <DashboardNavigation routes={routes} activePath={null} />
          }
        >
          <SidebarNavSelf routes={routes} />
        </Suspense>
      }
    />
  );
}

/**
 * Runs once inside the provider: applies the remembered sidebar_state
 * cookie (the provider only writes it — nothing upstream reads it, so
 * without this the user's expand choice resets every reload). The
 * cookie holds no identity: it is a bare open/closed bit, safe to
 * read from this static context.
 */
export function SidebarStateRestore() {
  const { open, setOpen } = useSidebar();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const match = document.cookie.match(
      /(?:^|;\s*)sidebar_state=(true|false)/,
    );
    if (!match) return;
    const remembered = match[1] === "true";
    if (remembered !== open) setOpen(remembered);
  }, [open, setOpen]);
  return null;
}

/** Self-reading nav leaf: owns the usePathname call so the boundary above
 *  covers exactly the active-state computation. */
function SidebarNavSelf({ routes }: { routes: Route[] }) {
  const pathname = usePathname();
  return <SidebarNav routes={routes} pathname={pathname} />;
}

/**
 * Active-link nav leaf. Jobs status is not badged here — the utility group
 * below the nav owns the single jobs entry (see SidebarJobsRow), so this
 * leaf only resolves the active path.
 */
function SidebarNav({
  routes,
  pathname,
}: {
  routes: Route[];
  pathname: string | null;
}) {
  return (
    <DashboardNavigation
      routes={routes}
      activePath={pathname}
    />
  );
}
