/**
 * Lead CSV import (plan Day 7-8).
 *
 * Pure, dependency-free, and deliberately separate from the server action that
 * writes rows: the interesting failure modes here are all about *data* — a
 * quoted field containing a comma, a UAE mobile written as `050 123 4567`, the
 * same person listed twice — and each of those is worth a test that does not
 * need a database.
 *
 * The contract with the caller is that every input row comes back accounted
 * for, as either a lead or an error carrying its 1-based line number. An
 * importer that silently drops rows is worse than one that rejects the file,
 * because the operator believes they imported 500 leads and actually imported
 * 480.
 */

/**
 * RFC 4180 CSV, with the two deviations real exports actually have: bare CR
 * line endings, and a UTF-8 BOM from Excel.
 *
 * Written by hand rather than pulled from npm because the whole grammar is the
 * 40 lines below, and this runs on Cloudflare Workers where every dependency
 * is bundle weight on a cold start.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false; // distinguishes a trailing newline from a blank last field

  const endField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      // Both CRLF and a bare CR terminate the row; consume the LF if present.
      if (text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      started = true;
    }
  }

  // A file ending without a newline still has a final row to flush; one ending
  // *with* a newline does not, or every import would gain a phantom blank lead.
  if (field.length > 0 || row.length > 0) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Column aliases, so an operator does not have to rename their export's headers. */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "lead name", "contact", "contact name", "first name"],
  phone: ["phone", "phone number", "mobile", "mobile number", "tel", "telephone", "number"],
  source: ["source", "lead source", "origin", "channel"],
  consent: ["consent", "consent status", "opt in", "opt-in", "optin"],
  notes: ["notes", "note", "comment", "comments", "preferences", "requirements"],
};

export type LeadColumnMap = Partial<Record<keyof typeof HEADER_ALIASES, number>>;

export function mapHeaders(header: string[]): LeadColumnMap {
  const normalized = header.map((h) => h.trim().toLowerCase().replace(/[_-]+/g, " "));
  const map: LeadColumnMap = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = normalized.findIndex((h) => aliases.includes(h));
    if (index !== -1) map[field as keyof LeadColumnMap] = index;
  }
  return map;
}

/**
 * Best-effort E.164, with the national-format cases a human-typed CSV actually
 * contains.
 *
 * This is the "real parsing" the telephony bridge's `normalize_phone` docstring
 * defers to the importer, and it stops short of libphonenumber on purpose: full
 * validation needs a 200KB metadata table to tell a valid UAE mobile prefix
 * from an invalid one, and the cost of being slightly permissive is one failed
 * dial, which the attempt log already records.
 *
 * `defaultCountryCode` is digits without the plus, e.g. "971".
 */
export function normalizePhoneE164(
  raw: string,
  defaultCountryCode: string,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // An extension ("+971 4 123 4567 x22") is not part of the dialable number and
  // would otherwise be concatenated into it.
  const withoutExtension = trimmed.split(/\b(?:ext|extension|x)\.?\s*\d+$/i)[0];

  const hasPlus = withoutExtension.trimStart().startsWith("+");
  let digits = withoutExtension.replace(/\D/g, "");
  if (!digits) return null;

  if (!hasPlus) {
    if (digits.startsWith("00")) {
      digits = digits.slice(2); // international prefix, already country-coded
    } else if (!digits.startsWith(defaultCountryCode)) {
      // A national number: strip the trunk prefix, then add the country code.
      // The subscriber part is length-checked *before* prepending — otherwise a
      // truncated cell like "12345" becomes "+97112345", which is long enough
      // to look valid and would be dialled for real.
      const national = digits.replace(/^0+/, "");
      if (national.length < 6) return null;
      digits = defaultCountryCode + national;
    }
  }

  // E.164 caps the whole number at 15 digits; below 8 is not a routable
  // international number and is almost always a truncated cell.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export type ParsedLead = {
  line: number;
  name: string | null;
  phone: string;
  source: string | null;
  consentStatus: "granted" | "revoked" | "unknown";
  notes: string | null;
};

export type RowError = { line: number; message: string };

export type LeadCsvResult = {
  leads: ParsedLead[];
  errors: RowError[];
  /** Rows dropped because an earlier row in the same file had that number. */
  duplicates: number;
  columns: LeadColumnMap;
};

const TRUTHY_CONSENT = new Set(["yes", "y", "true", "1", "granted", "opted in", "opt in"]);
const FALSY_CONSENT = new Set(["no", "n", "false", "0", "revoked", "opted out", "opt out"]);

function readConsent(raw: string | undefined): ParsedLead["consentStatus"] {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (TRUTHY_CONSENT.has(value)) return "granted";
  if (FALSY_CONSENT.has(value)) return "revoked";
  return "unknown";
}

export function parseLeadCsv(
  input: string,
  defaultCountryCode = "971",
): LeadCsvResult {
  const rows = parseCsv(input);
  if (rows.length === 0) {
    return { leads: [], errors: [{ line: 0, message: "The file is empty." }], duplicates: 0, columns: {} };
  }

  const columns = mapHeaders(rows[0]);
  if (columns.phone === undefined) {
    return {
      leads: [],
      errors: [
        {
          line: 1,
          message:
            "No phone column found. Add a header row with a column named phone, mobile, or number.",
        },
      ],
      duplicates: 0,
      columns,
    };
  }

  const leads: ParsedLead[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 1; // 1-based, counting the header, so it matches a spreadsheet
    const cell = (index: number | undefined) =>
      index === undefined ? undefined : row[index]?.trim();

    const rawPhone = cell(columns.phone) ?? "";
    if (!rawPhone) {
      errors.push({ line, message: "Missing phone number." });
      continue;
    }

    const phone = normalizePhoneE164(rawPhone, defaultCountryCode);
    if (!phone) {
      errors.push({ line, message: `"${rawPhone}" is not a usable phone number.` });
      continue;
    }

    // Within one file, first occurrence wins. Across files the database's
    // unique index on (organization_id, phone) is the real guard.
    if (seen.has(phone)) {
      duplicates++;
      continue;
    }
    seen.add(phone);

    leads.push({
      line,
      name: cell(columns.name) || null,
      phone,
      source: cell(columns.source) || null,
      consentStatus: readConsent(cell(columns.consent)),
      notes: cell(columns.notes) || null,
    });
  }

  return { leads, errors, duplicates, columns };
}
