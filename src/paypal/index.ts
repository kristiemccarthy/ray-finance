// ---------------------------------------------------------------------------
// PayPal CSV import + enrichment.
//
// PayPal hides the actual merchant behind opaque descriptors on the bank
// statement ("Paypal Australia 1050369369119"). Importing the "Completed
// Payments" CSV from PayPal gives us the merchant name PayPal itself
// recorded, plus a date and an amount we can match against the bank row.
//
// Strategy is wipe-and-replace: every import deletes the existing
// `paypal_transactions` rows and re-inserts. PayPal is the source of truth
// for what it knows. Re-running with a newer CSV updates the matches.
//
// Matching is deliberately conservative: only PayPal-prefixed bank rows
// are eligible, exact-amount + ±2-day windows, and any ambiguity drops
// the enrichment rather than guessing. Better to leave a row un-enriched
// than to mislabel one and confuse the recurring detector downstream.
// ---------------------------------------------------------------------------

import { parse } from "csv-parse/sync";
import { getDb } from "../db/connection.js";
import { categoriseFromDescription } from "../basiq/categories.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PaypalRecord {
  id: string;
  date: string; // YYYY-MM-DD
  merchantName: string;
  type: string | null;
  currency: string | null;
  gross: number;
}

export interface PaypalImportSummary {
  /** Rows parsed from the CSV. */
  totalParsed: number;
  /** Rows persisted to `paypal_transactions` (after dedupe). */
  totalImported: number;
  /** PayPal rows that found exactly one bank row → enrichment applied. */
  matched: number;
  /**
   * PayPal rows that had ≥2 candidates, OR cases where two PayPal rows
   * collided on the same bank row. Enrichment skipped — these need a
   * human eye if you care about them.
   */
  ambiguous: number;
  /** PayPal rows with no candidate bank row at all. Probably one-offs. */
  unmatched: number;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

const REQUIRED_HEADERS = [
  "Date",
  "Name",
  "Gross",
  "Transaction ID",
] as const;

type RawRow = Record<string, string>;

/**
 * Parse PayPal's "Completed Payments" CSV. The export carries 20+ columns;
 * we only need five (Date, Name, Type, Currency, Gross, Transaction ID).
 * Anything else is ignored. Throws when the required columns aren't all
 * present — the CSV is the user's choice of export, and importing the
 * wrong one is a much worse outcome than a clear error message.
 *
 * Date format: PayPal uses DD/MM/YYYY for Australian accounts. We
 * normalise to ISO YYYY-MM-DD on parse so downstream code doesn't care.
 *
 * Gross: PayPal uses Australian-style "$1,234.56" formatting and a
 * leading minus for outflows. We strip currency symbols and commas, then
 * take the absolute value — the sign on the bank side is the bank's call,
 * not PayPal's, so for matching we compare absolute amounts.
 */
export function parsePaypalCsv(buffer: Buffer): PaypalRecord[] {
  const text = buffer.toString("utf8");
  let records: RawRow[];
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      // PayPal CSVs sometimes include BOM and quoted fields with embedded
      // commas — the default csv-parse settings handle both.
      bom: true,
    }) as RawRow[];
  } catch (err) {
    throw new Error(
      `Couldn't parse PayPal CSV: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (records.length === 0) {
    return [];
  }

  // Header validation: require the four columns we depend on. `Type` and
  // `Currency` are optional (some exports omit them); their absence isn't
  // fatal.
  const headers = Object.keys(records[0]);
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    throw new Error(
      `PayPal CSV is missing required columns: ${missing.join(", ")}. ` +
        `Make sure you downloaded "Completed Payments" rather than another report type.`,
    );
  }

  const parsed: PaypalRecord[] = [];
  for (const row of records) {
    const id = row["Transaction ID"]?.trim();
    if (!id) continue;

    const dateRaw = row["Date"]?.trim();
    const grossRaw = row["Gross"]?.trim();
    const merchantName = row["Name"]?.trim();
    if (!dateRaw || !grossRaw || !merchantName) continue;

    const date = parseAustralianDate(dateRaw);
    if (!date) continue;

    const gross = parseAmount(grossRaw);
    if (gross === null) continue;

    parsed.push({
      id,
      date,
      merchantName,
      type: row["Type"]?.trim() || null,
      currency: row["Currency"]?.trim() || null,
      gross: Math.abs(gross),
    });
  }
  return parsed;
}

function parseAustralianDate(s: string): string | null {
  // PayPal uses DD/MM/YYYY. Reject anything else to avoid silently
  // misinterpreting a US-format export as Australian.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = Number(dd);
  const mo = Number(mm);
  const y = Number(yyyy);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${yyyy}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseAmount(s: string): number | null {
  // Strip currency symbols, thousands separators, and parens (some banks
  // wrap negatives in parens). Keep the leading minus.
  const cleaned = s.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// DB ops
// ---------------------------------------------------------------------------

/**
 * Wipe `paypal_transactions` and replace with the parsed records. Wrapped
 * in a single transaction so a half-finished write can't leave the table
 * in an inconsistent state. Returns `totalImported` (post-dedupe count).
 *
 * Deduplication happens implicitly via the PRIMARY KEY on `id` — PayPal
 * IDs are globally unique within an account.
 */
export function importPaypalCsv(records: PaypalRecord[]): number {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO paypal_transactions
       (id, date, merchant_name, type, currency, gross, matched_transaction_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  const tx = db.transaction((rows: PaypalRecord[]) => {
    db.prepare(`DELETE FROM paypal_transactions`).run();
    for (const r of rows) {
      insert.run(
        r.id,
        r.date,
        r.merchantName,
        r.type,
        r.currency,
        r.gross,
      );
    }
  });
  tx(records);
  return records.length;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface BankCandidate {
  transaction_id: string;
  date: string;
  amount: number;
  name: string;
  raw_name: string | null;
}

/**
 * For each unmatched PayPal record, look for a single bank row that:
 *   - is PayPal-prefixed in `name` OR `raw_name`
 *   - has the same absolute amount (within 1 cent)
 *   - lies within ±2 days of the PayPal date
 *
 * Exactly-one matches are applied: `transactions.enriched_name` is set to
 * `paypal.merchant_name` and `paypal_transactions.matched_transaction_id`
 * points at the bank row. Anything ambiguous (multiple bank candidates for
 * one PayPal record, or two PayPal records claiming the same bank row) is
 * skipped — conservatism over coverage.
 *
 * Run inside a single DB transaction so a partial failure can't leave
 * enrichment + paypal mapping out of sync.
 */
export function matchPaypalToBank(): {
  matched: number;
  ambiguous: number;
  unmatched: number;
} {
  const db = getDb();

  const paypalRows = db
    .prepare(
      `SELECT id, date, merchant_name, gross
         FROM paypal_transactions
        ORDER BY date ASC, id ASC`,
    )
    .all() as {
    id: string;
    date: string;
    merchant_name: string;
    gross: number;
  }[];

  // Pre-fetch every PayPal-prefixed bank row in one query — far cheaper
  // than running a per-PayPal-row SELECT for hundreds of records. We
  // bucket by absolute amount (rounded to 2dp) so the per-record match
  // becomes a small in-memory lookup.
  const candidates = db
    .prepare(
      `SELECT transaction_id, date, amount, name, raw_name
         FROM transactions
        WHERE pending = 0
          AND amount > 0
          AND (
            name LIKE 'PAYPAL%' COLLATE NOCASE
            OR raw_name LIKE 'PAYPAL%' COLLATE NOCASE
            OR raw_name LIKE '%Paypal Australia%' COLLATE NOCASE
          )`,
    )
    .all() as BankCandidate[];

  const byAmount = new Map<string, BankCandidate[]>();
  for (const c of candidates) {
    const key = c.amount.toFixed(2);
    let bucket = byAmount.get(key);
    if (!bucket) {
      bucket = [];
      byAmount.set(key, bucket);
    }
    bucket.push(c);
  }

  // Two-phase matching:
  //  1. For each PayPal row, collect the bank candidates within ±2 days
  //     and exact amount.
  //  2. Resolve collisions: if two PayPal rows want the same bank row,
  //     neither gets it — both flagged ambiguous.
  interface Proposal {
    paypalId: string;
    merchantName: string;
    bankId: string;
  }
  const proposals: Proposal[] = [];
  const ambiguousPaypalIds = new Set<string>();
  let unmatched = 0;

  for (const p of paypalRows) {
    const bucket = byAmount.get(p.gross.toFixed(2)) ?? [];
    const within = bucket.filter((c) => daysBetween(c.date, p.date) <= 2);
    if (within.length === 0) {
      unmatched++;
      continue;
    }
    if (within.length > 1) {
      ambiguousPaypalIds.add(p.id);
      continue;
    }
    proposals.push({
      paypalId: p.id,
      merchantName: p.merchant_name,
      bankId: within[0].transaction_id,
    });
  }

  // Cross-check: any bank row claimed by ≥2 PayPal rows is also ambiguous.
  const bankClaims = new Map<string, number>();
  for (const p of proposals) {
    bankClaims.set(p.bankId, (bankClaims.get(p.bankId) ?? 0) + 1);
  }
  const acceptedProposals: Proposal[] = [];
  for (const p of proposals) {
    if ((bankClaims.get(p.bankId) ?? 0) > 1) {
      ambiguousPaypalIds.add(p.paypalId);
      continue;
    }
    acceptedProposals.push(p);
  }

  // Write phase — one transaction so all enrichment + mapping lands
  // atomically.
  const updateBank = db.prepare(
    `UPDATE transactions SET enriched_name = ? WHERE transaction_id = ?`,
  );
  const updatePaypal = db.prepare(
    `UPDATE paypal_transactions SET matched_transaction_id = ? WHERE id = ?`,
  );
  const clearMatches = db.prepare(
    `UPDATE paypal_transactions SET matched_transaction_id = NULL`,
  );
  const clearEnrichment = db.prepare(
    `UPDATE transactions SET enriched_name = NULL`,
  );

  const write = db.transaction(() => {
    // Reset every PayPal mapping AND every enrichment so a previous
    // import's stale matches don't survive into the new run. This is the
    // wipe-and-replace contract — the latest CSV is authoritative.
    clearMatches.run();
    clearEnrichment.run();

    for (const p of acceptedProposals) {
      updateBank.run(p.merchantName, p.bankId);
      updatePaypal.run(p.bankId, p.paypalId);
    }
  });
  write();

  return {
    matched: acceptedProposals.length,
    ambiguous: ambiguousPaypalIds.size,
    unmatched,
  };
}

/**
 * Re-run the descriptor-based categoriser against `enriched_name` for every
 * row that has one. Done in a single pass after `matchPaypalToBank` so
 * categories reflect who PayPal says the merchant is, not the opaque
 * "Paypal Australia ###" the bank descriptor carried.
 *
 * Only updates rows where the categoriser actually produces a result —
 * misses leave the existing category alone (rather than blanking to
 * DEFAULT_CATEGORY, which would be lossy).
 *
 * Returns the number of rows whose category changed.
 */
export function recategoriseEnrichedTransactions(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT transaction_id, enriched_name, category, subcategory
         FROM transactions
        WHERE enriched_name IS NOT NULL`,
    )
    .all() as {
    transaction_id: string;
    enriched_name: string;
    category: string | null;
    subcategory: string | null;
  }[];

  const update = db.prepare(
    `UPDATE transactions SET category = ?, subcategory = ? WHERE transaction_id = ?`,
  );

  let changed = 0;
  const write = db.transaction(() => {
    for (const r of rows) {
      const matched = categoriseFromDescription(r.enriched_name);
      if (!matched) continue;
      if (
        matched.category === r.category &&
        (matched.subcategory ?? null) === (r.subcategory ?? null)
      ) {
        continue;
      }
      update.run(matched.category, matched.subcategory ?? null, r.transaction_id);
      changed++;
    }
  });
  write();
  return changed;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(a: string, b: string): number {
  const ad = new Date(a + "T00:00:00Z").getTime();
  const bd = new Date(b + "T00:00:00Z").getTime();
  if (Number.isNaN(ad) || Number.isNaN(bd)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((ad - bd) / MS_PER_DAY));
}
