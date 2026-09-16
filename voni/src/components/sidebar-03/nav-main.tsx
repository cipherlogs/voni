"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import type React from "react";
import { useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export type Route = {
  id: string;
  title: string;
  icon?: React.ReactNode;
  link: string;
  subs?: {
    title: string;
    link: string;
    icon?: React.ReactNode;
  }[];
};

/**
 * Sidebar-03 main navigation (adapted).
 *
 * Upstream renders the collapsible parent via `CollapsibleTrigger
 * render={<SidebarMenuButton/>}`; this host's collapsible primitive is a
 * thin Base UI wrapper without a render prop, so the parent row styles live
 * on the trigger itself instead of nesting one button inside another.
 * Leaf rows keep the `SidebarMenuButton render={<Link/>}` idiom with
 * tooltips for the collapsed rail.
 *
 * `badges` maps a route id to a text count (the Background jobs row). The
 * count renders inline when expanded and survives the collapsed rail as a
 * corner pill, so the state is never icon-only in either density.
 */
export default function DashboardNavigation({
  routes,
  badges,
  activePath,
}: {
  routes: Route[];
  badges?: Record<string, string>;
  /** Current path, or null while prerendering without URL access. */
  activePath?: string | null;
}) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [openCollapsible, setOpenCollapsible] = useState<string | null>(null);

  return (
    <SidebarMenu>
      {routes.map((route) => {
        const isOpen = !isCollapsed && openCollapsible === route.id;
        const hasSubRoutes = !!route.subs?.length;
        const badge = badges?.[route.id] ?? null;
        const isActive =
          activePath != null &&
          route.link !== "#" &&
          activePath.startsWith(route.link);

        return (
          <SidebarMenuItem key={route.id}>
            {hasSubRoutes ? (
              <Collapsible
                className="w-full"
                onOpenChange={(open) =>
                  setOpenCollapsible(open ? route.id : null)
                }
                open={isOpen}
              >
                <CollapsibleTrigger
                  className={cn(
                    "flex w-full cursor-pointer items-center rounded-lg px-2 py-2 text-left text-sm ring-sidebar-ring outline-hidden transition-colors",
                    isOpen
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                    isCollapsed && "justify-center",
                  )}
                >
                  {route.icon}
                  {!isCollapsed && (
                    <span className="ml-2 flex-1 font-medium text-sm">
                      {route.title}
                    </span>
                  )}
                  {!isCollapsed && hasSubRoutes && (
                    <span className="ml-auto">
                      {isOpen ? (
                        <ChevronUp className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </span>
                  )}
                </CollapsibleTrigger>

                {!isCollapsed && (
                  <CollapsibleContent>
                    <SidebarMenuSub className="my-1 ml-3.5">
                      {route.subs?.map((subRoute) => (
                        <SidebarMenuSubItem
                          className="h-auto"
                          key={`${route.id}-${subRoute.title}`}
                        >
                          <SidebarMenuSubButton
                            isActive={
                              activePath != null &&
                              subRoute.link !== "#" &&
                              activePath.startsWith(subRoute.link)
                            }
                            render={
                              <Link
                                className="flex items-center rounded-md px-4 py-1.5 font-medium text-muted-foreground text-sm hover:bg-sidebar-accent hover:text-foreground"
                                href={subRoute.link}
                                prefetch={true}
                              />
                            }
                          >
                            {subRoute.title}
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                )}
              </Collapsible>
            ) : (
              <SidebarMenuButton
                isActive={isActive}
                render={
                  <Link
                    className={cn(
                      "relative flex items-center rounded-lg px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
                      isCollapsed && "justify-center",
                    )}
                    href={route.link}
                    prefetch={true}
                    aria-label={badge ? `${route.title}, ${badge} pending` : undefined}
                  />
                }
                tooltip={badge ? `${route.title} (${badge})` : route.title}
              >
                {route.icon}
                {!isCollapsed && (
                  <span className="sidebar-nav-label ml-2 font-medium text-sm">
                    {route.title}
                  </span>
                )}
                {badge ? (
                  <span
                    aria-hidden
                    className="sidebar-nav-badge bg-sidebar-accent text-sidebar-accent-foreground ml-auto rounded-full px-1.5 text-xs font-medium tabular-nums group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-1 group-data-[collapsible=icon]:right-1 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:py-px group-data-[collapsible=icon]:leading-none group-data-[collapsible=icon]:shadow-sm"
                  >
                    {badge}
                  </span>
                ) : null}
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
