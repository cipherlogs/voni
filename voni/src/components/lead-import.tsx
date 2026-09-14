"use client";

import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MascotAvatar } from "@/components/agent-wizard/guide-mascot";
import { FormCard, FormCardSections } from "@/components/wizard/form-layout";
import { Upload, TriangleAlert, X } from "lucide-react";
import type { JobJson } from "@/lib/jobs/serialize";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";
import { parseCsv, mapHeaders } from "@/lib/leads/csv";

type ImportSummary = {
  imported: number;
  queued: number;
  alreadyInCampaign: number;
  duplicatesInFile: number;
  rejected: { line: number; message: string }[];
};

/** Max bytes preflighted client-side (mirrors the upload route's 2 MB cap). */
const MAX_CSV_BYTES = 2_000_000;
/** Exact re-uploads are blocked client-side via this content hash. */
const seenContentHashes = new Set<string>();

/** djb2 content hash, hex — plenty for an in-memory re-upload guard. */
async function hashContent(text: string): Promise<string> {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

type Preflight = {
  ok: boolean;
  message?: string;
  /** Estimated data rows (header excluded), for the confirm copy. */
  rowCount?: number;
};

/**
 * Client-side preflight, before the durable upload: empty-file guard,
 * header-row sniff for a phone column (same alias map the server parses
 * with), and a row-count estimate so a 10k-row file is a deliberate choice.
 * The server stays authoritative — this never replaces its validation.
 */
function preflightCsv(text: string): Preflight {
  if (!text.trim()) {
    return { ok: false, message: "That file is empty — nothing to import." };
  }
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { ok: false, message: "That file is empty — nothing to import." };
  }
  const columns = mapHeaders(rows[0]);
  if (columns.phone === undefined) {
    return {
      ok: false,
      message:
        "No phone column found. Add a header row with a column named phone, mobile, or number.",
    };
  }
  return { ok: true, rowCount: Math.max(0, rows.length - 1) };
}

/**
 * CSV lead import as durable work.
 *
 * The file posts to the import-upload route (2 MB cap, private staging, 202
 * Accepted) and parsing runs as a lead_csv_import job, so leaving the page
 * mid-import loses nothing: the result waits in Jobs and links back to this
 * campaign. Staying put shows the same full accounting as before — queued,
 * already present, duplicated in-file, or rejected with spreadsheet line
 * numbers — once the job finishes.
 */
export function LeadImport({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [copilotVersion, setCopilotVersion] = useState(() => crypto.randomUUID());
  const requestKey = useRef(copilotVersion);
  const { addOptimistic, removeOptimistic, refresh, cancelJob } = useJobs();
  const tracking = useOptimisticJob("lead_csv_import");
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Client-side preflight snapshot for the selected file: row-count estimate
  // and header sniff, shown before the import starts.
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflighting, setPreflighting] = useState(false);

  const running =
    starting ||
    tracking.phase === "starting" ||
    tracking.phase === "waiting" ||
    tracking.phase === "backgrounded";
  const backgrounded = tracking.phase === "backgrounded";

  function applyTerminal(job: JobJson) {
    if (job.status === "succeeded") {
      setResult(job.result as ImportSummary);
      router.refresh();
      return;
    }
    setError(
      job.status === "cancelled"
        ? "Import was cancelled."
        : (job.errorMessage ?? "Import failed."),
    );
  }

  async function onFile(file: File) {
    if (file.size > MAX_CSV_BYTES) {
      setError("That file is larger than 2 MB. Split it and try again.");
      return;
    }
    if (file.size === 0) {
      setError("That file is empty — nothing to import.");
      return;
    }
    // Content-hash idempotency: an exact re-upload of already-imported bytes
    // is blocked with a pointer to the result, instead of parsing twice.
    const text = await file.text().catch(() => null);
    if (text === null) {
      setError("That file could not be read. Try selecting it again.");
      return;
    }
    const snap = preflightCsv(text);
    if (!snap.ok) {
      setError(snap.message ?? "That file cannot be imported.");
      return;
    }
    const digest = await hashContent(text);
    if (seenContentHashes.has(digest)) {
      setError(
        "This exact file was already imported — check the result below instead of uploading it again.",
      );
      return;
    }
    setFileName(file.name);
    setResult(null);
    setError(null);
    tracking.reset();
    setStarting(true);
    const optimistic = addOptimistic(`Import ${file.name}`, "lead_csv_import");
    try {
      const form = new FormData();
      form.set("campaignId", campaignId);
      form.set("file", file, file.name);
      form.set("idempotencyKey", requestKey.current);
      const res = await fetch("/api/jobs/import-upload", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const { error: message } = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(message ?? "Import could not start.");
        return;
      }
      const { jobId: id } = (await res.json()) as { jobId: string };
      // Remember the bytes so an exact re-upload is blocked client-side.
      seenContentHashes.add(digest);
      // The upload route returns 202 with a durable job: hand control back
      // at once and watch it. The pill appears immediately; slow imports
      // demote to background with a notice instead of a stuck button.
      tracking.trackExternal(
        id,
        { title: `Import ${file.name}`, kind: "lead_csv_import" },
        applyTerminal,
      );
    } catch {
      setError("Import could not start. Check your connection and retry.");
    } finally {
      removeOptimistic(optimistic);
      void refresh();
      setStarting(false);
    }
  }

  const pending = starting || running;

  return (
    <div className="flex max-w-xl flex-col gap-4" data-copilot-form="csv-import" data-copilot-version={copilotVersion}>
      <FormCard>
        <FormCardSections>
          <section aria-labelledby="csv-import-heading" className="flex flex-col gap-3">
            <div>
              <h3 id="csv-import-heading" className="text-balance font-semibold">CSV file</h3>
              <p className="text-pretty text-muted-foreground text-sm leading-6">
                Pick a file with a phone column; rows are validated in the import job.
              </p>
            </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="w-auto">
          <FieldLabel htmlFor={`csv-${campaignId}`}>Choose CSV file</FieldLabel>
          <Input
            ref={inputRef}
            id={`csv-${campaignId}`}
            type="file"
            accept=".csv,text/csv"
            disabled={pending || preflighting}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              requestKey.current = crypto.randomUUID();
              setCopilotVersion(requestKey.current);
              setResult(null);
              setPreflight(null);
              if (!file) {
                setSelectedFile(null);
                setFileName(null);
                setError(null);
                return;
              }
              if (file.size > MAX_CSV_BYTES) {
                setSelectedFile(null);
                setFileName(file.name);
                setError("That file is larger than 2 MB. Split it and try again.");
                return;
              }
              if (file.size === 0) {
                setSelectedFile(null);
                setFileName(file.name);
                setError("That file is empty — nothing to import.");
                return;
              }
              // Header-row sniff + row-count estimate before the import starts.
              setPreflighting(true);
              setSelectedFile(null);
              setFileName(file.name);
              setError(null);
              void file
                .text()
                .then((text) => {
                  const snap = preflightCsv(text);
                  if (!snap.ok) {
                    setError(snap.message ?? "That file cannot be imported.");
                    return;
                  }
                  setSelectedFile(file);
                  setPreflight(snap);
                })
                .catch(() => {
                  setError("That file could not be read. Try selecting it again.");
                })
                .finally(() => setPreflighting(false));
            }}
          />
        </Field>
        <div className="grid gap-2">
          <FieldLabel aria-hidden="true" className="invisible select-none">Import</FieldLabel>
          <LoadingButton
            variant="outline"
            data-copilot-effect="mutation"
            aria-label={selectedFile ? `Import ${selectedFile.name}` : "Import selected CSV"}
            onClick={() => { if (selectedFile) void onFile(selectedFile); }}
            disabled={!selectedFile || pending}
            pending={pending && !backgrounded}
            pendingText="Importing…"
            icon={<Upload />}
          >
            Import selected CSV
          </LoadingButton>
        </div>
        {selectedFile && !pending ? (
          <div className="grid gap-2">
            <FieldLabel aria-hidden="true" className="invisible select-none">Remove</FieldLabel>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${selectedFile.name}`}
              onClick={() => {
                setSelectedFile(null);
                setFileName(null);
                setError(null);
                setPreflight(null);
                requestKey.current = crypto.randomUUID();
                setCopilotVersion(requestKey.current);
                if (inputRef.current) inputRef.current.value = "";
              }}
            >
              <X />
            </Button>
          </div>
        ) : null}
        <p className="w-full text-muted-foreground text-sm" aria-live="polite">
          {fileName && pending && !backgrounded
            ? fileName
            : running && backgrounded
              ? "This is continuing in the background. You can browse Voni and return when it is ready — the jobs pill tracks progress."
              : preflighting
                ? "Checking the file…"
                : selectedFile && preflight?.ok
                  ? `${selectedFile.name} selected — about ${preflight.rowCount ?? 0} ${(preflight.rowCount ?? 0) === 1 ? "row" : "rows"} with a phone column. Rows are validated in the import job.`
                  : selectedFile ? `${selectedFile.name} selected (${selectedFile.size} bytes). Ready to import. A phone header is required; rows are validated in the import job.` : "Needs a header row with a phone column. Name, source, consent and notes are used if present."}
        </p>
        <p className="w-full text-sm">
          <a
            href="/templates/leads.csv"
            download="leads-template.csv"
            className="focus-visible:ring-ring cursor-pointer rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2"
          >
            Download the CSV template
          </a>
          <span className="text-muted-foreground"> — phone, name, source, consent, notes.</span>
        </p>
        {running && backgrounded && tracking.jobId ? (
          <p className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <Button
              nativeButton={false}
              render={<Link href="/jobs" />}
              variant="link"
              className="h-auto w-fit px-0"
            >
              View in Jobs
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const id = tracking.jobId;
                if (id) void cancelJob(id);
              }}
            >
              Cancel import
            </Button>
          </p>
        ) : null}
          </div>
          </section>
        </FormCardSections>
      </FormCard>

      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {result ? (
        <Alert>
          <MascotAvatar mood="celebrating" size="sm" />
          <AlertTitle>
            {result.queued}{" "}
            {result.queued === 1 ? "lead" : "leads"} added
            to the call list
            {result.imported !== result.queued
              ? ` · ${result.imported} in the file`
              : ""}
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-2">
              <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
                {result.alreadyInCampaign > 0 ? (
                  <li>
                    {result.alreadyInCampaign} already in the
                    call list — left as they were.
                  </li>
                ) : null}
                {result.duplicatesInFile > 0 ? (
                  <li>
                    {result.duplicatesInFile} duplicate{" "}
                    {result.duplicatesInFile === 1 ? "row" : "rows"} in the file
                    matched a number already listed.
                  </li>
                ) : null}
                {result.rejected.length > 0 ? (
                  <li className="text-destructive">
                    {result.rejected.length} skipped —{" "}
                    {result.rejected.length === 1 ? "row" : "rows"} need
                    a fix:
                    <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                      {result.rejected.map((row) => (
                        <li key={row.line}>
                          Row {row.line} needs {row.message}
                        </li>
                      ))}
                    </ul>
                  </li>
                ) : null}
              </ul>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
