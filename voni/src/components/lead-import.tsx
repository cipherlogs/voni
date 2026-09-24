"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleCheck, FileSpreadsheet, Upload, TriangleAlert, X } from "lucide-react";
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
const INITIAL_COPILOT_VERSION = "unselected";

export function LeadImport({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // The first server and client renders share a stable token. Selecting or
  // clearing a file still rotates to a fresh UUID before any request can run.
  const [copilotVersion, setCopilotVersion] = useState(INITIAL_COPILOT_VERSION);
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
  const [dragging, setDragging] = useState(false);

  const running =
    starting ||
    tracking.phase === "starting" ||
    tracking.phase === "waiting" ||
    tracking.phase === "backgrounded";
  const backgrounded = tracking.phase === "backgrounded";

  function applyTerminal(job: JobJson) {
    if (job.status === "succeeded") {
      setResult(job.result as ImportSummary);
      // Done: clear the picker so the finished file can't read as pending.
      setSelectedFile(null);
      setFileName(null);
      setPreflight(null);
      if (inputRef.current) inputRef.current.value = "";
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

  function pickFile(file: File | null) {
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
  }

  const pending = starting || running;

  return (
    <div className="flex flex-col gap-4" data-copilot-form="csv-import" data-copilot-version={copilotVersion}>
      {/* blocks.so file-upload-05: dashed drop zone, file rules, the
          chosen file with its status, then the action. Drop and the
          picker both route through pickFile (same validation). */}
      <div className="flex flex-col gap-3">
        <label
          htmlFor={`csv-${campaignId}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (pending || preflighting) return;
            pickFile(e.dataTransfer.files?.[0] ?? null);
          }}
          className={cn(
            "border-input has-focus-visible:ring-ring/50 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center text-sm transition-colors has-focus-visible:ring-3 sm:flex-row sm:gap-3",
            dragging && "border-primary bg-muted/50",
            (pending || preflighting) && "pointer-events-none opacity-50",
          )}
        >
          <Upload aria-hidden className="text-muted-foreground size-5" />
          <span>
            Drag and drop or{" "}
            <span className="font-medium underline underline-offset-4">choose a CSV</span>{" "}
            to import
          </span>
          <input
            ref={inputRef}
            id={`csv-${campaignId}`}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={pending || preflighting}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <p className="text-muted-foreground text-xs">
          Needs a header row with a phone column; name, source, consent and
          notes are used if present. Max 2 MB.{" "}
          <a
            href="/templates/leads.csv"
            download="leads-template.csv"
            className="text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2"
          >
            Download the template
          </a>
        </p>
        {fileName ? (
          <div className="bg-muted relative flex items-center gap-3 rounded-lg p-3">
            <span className="bg-background ring-input flex size-10 shrink-0 items-center justify-center rounded-md shadow-sm ring-1 ring-inset">
              <FileSpreadsheet aria-hidden className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{fileName}</p>
              <p className="text-muted-foreground mt-0.5 text-xs" aria-live="polite">
                {running && backgrounded
                  ? "Importing in the background — the jobs pill tracks progress."
                  : pending
                    ? "Importing…"
                    : preflighting
                      ? "Checking the file…"
                      : selectedFile && preflight?.ok
                        ? `About ${preflight.rowCount ?? 0} ${(preflight.rowCount ?? 0) === 1 ? "row" : "rows"} with a phone column · validated in the import job`
                        : selectedFile
                          ? "Ready to import · validated in the import job"
                          : "Can't import this file"}
              </p>
            </div>
            {!pending && !preflighting ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${fileName}`}
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
            ) : null}
          </div>
        ) : null}
        {running && backgrounded && tracking.jobId ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button nativeButton={false} render={<Link href="/jobs" />} variant="outline" size="sm">
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
          </div>
        ) : selectedFile || pending ? (
          <div className="flex justify-end">
            <LoadingButton
              data-copilot-effect="mutation"
              aria-label={selectedFile ? `Import ${selectedFile.name}` : "Import selected CSV"}
              onClick={() => { if (selectedFile) void onFile(selectedFile); }}
              disabled={!selectedFile || pending}
              pending={pending && !backgrounded}
              pendingText="Importing…"
              icon={<Upload />}
              className="w-full sm:w-auto"
            >
              Import leads
            </LoadingButton>
          </div>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {result ? (
        <Alert>
          <CircleCheck />
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
