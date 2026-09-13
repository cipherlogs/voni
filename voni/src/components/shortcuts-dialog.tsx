"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Keyboard shortcuts dialog + global key handler. Client leaf on purpose:
 * the global keydown listener and router.push navigation must never run in
 * the server shell (E1439) — this component mounts under the already-client
 * AppHeader and touches the URL only through the client router.
 *
 * Ignores keystrokes from editable targets (input / textarea / select /
 * contentEditable) so typing never triggers navigation. Modifier combos
 * (Ctrl/Cmd/Alt) are left alone so browser and app chords keep working.
 */

const PENDING_G_WINDOW_MS = 800;

/** 1–4 jump to the existing dashboard drill-down lists. Order matches the
 *  dashboard outcome cards so the number reads as the card's position. */
const FILTER_SHORTCUTS = [
  { key: "1", label: "Worked leads", href: "/leads?stage=worked" },
  { key: "2", label: "Connected calls", href: "/calls?outcome=connected" },
  { key: "3", label: "Booked leads", href: "/leads?stage=booked" },
  { key: "4", label: "Leads needing handoff", href: "/leads?stage=handoff" },
] as const;

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      data-slot="kbd"
      className="inline-flex min-w-5 items-center justify-center rounded border bg-muted px-1 py-0.5 font-mono text-xs font-medium text-muted-foreground"
    >
      {children}
    </kbd>
  );
}

function ShortcutRow({
  keys,
  label,
}: {
  keys: React.ReactNode;
  label: string;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-1">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="flex shrink-0 items-center gap-1">{keys}</span>
    </li>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('[contenteditable="true"]')) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Name links in the list tables, without the duplicate "Open call" links. */
function listNameLinks(): HTMLAnchorElement[] {
  const anchors = Array.from(
    document.querySelectorAll<HTMLElement>(
      'main a[href^="/leads/"], main a[href^="/calls/"]',
    ),
  );
  return anchors.filter((el) => {
    if (!(el instanceof HTMLAnchorElement)) return false;
    const label = el.getAttribute("aria-label") ?? "";
    if (label.startsWith("Open call")) return false;
    if (el.textContent?.trim() === "Open call") return false;
    return true;
  }) as HTMLAnchorElement[];
}

function focusNeighbor(direction: 1 | -1) {
  const links = listNameLinks();
  if (links.length === 0) return;
  const active = document.activeElement;
  const current = links.indexOf(active as HTMLAnchorElement);
  let next: number;
  if (current === -1) {
    next = direction === 1 ? 0 : links.length - 1;
  } else {
    next = (current + direction + links.length) % links.length;
  }
  links[next]?.focus();
}

function toggleBulkCheckbox() {
  const boxes = Array.from(
    document.querySelectorAll<HTMLElement>(
      'main [role="checkbox"], main input[type="checkbox"]',
    ),
  );
  if (boxes.length === 0) return;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement ? boxes.indexOf(active) : -1;
  const target = focused === -1 ? boxes[0] : boxes[focused];
  target?.click();
}

export function ShortcutsDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open ]);
  const pendingG = useRef<number | null>(null);

  const clearPendingG = () => {
    if (pendingG.current !== null) {
      window.clearTimeout(pendingG.current);
      pendingG.current = null;
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key;

      // Escape: cancel a pending g-chord first; when the dialog is open let
      // Base UI close it; otherwise clear an active list filter.
      if (key === "Escape") {
        if (pendingG.current !== null) {
          clearPendingG();
          return;
        }
        if (openRef.current) return;
        const pathname = window.location.pathname;
        const params = new URLSearchParams(window.location.search);
        if (pathname.startsWith("/leads") && params.has("stage")) {
          router.push("/leads");
          return;
        }
        if (pathname.startsWith("/calls") && params.has("outcome")) {
          router.push("/calls");
        }
        return;
      }

      // While open, only ? toggles closed — other shortcuts stay inert
      // behind the modal.
      if (openRef.current) {
        if (key === "?") {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }

      if (key === "?") {
        event.preventDefault();
        clearPendingG();
        setOpen(true);
        return;
      }

      // Pending g-chord: g then d / l / c navigates; anything else cancels
      // the window and falls through to normal handling below.
      if (pendingG.current !== null) {
        if (key === "g") {
          clearPendingG();
          pendingG.current = window.setTimeout(
            clearPendingG,
            PENDING_G_WINDOW_MS,
          );
          return;
        }
        const dest =
          key === "d"
            ? "/dashboard"
            : key === "l"
              ? "/leads"
              : key === "c"
                ? "/calls"
                : null;
        clearPendingG();
        if (dest) {
          router.push(dest);
          return;
        }
      } else if (key === "g") {
        pendingG.current = window.setTimeout(
          clearPendingG,
          PENDING_G_WINDOW_MS,
        );
        return;
      }

      if (key === "j") {
        if (listNameLinks().length > 0) {
          event.preventDefault();
          focusNeighbor(1);
        }
        return;
      }
      if (key === "k") {
        if (listNameLinks().length > 0) {
          event.preventDefault();
          focusNeighbor(-1);
        }
        return;
      }
      if (key === "x") {
        toggleBulkCheckbox();
        return;
      }

      const filter = FILTER_SHORTCUTS.find((f) => f.key === key);
      if (filter) {
        router.push(filter.href);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
      }
    };
  }, [router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            title="Keyboard shortcuts (?)"
            className="cursor-pointer"
          />
        }
      >
        <Keyboard aria-hidden />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts never fire while typing — they are ignored in inputs,
            textareas, selects, and rich-text fields.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <section aria-label="Dialog">
            <h3 className="text-sm font-medium">Dialog</h3>
            <ul>
              <ShortcutRow keys={<Kbd>?</Kbd>} label="Open or close shortcuts" />
            </ul>
          </section>
          <section aria-label="Go to">
            <h3 className="text-sm font-medium">Go to</h3>
            <ul>
              <ShortcutRow
                keys={
                  <>
                    <Kbd>g</Kbd>
                    <span className="text-muted-foreground text-xs">then</span>
                    <Kbd>d</Kbd>
                  </>
                }
                label="Dashboard"
              />
              <ShortcutRow
                keys={
                  <>
                    <Kbd>g</Kbd>
                    <span className="text-muted-foreground text-xs">then</span>
                    <Kbd>l</Kbd>
                  </>
                }
                label="Leads"
              />
              <ShortcutRow
                keys={
                  <>
                    <Kbd>g</Kbd>
                    <span className="text-muted-foreground text-xs">then</span>
                    <Kbd>c</Kbd>
                  </>
                }
                label="Calls"
              />
            </ul>
            <p className="text-muted-foreground text-xs">
              Press <Kbd>g</Kbd> then a letter within a second;{" "}
              <Kbd>Esc</Kbd> cancels.
            </p>
          </section>
          <section aria-label="Lists">
            <h3 className="text-sm font-medium">Lists</h3>
            <ul>
              <ShortcutRow
                keys={
                  <>
                    <Kbd>j</Kbd>
                    <Kbd>k</Kbd>
                  </>
                }
                label="Move between lead names"
              />
              <ShortcutRow keys={<Kbd>x</Kbd>} label="Toggle bulk checkbox" />
            </ul>
          </section>
          <section aria-label="Filters">
            <h3 className="text-sm font-medium">Filters</h3>
            <ul>
              {FILTER_SHORTCUTS.map((f) => (
                <ShortcutRow
                  key={f.key}
                  keys={<Kbd>{f.key}</Kbd>}
                  label={f.label}
                />
              ))}
              <ShortcutRow keys={<Kbd>Esc</Kbd>} label="Clear list filter" />
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
