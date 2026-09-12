"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Plus, TriangleAlert, Trash2 } from "lucide-react";
import {
  addPhoneNumberAction,
  bindPhoneNumberAction,
  removePhoneNumberAction,
} from "@/app/(dashboard)/numbers/actions";

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
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a number</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldGroup className="grid gap-4 sm:grid-cols-3">
            <Field>
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
            <Field>
              <FieldLabel htmlFor="new-label">Label</FieldLabel>
              <Input
                id="new-label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Marina office line"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-agent">Answered by</FieldLabel>
              <Select
                value={newAgent}
                onValueChange={(v) => setNewAgent(v ?? UNBOUND)}
              >
                <SelectTrigger id="new-agent" aria-label="Answered by" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={UNBOUND}>Platform default agent</SelectItem>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                        {agent.deployed ? "" : " (draft)"}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <div>
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
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Answered by</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {numbers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-32 text-center">
                      <span className="text-muted-foreground">
                        No numbers registered. Inbound calls are answered by the
                        platform default agent.
                      </span>
                    </TableCell>
                  </TableRow>
                ) : (
                  numbers.map((number) => (
                    <TableRow key={number.id} data-copilot-key={number.id}>
                      <TableCell className="font-mono text-xs">
                        {number.e164}
                      </TableCell>
                      <TableCell>{number.label ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Select
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
                            <SelectTrigger aria-label={`Agent for ${number.e164}`} className="w-56">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value={UNBOUND}>
                                  Platform default agent
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
                            <Badge variant="outline">draft — default used</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <LoadingButton
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${number.e164}`}
                          pending={pendingId === `remove:${number.id}`}
                          icon={<Trash2 />}
                          onClick={() =>
                            run(`remove:${number.id}`, () => removePhoneNumberAction(number.id), "Number removed.")
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
