"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { toast } from "@/components/ui/toast";
import {
  ChevronsUpDown,
  LoaderCircle,
  LogOut,
  Settings,
  ShieldCheck,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth-client";
import { BrandLogo } from "@/components/sidebar-03/logo";
import { SidebarUtilityGroup } from "@/components/sidebar-03/utility-rows";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Sidebar-03 shell, Voni-wired (full-block adoption).
 *
 * Upstream differences, all deliberate: the demo `Logo` + "Acme" lockup is
 * the animated Classic `BrandLogo` (homepage loop for expanded, static chip
 * for collapsed — no theme-specific assets); the `motion.div` around the header controls
 * is a plain container (motion dependency rejected per the frozen design
 * record — same layout classes); the footer holds exactly one identity — the
 * account menu — since this is a single-workspace product with no
 * workspace-switching backend. The header carries the brand lockup plus the
 * collapse trigger only (no notifications bell); jobs status lives solely in
 * the utility group. The trigger matches the rail-icon contract (32px box,
 * accent hover, tooltip, state-announcing label) via class overrides — the
 * shared ui/sidebar.tsx primitive itself is untouched.
 */

export function DashboardSidebarShell({
  nav,
  user,
  platformAdmin = false,
  sessionNote = "Session loading…",
}: {
  /** Navigation node: the entry wraps the active-link leaf in Suspense. */
  nav: ReactNode;
  /** Absent until the shell auth resolver completes — branding and ordinary
   *  navigation render without it; the account menu stays hidden. */
  user?: { name: string; email: string; image?: string | null };
  platformAdmin?: boolean;
  /** Text status shown in the footer while unauthenticated. */
  sessionNote?: string;
}) {
  return (
    <Sidebar collapsible="icon" variant="floating" className="app-shell-sidebar">
      <SidebarHeader className="flex">
        <SidebarBrandHeader />
      </SidebarHeader>
      <SidebarContent className="gap-4 px-2 py-4">
        {nav}
        {/* Search, voice, and jobs status: relocated from the removed top
            bar. Pinned to the bottom of the content column. */}
        <SidebarUtilityGroup />
      </SidebarContent>
      <SidebarFooter className="gap-2 px-2">
        {user ? (
          <SidebarAccount user={user} platformAdmin={platformAdmin} />
        ) : (
          // Session still resolving: text status, never a previous user's
          // identity. Navigation above stays usable.
          <p className="text-sidebar-foreground/60 px-2 py-1 text-xs">
            {sessionNote}
          </p>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

/** Brand lockup + collapse trigger. Static, no URL read — safe in the shell. */
function SidebarBrandHeader() {
  const { isMobile, state } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";
  // State-announcing label: the trigger is icon-only at every density, so
  // the tooltip + aria-label carry its only visible name.
  const triggerLabel = isCollapsed
    ? "Expand sidebar (⌘B)"
    : "Collapse sidebar (⌘B)";

  return (
    <div
      className={cn(
        "flex w-full md:pt-0",
        isCollapsed
          ? "flex-row items-center justify-between gap-y-4 md:flex-col md:items-start md:justify-start"
          : "flex-row items-center justify-between",
      )}
    >
      <Link
        href="/dashboard"
        className="flex cursor-pointer items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <BrandLogo density={isCollapsed ? "collapsed" : "expanded"} />
        <span className="sr-only">Voni dashboard</span>
      </Link>

      <div className="flex flex-row items-center">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarTrigger
                aria-label={triggerLabel}
                aria-expanded={!isCollapsed}
                title={triggerLabel}
                className="size-8 rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
              />
            }
          />
          <TooltipContent side="right" align="center">
            {triggerLabel}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/** Account menu: user-gated, no URL read of its own. */
function SidebarAccount({
  user,
  platformAdmin,
}: {
  user: { name: string; email: string; image?: string | null };
  platformAdmin: boolean;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    const { error } = await signOut();
    if (error) {
      setSigningOut(false);
      toast.add({ type: "error", title: "Could not sign out", description: "Check your connection and try again." });
      return;
    }
    // replace() so the signed-in page is not left in history for the back
    // button, then refresh() to drop the client router cache still holding
    // authenticated fragments.
    router.replace("/login");
    router.refresh();
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={user.email}
                className="group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center! group-data-[collapsible=icon]:gap-0! group-data-[collapsible=icon]:p-1! group-data-[collapsible=icon]:[&_.sidebar-account-label]:hidden group-data-[collapsible=icon]:[&>svg]:hidden"
              >
                <Avatar className="size-8 rounded-lg">
                  {user.image ? <AvatarImage src={user.image} alt="" /> : null}
                  <AvatarFallback className="rounded-lg">{initials || "V"}</AvatarFallback>
                </Avatar>
                <span className="sidebar-account-label grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                </span>
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent side="top" align="start" className="w-64">
            {/* DropdownMenuLabel is Base UI's Menu.GroupLabel, which reads
                MenuGroupContext and throws when it has no Menu.Group above
                it — keeping the label inside the group it names is both the
                fix and the correct accessible structure. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <span className="grid gap-0.5">
                  <span className="truncate font-medium text-foreground">{user.name}</span>
                  <span className="truncate text-xs">{user.email}</span>
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link href="/settings" />}>
                <Settings />
                Settings
              </DropdownMenuItem>
              {platformAdmin ? (
                <DropdownMenuItem render={<Link href="/operator" />}>
                  <ShieldCheck />
                  Platform operator
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? <LoaderCircle className="animate-spin" /> : <LogOut />}
              {signingOut ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
