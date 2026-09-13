"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import {
  Bot,
  History,
  LayoutDashboard,
  Megaphone,
  Phone,
  PhoneCall,
  Users,
  Settings,
  ShieldCheck,
  LogOut,
  LoaderCircle,
  ChevronsUpDown,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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
import { VoniLogo } from "@/components/voni-logo";
import { signOut } from "@/lib/auth-client";

/** Single source for the dashboard nav — also feeds the voice copilot's app manifest. */
export const NAV_ITEMS = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Campaigns", url: "/campaigns", icon: Megaphone },
  { title: "Leads", url: "/leads", icon: Users },
  { title: "Calls", url: "/calls", icon: PhoneCall },
  { title: "Phone numbers", url: "/numbers", icon: Phone },
  { title: "Background jobs", url: "/jobs", icon: History },
];

export function AppSidebar({
  user,
  platformAdmin = false,
  sessionNote = "Session loading…",
}: {
  /** Absent until the shell auth resolver completes — branding and ordinary
   *  navigation render without it; the account menu stays hidden (Task 8). */
  user?: { name: string; email: string; image?: string | null };
  platformAdmin?: boolean;
  /** Text status shown in the footer while unauthenticated. */
  sessionNote?: string;
}) {
  return (
    // Fixed full-height icon rail, user-collapsible via the header
    // trigger (or cmd/ctrl+B). Open by default on desktop from the
    // layout's defaultOpen until the user explicitly collapses once;
    // the provider remembers the choice in a cookie. Icon-only keeps
    // every label one tooltip away.
    <Sidebar collapsible="icon" className="app-shell-sidebar">
      <SidebarHeader>
        <Link
          href="/dashboard"
          className="flex cursor-pointer items-center rounded-md px-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          {/* Mobile's Sheet is always full-width, so it can afford the full
              lockup; the desktop rail is icon-only, so it gets the minimal
              mark alone. Static — no URL read, safe in the shell. */}
          <SidebarBrand />
          <span className="sr-only">Voni dashboard</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            {/* Active-link state reads the URL, so it suspends behind its own
                boundary (Cache Components): links prerender without active
                styling, the highlight streams in. */}
            <Suspense fallback={<SidebarNav pathname={null} />}>
              <SidebarNavSelf />
            </Suspense>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
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

/** Brand lockup: static, no URL read — safe in the shell. */
function SidebarBrand() {
  const { isMobile } = useSidebar();
  return isMobile ? (
    <VoniLogo size="md" wordmark animate />
  ) : (
    <VoniLogo size="lg" animate />
  );
}

/** Self-reading nav leaf: owns the usePathname call so the boundary above
 *  covers exactly the active-state computation. */
function SidebarNavSelf() {
  const pathname = usePathname();
  return <SidebarNav pathname={pathname} />;
}

/**
 * Nav idiom from Blocks sidebar-03 (nav-main): full-width rounded rows,
 * icon + label, collapsed rail centers icons. Adapted: flat NAV_ITEMS
 * (no collapsible subs), active-link Suspense boundary kept, account menu
 * untouched. framer-motion NOT adopted.
 */
function SidebarNav({ pathname }: { pathname: string | null }) {
  return (
    <SidebarMenu className="gap-1">
      {NAV_ITEMS.map((item) => {
        const active = pathname != null && pathname.startsWith(item.url);
        return (
          <SidebarMenuItem key={item.url}>
            <SidebarMenuButton
              isActive={active}
              tooltip={item.title}
              className="flex w-full items-center rounded-lg px-2 transition-colors group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2! [&_svg]:size-5!"
              render={
                <Link href={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              }
            />
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/** Account menu: user-gated, no URL read of its own. Split out so the shell
 *  keeps one static shape above the auth boundary. */
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
                className="group-data-[collapsible=icon]:mx-auto"
              >
                <Avatar className="size-8 rounded-lg">
                  {user.image ? <AvatarImage src={user.image} alt="" /> : null}
                  <AvatarFallback className="rounded-lg">{initials || "V"}</AvatarFallback>
                </Avatar>
                <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
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
                it — that crash took the whole dashboard down as soon as this
                menu opened, which is why Sign out was unreachable. Keeping
                the label inside the group it names is both the fix and the
                correct accessible structure. */}
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
