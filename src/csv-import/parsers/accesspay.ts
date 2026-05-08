// ---------------------------------------------------------------------------
// AccessPay PDF statement parser.
//
// AccessPay (a salary-packaging benefits provider) issues monthly statements
// as PDFs. Each transaction line in the rendered PDF looks like:
//
//   6/06/2025  COLES 0924 ROUSE HILL AUS (DTXN)  -$49.80  $0.00  $1172.05
//   24/06/2025  Card funded by AccessPay            $0.00  $599.30 $1599.30
//
// Format:
//   <D/MM/YYYY>  <description>  <debit>  <credit>  <balance>
//
// We extract text via `pdf-parse`, then walk it line by line. Lines that
// don't match the transaction shape (headers, footers, page totals, the
// "Generated on …" trailer, etc.) are silently skipped. This is robust to
// extra cover-page chrome at the cost of being unable to flag a malformed
// transaction line — those will simply be missing from the output.
//
// Sign convention:
//   AccessPay debits are stored as NEGATIVE numbers (`-$49.80`) and credits
//   as POSITIVE numbers (`$599.30`). Plaid (Ray's internal convention) is
//   the OPPOSITE: positive = money out, negative = money in. We compose
//   `amount = -debit - credit` to flip into Plaid sign at parse time.
//
// Worked examples:
//   - Card purchase: debit=-49.80, credit=0.00
//       → amount = -(-49.80) - 0.00 = +49.80   (money out, Plaid-positive)
//   - Salary load:   debit=  0.00, credit=599.30
//       → amount = -(0.00) - 599.30 = -599.30 (money in,  Plaid-negative)
//
// Zero-amount rows (e.g. "Maintenance fee charged" entries with both
// columns at $0.00) are dropped — they're informational only.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
// `pdf-parse@1.1.1`'s top-level `index.js` tries to read a bundled test
// PDF at import time when it's loaded outside the package's own debug
// script. Importing the inner module directly skips that side effect.
// See https://gitlab.com/autokent/pdf-parse/issues/24.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import type { ImportedRow, Parser } from "../types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for any malformed input — file unreadable, PDF parse failure. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Single-line transaction shape:
 *   1  date         D/MM/YYYY or DD/MM/YYYY
 *   2  description  non-greedy, anything up to the first money column
 *   3  debit        e.g. "-$49.80" or "$0.00"
 *   4  credit       same shape
 *   5  balance      same shape (may carry leading minus on overdrawn cards)
 */
// pdf-parse strips inter-column whitespace, so each row arrives as the
// fields concatenated directly. Each field's own shape (D/MM/YYYY date,
// $-prefixed monetary value) provides enough structure to parse without
// explicit separators.
const TRANSACTION_LINE = /^(\d{1,2}\/\d{1,2}\/\d{4})(.+?)(-?\$[\d,]+\.\d{2})(-?\$[\d,]+\.\d{2})(-?\$[\d,]+\.\d{2})$/;

/** Trailing `(DTXN)` marker on card-purchase descriptions. */
const DTXN_SUFFIX = /\s*\(DTXN\)\s*$/;

// ---------------------------------------------------------------------------
// Parser implementation
// ---------------------------------------------------------------------------

export const parseAccessPay: Parser = {
  async parse(filePath: string): Promise<ImportedRow[]> {
    let text: string;
    try {
      const buffer = await readFile(filePath);
      const result = await pdfParse(buffer);
      text = result.text;
    } catch (err) {
      throw new ParseError(
        `AccessPay PDF parse error: ${(err as Error).message}`,
      );
    }

    const lines = text.split(/\r?\n/);
    const rows: ImportedRow[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "") continue;

      const match = TRANSACTION_LINE.exec(line);
      if (!match) continue;

      const [, dateField, descField, debitField, creditField, balanceField] = match;

      const date = parseDate(dateField);
      if (date === null) continue;

      const debit = parseMoney(debitField);
      const credit = parseMoney(creditField);
      // SIGN FLIP: AccessPay debit is negative, credit is positive.
      // Plaid wants positive=out, negative=in, so negate the sum.
      const amount = -debit - credit;

      // Skip informational zero-amount rows (e.g. maintenance fee 0/0).
      if (amount === 0) continue;

      const balance = parseMoney(balanceField);

      const description = stripDtxn(normaliseDescription(descField));

      rows.push({ date, description, amount, balance });
    }

    return rows;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `D/MM/YYYY` (or `DD/MM/YYYY`) date into ISO `YYYY-MM-DD`.
 * Returns `null` on malformed input so the caller can skip the line —
 * unlike the St George parser, which throws, we tolerate weird PDF output
 * because the regex pre-filter has already vouched for the shape.
 */
function parseDate(field: string): string | null {
  const match = field.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Parse a `$1,234.56` / `-$49.80` / `$0.00` style amount into a number.
 * Strips the currency symbol and thousands separators. Returns `0` on
 * unparseable input — again, the regex pre-filter has vouched for shape.
 */
function parseMoney(field: string): number {
  const cleaned = field.replace(/[$,]/g, "");
  const value = parseFloat(cleaned);
  return Number.isNaN(value) ? 0 : value;
}

function normaliseDescription(field: string): string {
  return field.trim().replace(/\s+/g, " ");
}

function stripDtxn(description: string): string {
  return description.replace(DTXN_SUFFIX, "").trim();
}
