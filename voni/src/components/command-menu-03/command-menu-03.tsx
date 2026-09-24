"use client";

/**
 * Adapted from Blocks `@blocks-so/command-menu-03` (MIT, Ephraim Duncan).
 * The searchable grouped command composition is retained. Documentation and
 * color-copy demo commands were replaced with Voni's authenticated routes.
 */

import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  CalendarCheck,
  CircleUserRound,
  CornerDownLeft,
  Megaphone,
  Search,
  Settings,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";
import { NAV_ITEMS } from "@/components/app-sidebar";
import { useShellAuth } from "@/components/shell-auth";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";

type CommandItemDefinition = {
  label: string;
  href: string;
  keywords: string[];
  icon: ComponentType;
};

export const CREATE_COMMANDS: CommandItemDefinition[] = [
  {
    label: "New agent",
    href: "/agents/new",
    keywords: ["create", "agent", "voice"],
    icon: Bot,
  },
  {
    label: "New campaign",
    href: "/campaigns/new",
    keywords: ["create", "campaign", "outreach"],
    icon: Megaphone,
  },
];

export const DRILL_DOWN_COMMANDS: CommandItemDefinition[] = [
  {
    label: "Worked leads",
    href: "/leads?stage=worked",
    keywords: ["dashboard", "outcome", "worked", "leads"],
    icon: UserRoundCheck,
  },
  {
    label: "Connected calls",
    href: "/calls?outcome=connected",
    keywords: ["dashboard", "outcome", "connected", "calls"],
    icon: CircleUserRound,
  },
  {
    label: "Booked leads",
    href: "/leads?stage=booked",
    keywords: ["dashboard", "outcome", "booked", "appointments"],
    icon: CalendarCheck,
  },
  {
    label: "Needs human handoff",
    href: "/leads?stage=handoff",
    keywords: ["dashboard", "outcome", "handoff", "blocked"],
    icon: CircleUserRound,
  },
];

export function isCommandMenuEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function CommandMenu03() {
  const router = useRouter();
  const auth = useShellAuth();
  const [open, setOpen] = useState(false);

  const runCommand = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandKey =
        event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
      if ((!commandKey && event.key !== "/") || event.defaultPrevented) return;
      if (isCommandMenuEditableTarget(event.target)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const navigation: CommandItemDefinition[] = [
    ...NAV_ITEMS.map((item) => ({
      label: item.title,
      href: item.url,
      keywords: [item.title.toLowerCase(), "navigate", "workspace"],
      icon: item.icon,
    })),
    {
      label: "Settings",
      href: "/settings",
      keywords: ["settings", "preferences", "account"],
      icon: Settings,
    },
    ...(auth.status === "authenticated" && auth.platformAdmin
      ? [
          {
            label: "Platform operator",
            href: "/operator",
            keywords: ["operator", "platform", "admin"],
            icon: ShieldCheck,
          },
        ]
      : []),
  ];

  const renderItems = (items: CommandItemDefinition[]) =>
    items.map((item) => (
      <CommandItem
        key={item.href}
        keywords={item.keywords}
        onSelect={() => runCommand(item.href)}
        value={item.label}
      >
        <item.icon aria-hidden="true" />
        <span>{item.label}</span>
      </CommandItem>
    ));

  return (
    <>
      {/* Rail-aware trigger: full search row when the rail is expanded,
          centered icon when it is collapsed. Lives in the sidebar since
          the top bar was removed; the global shortcut below keeps working
          with no visible trigger at all. */}
      <Button
        type="button"
        variant="ghost"
        className="h-8 w-full cursor-pointer justify-start gap-2 px-2 text-sm group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"
        aria-label="Search Voni"
        aria-keyshortcuts="Meta+K Control+K /"
        onClick={() => setOpen(true)}
      >
        <Search aria-hidden="true" />
        <span className="flex-1 text-left font-medium group-data-[collapsible=icon]:hidden">
          Search
        </span>
        <Kbd className="hidden lg:inline-flex group-data-[collapsible=icon]:hidden">⌘ K</Kbd>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Voni command menu"
        description="Search workspace destinations and actions."
        className="overflow-hidden p-0 sm:max-w-lg"
      >
        <Command className="rounded-none p-0">
          <CommandInput placeholder="Search Voni…" autoFocus />
          <CommandList className="min-h-72">
            <CommandEmpty>No matching command.</CommandEmpty>
            <CommandGroup heading="Navigate">
              {renderItems(navigation)}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Create">
              {renderItems(CREATE_COMMANDS)}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Dashboard views">
              {renderItems(DRILL_DOWN_COMMANDS)}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="flex h-10 items-center gap-2 border-t bg-muted/50 px-4 text-xs font-medium text-muted-foreground">
          <Kbd>
            <CornerDownLeft aria-hidden="true" />
          </Kbd>
          Select
          <span className="ml-auto">Esc to close</span>
        </div>
      </CommandDialog>
    </>
  );
}
