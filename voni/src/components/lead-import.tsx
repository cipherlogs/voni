"use client";

import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, TriangleAlert, CircleCheck } from "lucide-react";
import type { JobJson } from "@/lib/jobs/serialize";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";

type ImportSummary = {
  imported: number;
  queued: number;
  alreadyInCampaign: number;
  duplicatesInFile: number;
  rejected: { line: number; message: string }[];
};

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
  const { addOptimistic, removeOptimistic, refresh } = useJobs();
  const tracking = useOptimisticJob("lead_csv_import");
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

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
    if (file.size > 2_000_000) {
      setError("That file is larger than 2 MB. Split it and try again.");
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
    <div className="flex flex-col gap-4" data-copilot-form="csv-import" data-copilot-version={copilotVersion}>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel htmlFor={`csv-${campaignId}`}>Choose CSV file</FieldLabel>
          <Input
            ref={inputRef}
            id={`csv-${campaignId}`}
            type="file"
            accept=".csv,text/csv"
            disabled={pending}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              requestKey.current = crypto.randomUUID();
              setCopilotVersion(requestKey.current);
              setSelectedFile(file && file.size <= 2_000_000 ? file : null);
              setFileName(file?.name ?? null);
              setResult(null);
              setError(file && file.size > 2_000_000 ? "That file is larger than 2 MB. Split it and try again." : null);
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
        <p className="w-full text-muted-foreground text-sm" aria-live="polite">
          {fileName && pending && !backgrounded
            ? fileName
            : running && backgrounded
              ? "This is continuing in the background. You can browse Voni and return when it is ready — the jobs pill tracks progress."
              : selectedFile ? `${selectedFile.name} selected (${selectedFile.size} bytes). Ready to import. A phone header is required; rows are validated in the import job.` : "Needs a header row with a phone column. Name, source, consent and notes are used if present."}
        </p>
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
          <AlertDescription>
            <div className="flex flex-col gap-2">
              <p className="font-medium text-foreground">
                {result.queued} queued for this campaign
                {result.imported !== result.queued
                  ? ` · ${result.imported} leads touched`
                  : ""}
              </p>
              <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
                {result.alreadyInCampaign > 0 ? (
                  <li>
                    {result.alreadyInCampaign} were already in this campaign and
                    were not queued again.
                  </li>
                ) : null}
                {result.duplicatesInFile > 0 ? (
                  <li>
                    {result.duplicatesInFile} duplicate{" "}
                    {result.duplicatesInFile === 1 ? "row" : "rows"} in the file
                    resolved to a number already listed.
                  </li>
                ) : null}
                {result.rejected.length > 0 ? (
                  <li className="text-destructive">
                    {result.rejected.length} row
                    {result.rejected.length === 1 ? "" : "s"} rejected:
                    <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                      {result.rejected.map((row) => (
                        <li key={row.line}>
                          Line {row.line} — {row.message}
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
