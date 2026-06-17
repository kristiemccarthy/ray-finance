// ---------------------------------------------------------------------------
// Pay-cycle anchor resolution — the single source of truth for where a
// fortnightly pay cycle begins.
//
// Every surface that slices time into pay cycles (/forecast, /fortnight,
// /retrospective, /goals) used to carry its own copy of "find the salary
// anchor, walk forward to the current cycle start". They are unified here so
// the boundary policy — including the +1 day post-payday offset — is defined
// once and can never drift between screens.
//
// The offset: Kristie is paid on a Wednesday but the deposit doesn't settle
// until ~5pm, so Wednesday daytime has no spendable money. We therefore treat
// payday as the LAST day of the closing cycle and the day AFTER payday as
// day 1 of the new cycle. See CYCLE_ANCHOR_OFFSET_DAYS.
// ---------------------------------------------------------------------------

import type Database from "libsql";

/** Length of one pay cycle, in days. */
export const CYCLE_LENGTH_DAYS = 14;

/** Day-of-week salary lands on (0 = Sunday … 3 = Wednesday). */
export const CYCLE_ANCHOR_DOW = 3;

/**
 * Days to push the cycle start past payday. 1 = a cycle starts the day AFTER
 * payday, so payday itself is the final (settling) day of the closing cycle.
 */
export const CYCLE_ANCHOR_OFFSET_DAYS = 1;

const MS_PER_DAY = 86_400_000;

function parseYMD(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

/**
 * Resolve the salary anchor: the `last_date` of the largest active biweekly
 * inflow stream on file. Salary dwarfs other repeat inflows (personal
 * payments, card top-ups), so ordering by `avg_amount` beats ordering by
 * `last_date` (which would pick whichever biweekly inflow landed most
 * recently). Returns null when no biweekly inflow is on file, signalling the
 * caller to fall back to day-of-week arithmetic.
 *
 * Global (not account-scoped). The forecast engine intentionally keeps its
 * own account-scoped anchor (resolved from its already-loaded inflow rows);
 * /fortnight, /retrospective and /goals all want this whole-of-money anchor.
 */
export function resolveSalaryAnchor(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT last_date
         FROM recurring
        WHERE is_active = 1
          AND stream_type = 'inflow'
          AND last_date IS NOT NULL
          AND frequency = 'BIWEEKLY'
        ORDER BY avg_amount DESC
        LIMIT 1`,
    )
    .get() as { last_date: string } | undefined;
  return row?.last_date ?? null;
}

/**
 * Find the start date (UTC midnight) of the pay cycle that contains `today`.
 *
 * The offset is applied to the anchor *seed* BEFORE the forward walk: we seed
 * at `payday + offsetDays`, then snap to the most recent cycle boundary on or
 * before `today`. Done this way, on payday itself the current cycle start is
 * the *previous* payday+offset (so payday is the closing cycle's last day);
 * applying the offset after the walk would instead push the boundary into the
 * future on payday. The snap uses floor division rather than a forward-only
 * loop so a seed that lands after `today` still resolves to the correct
 * (earlier) boundary.
 *
 * Fallback (no salary anchor): the most recent `(anchorDow + offset)`
 * day-of-week on or before today — i.e. the day after the nominal payday DOW.
 *
 * `today` is expected to be UTC-midnight-aligned (see callers' startOfUtcDay).
 */
export function resolveCurrentCycleStart(
  today: Date,
  salaryAnchor: string | null,
  opts: {
    anchorDow?: number;
    cycleLengthDays?: number;
    offsetDays?: number;
  } = {},
): Date {
  const anchorDow = opts.anchorDow ?? CYCLE_ANCHOR_DOW;
  const cycleLengthDays = opts.cycleLengthDays ?? CYCLE_LENGTH_DAYS;
  const offsetDays = opts.offsetDays ?? CYCLE_ANCHOR_OFFSET_DAYS;
  const cycleMs = cycleLengthDays * MS_PER_DAY;

  if (salaryAnchor) {
    // Seed at payday + offset, then snap to the most recent boundary <= today.
    const seed = parseYMD(salaryAnchor).getTime() + offsetDays * MS_PER_DAY;
    const k = Math.floor((today.getTime() - seed) / cycleMs);
    return new Date(seed + k * cycleMs);
  }

  // Day-of-week fallback, shifted by the offset so the cycle starts the day
  // after the nominal payday DOW.
  const effectiveDow = (anchorDow + offsetDays) % 7;
  const daysBack = (today.getUTCDay() - effectiveDow + 7) % 7;
  return new Date(today.getTime() - daysBack * MS_PER_DAY);
}
