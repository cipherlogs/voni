import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignLeads, campaigns, leads } from "@/lib/db/schema";
import { parseLeadCsv } from "./csv";

export type ImportSummary = {
  imported: number;
  queued: number;
  alreadyInCampaign: number;
  duplicatesInFile: number;
  rejected: { line: number; message: string }[];
};

export class ImportCancelledError extends Error {
  constructor() {
    super("import cancelled");
    this.name = "ImportCancelledError";
  }
}

// One INSERT per chunk keeps a 2,000-row CSV to four round trips instead of
// 2,000, which matters over neon-http where each statement is its own request.
const CHUNK = 500;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type ProcessCsvImportParams = {
  organizationId: string;
  campaignId: string;
  csvText: string;
  /** Called after each insert chunk so callers can heartbeat progress. */
  onProgress?: (done: number, total: number) => Promise<void>;
  /** Called between chunks; throw ImportCancelledError to stop cleanly. */
  shouldCancel?: () => Promise<boolean>;
};

/**
 * Import a CSV of leads and queue them for one campaign.
 *
 * Shared by the campaign server action and the lead_csv_import job processor
 * so both paths enforce identical rules. Throws user-safe errors for fatal
 * problems (unknown campaign, oversize file, no usable rows); every other
 * row is accounted for in the returned summary — queued, already present,
 * duplicated in-file, or rejected with its spreadsheet line number.
 *
 * Leads are upserted on `(organization_id, phone)` — the canonical
 * cross-channel identity — so re-importing enriches rather than duplicates.
 * Two rules govern overwrites: a blank cell never erases stored data, and a
 * `revoked` consent is never lifted by an import. Chunked upserts make the
 * import idempotent across partial failures and retries.
 */
export async function processCsvImport(
  params: ProcessCsvImportParams,
): Promise<ImportSummary> {
  const { organizationId, campaignId, csvText } = params;

  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!campaign) throw new Error("Campaign not found.");

  if (csvText.length > 2_000_000) {
    throw new Error("That file is larger than 2 MB. Split it and try again.");
  }

  const parsed = parseLeadCsv(csvText);
  if (parsed.leads.length === 0) {
    throw new Error(
      parsed.errors[0]?.message ?? "No usable rows found in that file.",
    );
  }

  const total = parsed.leads.length;
  let done = 0;
  const leadIds: string[] = [];
  for (const batch of chunked(parsed.leads, CHUNK)) {
    if (params.shouldCancel && (await params.shouldCancel())) {
      throw new ImportCancelledError();
    }
    const rows = await db
      .insert(leads)
      .values(
        batch.map((lead) => ({
          organizationId,
          name: lead.name,
          phone: lead.phone,
          source: lead.source ?? "csv_import",
          consentStatus: lead.consentStatus,
          propertyPreferences: lead.notes ? { notes: lead.notes } : null,
        })),
      )
      .onConflictDoUpdate({
        target: [leads.organizationId, leads.phone],
        set: {
          // EXCLUDED is the incoming row, the bare column the stored one.
          name: sql`COALESCE(EXCLUDED.name, ${leads.name})`,
          source: sql`COALESCE(EXCLUDED.source, ${leads.source})`,
          propertyPreferences: sql`COALESCE(EXCLUDED.property_preferences, ${leads.propertyPreferences})`,
          consentStatus: sql`CASE WHEN ${leads.consentStatus} = 'revoked'
                                  THEN 'revoked'
                                  ELSE EXCLUDED.consent_status END`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: leads.id });
    leadIds.push(...rows.map((r) => r.id));
    done += batch.length;
    await params.onProgress?.(done, total);
  }

  let queued = 0;
  for (const batch of chunked(leadIds, CHUNK)) {
    if (params.shouldCancel && (await params.shouldCancel())) {
      throw new ImportCancelledError();
    }
    const rows = await db
      .insert(campaignLeads)
      .values(batch.map((leadId) => ({ campaignId, leadId })))
      // Re-importing must not re-queue someone already in this campaign, or a
      // second upload doubles how many times they get phoned.
      .onConflictDoNothing({
        target: [campaignLeads.campaignId, campaignLeads.leadId],
      })
      .returning({ id: campaignLeads.id });
    queued += rows.length;
    await params.onProgress?.(done, total);
  }

  return {
    imported: leadIds.length,
    queued,
    alreadyInCampaign: leadIds.length - queued,
    duplicatesInFile: parsed.duplicates,
    // A long error list is noise; the first twenty are enough to spot the
    // pattern, and the count tells the operator how bad it is.
    rejected: parsed.errors.slice(0, 20),
  };
}
