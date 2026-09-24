"use client";

import { BulkBar } from "@/components/bulk-bar";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { PencilLine, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LoadingButton } from "@/components/loading-button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableCell } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { bulkLeadsStageAction } from "@/app/(dashboard)/leads/actions";

/**
 * Raw `pipeline_state` values the bulk move can write. Derived aliases
 * (worked/booked/handoff) are excluded on purpose — they name query
 * predicates, not stored states, and the server rejects them too.
 */
const RAW_STAGES = ["new", "contacted", "completed"] as const;

const RAW_STAGE_LABEL: Record<(typeof RAW_STAGES)[number], string> = {
  new: "Not called yet",
  contacted: "Called",
  completed: "Done",
};

type Selection = {
  visible: string[];
  selected: Set<string>;
  toggle: (id: string, checked: boolean) => void;
  toggleAll: (checked: boolean) => void;
  register: (id: string) => void;
  unregister: (id: string) => void;
};

const LeadsSelectionContext = createContext<Selection | null>(null);

function useLeadsSelection(): Selection {
  const selection = useContext(LeadsSelectionContext);
  if (!selection) {
    throw new Error(
      "Leads selection islands must sit inside <LeadsSelection>.",
    );
  }
  return selection;
}

/**
 * Selection state for the leads table's visible rows. Wraps the table in the
 * page shell (never reads the URL itself, so the shell stays E1439-safe);
 * rows register from the Suspense rows leaf as they mount, so select-all
 * covers exactly the visible rows the server returned (the table caps at
 * 200). Unregistering on unmount prunes the set, so a filter change drops
 * stale ids instead of carrying them into the next view.
 *
 * The sticky bar (count + raw-stage Select + Apply) appears when count > 0.
 * Failed applies render an inline Alert; success toasts and refreshes.
 * House async pattern: LoadingButton + inline error + Base UI toast, same as
 * phone-numbers and the campaign queue bulk bar.
 */
export function LeadsSelection({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [visible, setVisible] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = useCallback((id: string) => {
    setVisible((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const unregister = useCallback((id: string) => {
    setVisible((prev) => prev.filter((v) => v !== id));
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      setSelected(() => {
        if (!checked) return new Set<string>();
        return new Set(visible);
      });
    },
    [visible],
  );

  const clear = useCallback(() => {
    setSelected(new Set());
    setStage(null);
    setError(null);
  }, []);

  const apply = useCallback(() => {
    if (applying || selected.size === 0 || !stage) return;
    setApplying(true);
    setError(null);
    void bulkLeadsStageAction({ ids: [...selected], stage }).then((result) => {
      setApplying(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const count = result.updated.length;
      toast.add({
        type: "success",
        title: `Moved ${count} lead${count === 1 ? "" : "s"}.`,
      });
      clear();
      router.refresh();
    });
  }, [applying, selected, stage, clear, router]);

  const selection = useMemo<Selection>(
    () => ({ visible, selected, toggle, toggleAll, register, unregister }),
    [visible, selected, toggle, toggleAll, register, unregister],
  );

  return (
    <LeadsSelectionContext.Provider value={selection}>
      {children}
      {selected.size > 0 ? (
        // table-05 selection-bar idiom: sticky bottom bar with count +
        // action controls, matching the campaign queue bulk toolbar.
        // Mount-only arrival via status-enter; unmount stays instant —
        // a true exit transition would keep the bar mounted through
        // dismissal and risk stale-selection bugs.
        <BulkBar label="Bulk lead actions" count={selected.size}>
          <Select items={RAW_STAGE_LABEL} value={stage} onValueChange={(v) => setStage(v)}>
            <SelectTrigger
              size="sm"
              aria-label="Stage to move selected leads to"
              className="w-auto min-w-40"
            >
              <SelectValue placeholder="Choose a stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RAW_STAGES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RAW_STAGE_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <LoadingButton
            size="sm"
            variant="outline"
            pending={applying}
            pendingText="Applying…"
            icon={<PencilLine />}
            disabled={!stage}
            onClick={apply}
          >
            Apply
          </LoadingButton>
          <Button
            size="sm"
            variant="ghost"
            disabled={applying}
            onClick={clear}
          >
            Clear
          </Button>
          {error ? (
            <Alert variant="destructive" className="basis-full">
              <TriangleAlert />
              <AlertTitle>Could not update those leads</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </BulkBar>
      ) : null}
    </LeadsSelectionContext.Provider>
  );
}

/** Header select-all over the visible (registered) rows. */
export function LeadsSelectAll() {
  const { visible, selected, toggleAll } = useLeadsSelection();
  const allSelected = visible.length > 0 && selected.size === visible.length;
  const someSelected = selected.size > 0 && !allSelected;
  return (
    <Checkbox
      checked={allSelected}
      indeterminate={someSelected}
      onCheckedChange={toggleAll}
      aria-label={`Select all ${visible.length} visible leads`}
    />
  );
}

/** Per-row checkbox island. Registers its row on mount, unregisters on unmount. */
export function LeadsSelectCell({
  id,
  name,
}: {
  id: string;
  name: string | null;
}) {
  const { selected, toggle, register, unregister } = useLeadsSelection();
  useEffect(() => {
    register(id);
    return () => unregister(id);
  }, [id, register, unregister]);
  return (
    <TableCell>
      <Checkbox
        checked={selected.has(id)}
        onCheckedChange={(checked) => toggle(id, checked)}
        aria-label={`Select lead ${name ?? "Unnamed"}`}
      />
    </TableCell>
  );
}
