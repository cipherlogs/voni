"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  Bot,
  History,
  LayoutDashboard,
  Megaphone,
  Phone,
  Users,
  Settings,
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
  { title: "Phone numbers", url: "/numbers", icon: Phone },
  { title: "Background jobs", url: "/jobs", icon: History },
];

export function AppSidebar({
  user,
}: {
  user: { name: string; email: string; image?: string | null };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { isMobile } = useSidebar();
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
      toast.error("Could not sign out", {
        description: "Check your connection and try again.",
      });
      return;
    }
    // replace() so the signed-in page is not left in history for the back
    // button, then refresh() to drop the client router cache — signing out
    // invalidates every dashboard fragment prefetched while authenticated, and
    // without this a back navigation can still paint one from cache.
    router.replace("/login");
    router.refresh();
  }

  return (
    <Sidebar collapsible="icon" className="app-shell-sidebar">
      <SidebarHeader>
        <Link
          href="/dashboard"
          className="flex cursor-pointer items-center rounded-md px-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          {/* Mobile's Sheet is always full-width, so it can afford the full
              lockup; the desktop rail is icon-only, so it gets the minimal
              mark alone. */}
          {isMobile ? (
            <VoniLogo size="md" wordmark animate />
          ) : (
            <VoniLogo size="lg" animate />
          )}
          <span className="sr-only">Voni dashboard</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    isActive={pathname.startsWith(item.url)}
                    tooltip={item.title}
                    className="text-sidebar-foreground/60 group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-2! [&_svg]:size-5!"
                    render={
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    }
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
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
      </SidebarFooter>
    </Sidebar>
  );
}
