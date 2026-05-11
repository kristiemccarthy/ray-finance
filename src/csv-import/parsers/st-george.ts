// ---------------------------------------------------------------------------
// St George bank CSV parser.
//
// St George's transaction export is comma-separated with a header row:
//   Date,Description,Debit,Credit,Balance
//
// Each data row uses Australian-style D/MM/YYYY dates, and exactly one of
// the Debit / Credit columns carries a value. Descriptions can contain
// commas inside quoted strings (e.g. `"PAYMENT TO SMITH, JOHN"`), so we
// rely on `csv-parse` for tokenisation rather than splitting by hand.
//
// We normalise the row into Ray's Plaid-convention sign at parse time so
// downstream code never has to think about who's positive vs negative.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { ImportedRow, Parser } from "../types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for any malformed input — header mismatch, bad date, etc. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_HEADERS = ["Date", "Description", "Debit", "Credit", "Balance"] as const;

/**
 * Map a *substring* in the bank's raw description to the canonical descriptor
 * we want stored. Used to merge streams that an upstream rename has
 * fragmented — the recurring detector groups by normalised description, so
 * two descriptors for the same payment look like two different streams.
 *
 * Lookup is case-insensitive substring (`includes`) on the original
 * description; the replacement is the *complete* descriptor that overwrites
 * the row's `description` field.
 */
const DESCRIPTION_ALIASES: Record<string, string> = {
  // Employer renamed payroll system from Proceder to Dayforce on/around
  // 2026-04-23. Same payment, same cadence, just different descriptor.
  // Map the new descriptor to the old one so the recurring detector
  // recognises them as one continuous stream.
  "uniting transact payroll": "Uniting (Nsw.Act 032425000000000000",

  // Merchant display cleanups. Bank descriptors are noisy ("Visa Purchase
  // 26Apr Amznprimeau Membersh Sydney So") — collapse to the readable
  // brand name so the upcoming-bills and forecast views are scannable.
  "amznprime": "Amazon Prime",
  "disneyplus": "Disney+",
  "youi": "Youi Insurance",
  "openai *chatgpt": "ChatGPT",
  "leonardoint": "Leonardo.ai",
  "audible": "Audible",
  "ezi*occom": "Occom Internet",
  "pet insurance chatswood": "Pet Insurance",
};

// ---------------------------------------------------------------------------
// Parser implementation
// ---------------------------------------------------------------------------

type RawRow = Record<string, string>;

export const parseStGeorge: Parser = {
  async parse(filePath: string): Promise<ImportedRow[]> {
    const text = await readFile(filePath, "utf8");

    let records: RawRow[];
    try {
      records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true,
        // St George export quirk: data rows have a trailing comma the
        // header doesn't, so each data row is one field wider. Allow it
        // — the extra unnamed cell is dropped automatically.
        relax_column_count: true,
      }) as RawRow[];
    } catch (err) {
      throw new ParseError(
        `St George CSV parse error: ${(err as Error).message}`,
      );
    }

    if (records.length === 0) {
      throw new ParseError(
        `St George CSV parse error: file "${filePath}" contained no data rows.`,
      );
    }

    validateHeaders(records[0]);

    const rows: ImportedRow[] = [];
    for (let i = 0; i < records.length; i++) {
      // +2 so messages align with what the user sees in their editor:
      // line 1 is the header, data starts at line 2.
      const lineNumber = i + 2;
      const record = records[i];

      const date = parseDate(record.Date ?? "", lineNumber);
      // Two-step: keep the post-normalisation, pre-alias string as
      // raw_description (stable identity for transaction_id), then apply
      // aliases to produce the display description shown to the user.
      const raw_description = normaliseDescription(record.Description ?? "");
      const description = applyAliases(raw_description);
      const debit = parseAmountField(record.Debit ?? "", "Debit", lineNumber);
      const credit = parseAmountField(record.Credit ?? "", "Credit", lineNumber);
      const amount = composeAmount(debit, credit, lineNumber);
      const balance = parseBalance(record.Balance ?? "");

      rows.push({ date, description, raw_description, amount, balance });
    }

    return rows;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateHeaders(firstRow: RawRow): void {
  const present = Object.keys(firstRow);
  const missing = REQUIRED_HEADERS.filter((h) => !present.includes(h));
  if (missing.length > 0) {
    throw new ParseError(
      `St George CSV parse error: missing required header(s) [${missing.join(", ")}]. Got [${present.join(", ")}]. Expected: [${REQUIRED_HEADERS.join(", ")}].`,
    );
  }
}

/**
 * Parse a `D/MM/YYYY` (or `DD/MM/YYYY`) date into ISO `YYYY-MM-DD`.
 * Day and month are zero-padded; the year is taken verbatim.
 */
function parseDate(field: string, lineNumber: number): string {
  const match = field.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) {
    throw new ParseError(
      `St George CSV parse error at line ${lineNumber}: invalid date "${field}", expected D/MM/YYYY.`,
    );
  }
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Parse a numeric Debit/Credit cell. Empty cells are zero. Non-empty
 * cells that fail to parse throw — silent fallback would mask data loss.
 */
function parseAmountField(
  field: string,
  columnName: string,
  lineNumber: number,
): number {
  const trimmed = field.trim();
  if (trimmed === "") return 0;
  const value = parseFloat(trimmed);
  if (Number.isNaN(value)) {
    throw new ParseError(
      `St George CSV parse error at line ${lineNumber}: could not parse ${columnName} value "${field}".`,
    );
  }
  return value;
}

/**
 * Combine the Debit and Credit columns into a single Plaid-convention
 * amount: positive = money out, negative = money in. Throws if neither
 * or both columns are populated, since that's not a valid St George row.
 */
function composeAmount(
  debit: number,
  credit: number,
  lineNumber: number,
): number {
  const debitPresent = debit !== 0;
  const creditPresent = credit !== 0;

  if (debitPresent && creditPresent) {
    throw new ParseError(
      `St George CSV parse error at line ${lineNumber}: both Debit (${debit}) and Credit (${credit}) populated; expected exactly one.`,
    );
  }
  if (!debitPresent && !creditPresent) {
    throw new ParseError(
      `St George CSV parse error at line ${lineNumber}: neither Debit nor Credit populated.`,
    );
  }

  // Debit = money out → positive in Plaid convention.
  // Credit = money in  → negative in Plaid convention.
  return debitPresent ? debit : -credit;
}

function parseBalance(field: string): number | null {
  const trimmed = field.trim();
  if (trimmed === "") return null;
  const value = parseFloat(trimmed);
  return Number.isNaN(value) ? null : value;
}

function normaliseDescription(field: string): string {
  return field.trim().replace(/\s+/g, " ");
}

/**
 * Rewrite descriptions that match a known alias substring (case-insensitive)
 * to a canonical descriptor. The full original is replaced by the alias
 * value — so two raw descriptors for the same recurring payment collapse
 * into one. Returns the input unchanged if no alias matches.
 */
function applyAliases(description: string): string {
  const lower = description.toLowerCase();
  for (const [needle, replacement] of Object.entries(DESCRIPTION_ALIASES)) {
    if (lower.includes(needle)) {
      return replacement;
    }
  }
  return description;
}
