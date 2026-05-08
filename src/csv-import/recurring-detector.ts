// ---------------------------------------------------------------------------
// Recurring transaction detector.
//
// Plaid's `transactionsRecurringGet` did this server-side; Basiq doesn't,
// and CSV imports definitely don't. This module fills the gap with a
// simple but predictable interval-based detector that runs over Ray's
// local `transactions` table and writes results to `recurring`.
//
// Algorithm (high level):
//   1. Pull non-pending, non-transfer transactions, ordered by date.
//   2. Strip noise (Visa Purchase prefixes, dates, times, sequence IDs)
//      to produce a stable "normalised key" per transaction.
//   3. Group by (normalisedKey, streamType) where streamType is outflow
//      if Plaid-positive, inflow if Plaid-negative.
//   4. For each group of ≥ 3 occurrences, look at the day-intervals
//      between consecutive transactions; if ≥ 70% land in one of
//      WEEKLY / FORTNIGHTLY / MONTHLY / BI_MONTHLY / QUARTERLY / YEARLY
//      buckets, accept that as the stream's frequency.
//   5. Deactivate every existing row in `recurring`, then upsert the
//      detected streams with `is_active = 1`. Streams that disappear from
//      future runs auto-deactivate.
//
// Stream IDs are deterministic (`SHA-256(normalisedKey|streamType)`
// truncated to 32 hex chars), so re-runs update the same rows rather
// than churning new IDs.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { getDb } from "../db/connection.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RecurringDetectionResult {
  /** Total recurring streams found in this run. */
  streamsDetected: number;
  /** Streams marked `is_active = 1` after the write completes. */
  streamsActive: number;
  /** Count per detected frequency bucket (e.g. `{ MONTHLY: 12, WEEKLY: 3 }`). */
  byFrequency: Record<string, number>;
}

export function detectRecurring(): RecurringDetectionResult {
  const db = getDb();

  // -------------------------------------------------------------------------
  // 1. Pull eligible transactions.
  // Transfers between own accounts aren't recurring expenses, so they're
  // excluded. Same for pending rows — their dates are unstable.
  // -------------------------------------------------------------------------
  const transactions = db
    .prepare(
      `SELECT transaction_id, account_id, amount, date, name, category, subcategory
         FROM transactions
        WHERE pending = 0
          AND (category IS NULL OR category NOT IN ('TRANSFER_OUT', 'TRANSFER_IN'))
        ORDER BY date ASC`,
    )
    .all() as TxRow[];

  // -------------------------------------------------------------------------
  // 2 + 3. Group by (normalisedKey, streamType).
  // -------------------------------------------------------------------------
  const groups = new Map<string, TxRow[]>();
  for (const tx of transactions) {
    if (tx.amount === 0) continue;
    const streamType: StreamType = tx.amount > 0 ? "outflow" : "inflow";
    const normalisedKey = normaliseKey(tx.name);
    if (!normalisedKey) continue;
    const groupKey = `${normalisedKey}|${streamType}`;
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = [];
      groups.set(groupKey, bucket);
    }
    bucket.push(tx);
  }

  // -------------------------------------------------------------------------
  // 4. Detect frequency per group.
  // -------------------------------------------------------------------------
  const streams: RecurringRow[] = [];
  for (const [groupKey, txs] of groups) {
    if (txs.length < MIN_OCCURRENCES) continue;

    // Pull the normalised key + stream type out of the composite group key
    // first so we can short-circuit on exclusions before doing any
    // interval / frequency work for streams we'll throw away anyway.
    const sepIdx = groupKey.lastIndexOf("|");
    const normalisedKey = groupKey.slice(0, sepIdx);
    const streamType = groupKey.slice(sepIdx + 1) as StreamType;
    if (isExcluded(normalisedKey)) continue;

    const intervals: number[] = [];
    for (let i = 1; i < txs.length; i++) {
      intervals.push(daysBetween(txs[i - 1].date, txs[i].date));
    }
    if (intervals.length === 0) continue;

    const dominant = dominantFrequency(intervals);
    if (!dominant) continue;
    if (dominant.fitRatio < FIT_THRESHOLD) continue;

    const last = txs[txs.length - 1];
    const amounts = txs.map((t) => Math.abs(t.amount));

    streams.push({
      stream_id: deriveStreamId(normalisedKey, streamType),
      account_id: last.account_id,
      merchant_name: last.name,
      description: normalisedKey,
      frequency: dominant.frequency,
      category: last.category,
      subcategory: last.subcategory,
      avg_amount: median(amounts),
      last_amount: Math.abs(last.amount),
      first_date: txs[0].date,
      last_date: last.date,
      is_active: 1,
      status: txs.length >= MATURE_THRESHOLD ? "MATURE" : "EARLY_DETECTION",
      stream_type: streamType,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Atomic write: deactivate everything, then upsert detected streams.
  // -------------------------------------------------------------------------
  const deactivateAll = db.prepare(
    `UPDATE recurring SET is_active = 0, updated_at = datetime('now')`,
  );
  const upsert = db.prepare(`
    INSERT INTO recurring (stream_id, account_id, merchant_name, description, frequency, category, subcategory, avg_amount, last_amount, first_date, last_date, is_active, status, stream_type, updated_at)
    VALUES (@stream_id, @account_id, @merchant_name, @description, @frequency, @category, @subcategory, @avg_amount, @last_amount, @first_date, @last_date, @is_active, @status, @stream_type, datetime('now'))
    ON CONFLICT(stream_id) DO UPDATE SET
      account_id=excluded.account_id,
      merchant_name=excluded.merchant_name,
      description=excluded.description,
      frequency=excluded.frequency,
      category=excluded.category,
      subcategory=excluded.subcategory,
      avg_amount=excluded.avg_amount,
      last_amount=excluded.last_amount,
      first_date=excluded.first_date,
      last_date=excluded.last_date,
      is_active=excluded.is_active,
      status=excluded.status,
      stream_type=excluded.stream_type,
      updated_at=datetime('now')
  `);
  const deactivateStale = db.prepare(`
    UPDATE recurring
       SET is_active = 0, updated_at = datetime('now')
     WHERE is_active = 1
       AND frequency = ?
       AND last_date < ?
  `);

  let staleDeactivated = 0;
  const writeAll = db.transaction(() => {
    deactivateAll.run();
    for (const stream of streams) {
      upsert.run(stream);
    }
    // Stale-check: a stream the detector classified as recurring still
    // has to have *fired recently* to count as active. If we haven't
    // seen it in 2× its expected interval, treat it as cancelled —
    // otherwise old streams (e.g. a phone plan that ended 6 months ago)
    // linger on `ray bills` predictions forever.
    const today = new Date();
    for (const [freq, days] of Object.entries(STALE_MULTIPLIERS)) {
      const cutoffMs = today.getTime() - days * 86400000;
      const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
      const result = deactivateStale.run(freq, cutoff);
      staleDeactivated += Number(result.changes ?? 0);
    }
  });
  writeAll();

  if (staleDeactivated > 0) {
    console.log(
      `[recurring] deactivated ${staleDeactivated} stale streams (last_date older than 2× frequency)`,
    );
  }

  // -------------------------------------------------------------------------
  // Summary.
  // -------------------------------------------------------------------------
  const byFrequency: Record<string, number> = {};
  for (const stream of streams) {
    byFrequency[stream.frequency] = (byFrequency[stream.frequency] ?? 0) + 1;
  }

  const activeRow = db
    .prepare(`SELECT COUNT(*) AS count FROM recurring WHERE is_active = 1`)
    .get() as { count: number };

  return {
    streamsDetected: streams.length,
    streamsActive: activeRow.count,
    byFrequency,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface TxRow {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  category: string | null;
  subcategory: string | null;
}

type StreamType = "outflow" | "inflow";

interface RecurringRow {
  stream_id: string;
  account_id: string;
  merchant_name: string;
  description: string;
  frequency: string;
  category: string | null;
  subcategory: string | null;
  avg_amount: number;
  last_amount: number;
  first_date: string;
  last_date: string;
  is_active: number;
  status: string;
  stream_type: StreamType;
}

const MIN_OCCURRENCES = 3;
const MATURE_THRESHOLD = 6;
const FIT_THRESHOLD = 0.7;

/**
 * Days-since-last-occurrence threshold (per frequency) above which a
 * stream is treated as cancelled / stale. 2× the expected interval
 * gives a one-period grace window for late charges before deactivation.
 */
const STALE_MULTIPLIERS: Record<string, number> = {
  WEEKLY: 14,
  BIWEEKLY: 28,
  MONTHLY: 60,
  ANNUALLY: 730,
};

/**
 * Merchant patterns that should NEVER be treated as recurring streams,
 * regardless of how regularly they appear in transaction history. Used
 * for streams the user has explicitly chosen to manage manually, or
 * false-positive recurring patterns (e.g. a fortnightly visit to a
 * local market that looks like a stream but isn't a bill).
 *
 * Matched case-insensitively against the normalised description. An
 * excluded stream's existing row (if any) gets deactivated by the
 * `deactivateAll` step at the start of the write transaction and is
 * never re-upserted, so it stays `is_active = 0` permanently.
 */
const STREAM_EXCLUSIONS: readonly string[] = [
  "PET INSURANCE CHATSWOOD",
  "AUDIBLE LIMITED AU MELBOURNE",
  "FARMERS LAND ROUSE H",
  "PYPL PAYIN4",
];

/**
 * Match a normalised stream key against `STREAM_EXCLUSIONS` (case-
 * insensitive `includes`). Used by the detection loop to skip streams
 * the user has explicitly chosen never to auto-track.
 */
function isExcluded(description: string): boolean {
  const upper = description.toUpperCase();
  return STREAM_EXCLUSIONS.some((pattern) => upper.includes(pattern));
}

/**
 * Strip merchant noise so the same recurring charge produces the same key
 * across statements. Order matters: the more-specific "VISA PURCHASE
 * O/SEAS " prefix is removed before the generic "VISA PURCHASE " so the
 * latter doesn't leave "O/SEAS" hanging.
 */
function normaliseKey(description: string): string {
  let s = description;
  s = s.replace(/^VISA PURCHASE O\/SEAS /i, "");
  s = s.replace(/^VISA PURCHASE /i, "");
  // Date markers like "16Apr" or "26Apr" embedded in St George descriptions.
  s = s.replace(/\b\d{1,2}[A-Z][a-z]{2}\b/g, "");
  // Time markers like "09:08".
  s = s.replace(/\b\d{2}:\d{2}\b/g, "");
  // Long-digit sequences (PayPal-style invoice IDs).
  s = s.replace(/\b\d{6,}\b/g, "");
  // Trailing country tag.
  s = s.replace(/\bAUS\b/g, "");
  s = s.replace(/\s+/g, " ");
  return s.trim().toUpperCase();
}

/** Days between two `YYYY-MM-DD` dates, rounded to integer days. */
function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Bucket a day-interval into one of the supported recurrence frequencies.
 * Returns `null` for intervals that don't fit any bucket — those count
 * against the dominant bucket's fit ratio without being attributed.
 */
function bucketize(days: number): string | null {
  // Frequency labels intentionally match the vocabulary that Ray's
  // `predictNextBillDate` (src/db/bills.ts) recognises — anything outside
  // {WEEKLY, BIWEEKLY, SEMI_MONTHLY, MONTHLY, ANNUALLY} returns null there
  // and silently disappears from `ray bills`.
  //
  // BI_MONTHLY (every ~60 days) and QUARTERLY (~90 days) collapse to
  // MONTHLY: the next predicted date will fire too early, but the
  // following refresh corrects it. Predicting early beats predicting
  // never; revisit if real bi-monthly or quarterly bills cause noise.
  if (days >= 6 && days <= 9) return "WEEKLY";
  if (days >= 12 && days <= 16) return "BIWEEKLY";
  if (days >= 26 && days <= 35) return "MONTHLY";
  if (days >= 56 && days <= 66) return "MONTHLY";
  if (days >= 85 && days <= 95) return "MONTHLY";
  if (days >= 355 && days <= 375) return "ANNUALLY";
  return null;
}

/**
 * Find the most-common frequency bucket among `intervals`. `fitRatio` is
 * computed against the total interval count (including unbucketed
 * intervals), so 70% of monthly intervals plus 30% of off-pattern intervals
 * still passes the threshold.
 */
function dominantFrequency(
  intervals: number[],
): { frequency: string; fitRatio: number } | null {
  const counts = new Map<string, number>();
  for (const iv of intervals) {
    const bucket = bucketize(iv);
    if (bucket !== null) {
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }
  let bestFreq: string | null = null;
  let bestCount = 0;
  for (const [freq, n] of counts) {
    if (n > bestCount) {
      bestFreq = freq;
      bestCount = n;
    }
  }
  if (!bestFreq) return null;
  return { frequency: bestFreq, fitRatio: bestCount / intervals.length };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function deriveStreamId(normalisedKey: string, streamType: StreamType): string {
  return createHash("sha256")
    .update(`${normalisedKey}|${streamType}`)
    .digest("hex")
    .slice(0, 32);
}
