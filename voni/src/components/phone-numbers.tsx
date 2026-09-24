"use client";

import { DataTable } from "@/components/data-table";
import { StatusDot } from "@/components/status-dot";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { RowActions } from "@/components/row-actions";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  FormCard,
  FormSection,
  FormSectionHeading,
  FormActions,
} from "@/components/wizard/form-layout";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Phone,
  Plus,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { addPhoneNumberAction, bindPhoneNumberAction, removePhoneNumberAction } from "@/app/(dashboard)/numbers/actions";

type PhoneNumber = {
  id: string;
  e164: string;
  label: string | null;
  inboundEnabled: boolean;
  agentId: string | null;
  agentName: string | null;
  agentDeployed: string | null;
};

const UNBOUND = "__unbound__";

/**
 * Row "…" menu for a number. Remove opens the shared typed-confirm dialog
 * (the gate is the label when set, else the number); ownership stays
 * enforced server-side by removePhoneNumberAction.
 */
function NumberRowActions({ number }: { number: PhoneNumber }) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const label = number.label?.trim() || null;
  return (
    <>
      <RowActions label={`Actions for ${number.e164}`}>
        <DropdownMenuItem variant="destructive" onClick={() => setRemoveOpen(true)}>
          <Trash2 />
          Remove number
        </DropdownMenuItem>
      </RowActions>
      <DeleteConfirmDialog
        layout="none"
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        id={number.id}
        name={label ?? number.e164}
        triggerLabel="Remove number"
        description="This is permanent. Type the number's label to confirm."
        consequence={
          <>
            This number stops answering inbound calls
            {number.agentName ? ` for ${number.agentName}` : ""}. Call history is
            kept. This cannot be undone.
          </>
        }
        fieldLabel={label ? "Number label" : "Number"}
        confirmLabel="Remove number"
        confirmAction={async (id) => {
          const result = await removePhoneNumberAction(id);
          return result.ok
            ? { ok: true }
            : { ok: false, message: result.message ?? "That did not work." };
        }}
      />
    </>
  );
}

/**
 * Inbound number binding (plan Day 7-8).
 *
 * Binding is edited inline in the table rather than behind a modal: the whole
 * decision is one number and one agent, and the answer to "which agent picks up
 * this line" should be readable and changeable in the same glance.
 */
export function PhoneNumbers({
  numbers,
  agents,
}: {
  numbers: PhoneNumber[];
  agents: { id: string; name: string; deployed: string | null }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newNumber, setNewNumber] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newAgent, setNewAgent] = useState<string>(UNBOUND);
  // Client-side format echo of the server's E.164 normaliser: anything with
  // fewer than 8 dialable digits (or more than 15) can never normalise, so
  // it is flagged inline as it is typed rather than after a round trip.
  // The server stays authoritative — this never blocks submission.
  const dialableDigits = newNumber.replace(/\D/g, "");
  const numberFormatError =
    newNumber.trim().length > 0 &&
    (dialableDigits.length < 8 || dialableDigits.length > 15)
      ? "That number looks too short to dial — check for a missing country or area code."
      : null;

  // Closed-trigger label: Base UI's SelectValue resolves its text from
  // registered items, but popup items only mount while the dropdown is open —
  // so a closed trigger falls back to the raw value ("__unbound__", or an
  // agent UUID as on campaigns/new). A value-to-label function child renders
  // the human label at all times with no mounted-item dependency.
  // The platform default is the named fallback agent configured for
  // inbound calls, not an anonymous answering machine — so the unbound
  // option names it. __unbound__ stays internal: it is the Select value,
  // never rendered text.
  const agentItems: Record<string, string> = {
    [UNBOUND]: "Main reception agent answers",
    ...Object.fromEntries(
      agents.map((agent) => [agent.id, `${agent.name}${agent.deployed ? "" : " (draft)"}`]),
    ),
  };

  // Tracked per-action (not one shared boolean) so clicking one row's remove
  // button doesn't visually disable every other row with no way to tell which
  // action is actually in flight.
  const run = (
    id: string,
    work: () => Promise<{ ok: boolean; message?: string }>,
    successMessage?: string,
  ) =>
    startTransition(async () => {
      setError(null);
      setPendingId(id);
      const result = await work();
      setPendingId(null);
      if (!result.ok) {
        setError(result.message ?? "That did not work.");
      } else {
        if (successMessage) toast.add({ type: "success", title: successMessage });
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-6">
      <FormCard>
        <>
          <FormSection
            aria-labelledby="add-number-heading"
            heading={
              <FormSectionHeading
                id="add-number-heading"
                title="Add a number"
                description="Numbers must be in international format. Unassigned numbers go to the main reception agent."
              />
            }
          >
            <div className="flex flex-col gap-4">
              <FieldGroup className="grid gap-4 sm:grid-cols-6">
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="new-number">Number</FieldLabel>
                  <Input
                    id="new-number"
                    value={newNumber}
                    onChange={(e) => setNewNumber(e.target.value)}
                    placeholder="+971 4 123 4567"
                    aria-invalid={numberFormatError ? true : undefined}
                    aria-describedby={
                      numberFormatError ? "new-number-error" : undefined
                    }
                  />
                  {numberFormatError ? (
                    <FieldError id="new-number-error">
                      {numberFormatError}
                    </FieldError>
                  ) : null}
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="new-label">Label</FieldLabel>
                  <Input
                    id="new-label"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Marina office line"
                  />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="new-agent">Answered by</FieldLabel>
                  <Select
                    items={agentItems}
                    value={newAgent}
                    onValueChange={(v) => setNewAgent(v ?? UNBOUND)}
                  >
                    <SelectTrigger id="new-agent" aria-label="Answered by" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={UNBOUND}>
                          Main reception agent answers
                        </SelectItem>
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agent.name}
                            {agent.deployed ? "" : " (draft)"}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Leave this on the main reception agent unless a
                    specific agent should pick up this line.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <FormActions>
                  <LoadingButton
                    disabled={!newNumber.trim()}
                    pending={pendingId === "add"}
                    pendingText="Adding…"
                    icon={<Plus />}
                  onClick={() =>
                    run(
                      "add",
                      async () => {
                        const result = await addPhoneNumberAction(
                          newNumber,
                          newLabel,
                          newAgent === UNBOUND ? null : newAgent,
                        );
                        if (result.ok) {
                          setNewNumber("");
                          setNewLabel("");
                          setNewAgent(UNBOUND);
                        }
                        return result;
                      },
                      "Number added.",
                    )
                  }
                >
                  Add number
                </LoadingButton>
              </FormActions>
            </div>
          </FormSection>
        </>
      </FormCard>

      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DataTable>
        {numbers.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="feature">
                <Phone />
              </EmptyMedia>
              <EmptyTitle>No numbers registered</EmptyTitle>
              <EmptyDescription>
                Inbound calls are answered by the main reception agent.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead className="hidden sm:table-cell">Label</TableHead>
                <TableHead>Answered by</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {numbers.map((number) => (
                    <TableRow key={number.id} data-copilot-key={number.id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-xs">{number.e164}</span>
                          {/* Phones: the label folds under the number. */}
                          {number.label ? (
                            <span className="text-muted-foreground text-xs sm:hidden">
                              {number.label}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{number.label ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Select
                            items={agentItems}
                            value={number.agentId ?? UNBOUND}
                            disabled={pendingId === `bind:${number.id}`}
                            onValueChange={(v) =>
                              run(
                                `bind:${number.id}`,
                                () =>
                                  bindPhoneNumberAction(
                                    number.id,
                                    v === UNBOUND || v === null ? null : v,
                                  ),
                                "Number updated.",
                              )
                            }
                          >
                            {/* Touch target: the default h-8 trigger reads
                                32px — min-h-11 lifts it toward the 44px floor
                                (WCAG 2.5.8) without widening the row trigger
                                past the row's own padding. */}
                            <SelectTrigger aria-label={`Agent for ${number.e164}`} className="min-h-11 w-44 sm:w-56">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value={UNBOUND}>
                                  Main reception agent answers
                                </SelectItem>
                                {agents.map((agent) => (
                                  <SelectItem key={agent.id} value={agent.id}>
                                    {agent.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          {/* A bound but unpublished agent silently falls back
                              to the default, which looks like the binding was
                              ignored — so say so here. */}
                          {number.agentId && !number.agentDeployed ? (
                            <StatusDot tone="warning" className="text-muted-foreground text-xs">
                              Draft agent — default answers
                            </StatusDot>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <NumberRowActions number={number} />
                      </TableCell>
                    </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataTable>
    </div>
  );
}
