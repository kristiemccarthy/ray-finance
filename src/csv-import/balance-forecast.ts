// ---------------------------------------------------------------------------
// Pay-cycle balance forecast.
//
// Given an account and a pay cadence, project the running balance across the
// next N cycles using only recurring inflows and outflows. Read-only — never
// touches the database. Designed to answer "will I have enough to cover this
// fortnight" rather than to produce a complete spending forecast (groceries
// and ad-hoc spend are deliberately excluded; the CLI footer reminds the user
// to subtract them).
//
// Sources:
//   - `recurring` (stream_type = 'inflow' or 'outflow'), filtered by exact
//     `account_id` match — recurring rows are tied to the account the most
//     recent transaction landed in.
//   - `recurring_bills` (manual entries) — included in full regardless of
//     account_id, on the assumption the user only adds bills they actually
//     want forecast.
//
// Same-day ordering: bills before income. Conservative for risk planning;
// the lowest projected point reflects the worst intra-day intermediate state.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getDb } from "../db/connection.js";
import { predictNextBillDate, isOccurrencePaid, addMonths } from "../db/bills.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ForecastOptions {
  /** Account to forecast (e.g. `csv:st-george:personal`). */
  accountId: string;
  /** Day each pay cycle starts. 0=Sunday, 3=Wednesday. Defaults to 3. */
  cycleAnchorDayOfWeek?: number;
  /** Days per cycle. Defaults to 14. */
  cycleLengthDays?: number;
  /** Number of cycles to project. Defaults to 4. */
  numberOfCycles?: number;
}

export interface ForecastItem {
  date: string;
  description: string;
  /** Always positive — sign is implied by income vs bill list. */
  amount: number;
  source: "recurring" | "manual";
}

export interface CycleProjection {
  startDate: string;
  endDate: string;
  incomingItems: ForecastItem[];
  outgoingItems: ForecastItem[];
  totalIncome: number;
  totalBills: number;
  startingBalance: number;
  endingBalance: number;
  /** Bill-only ending less compounded life adjustments — the realistic figure. */
  lifeAdjustedStartingBalance: number;
  lifeAdjustedEndingBalance: number;
  /** The amount subtracted at end-of-cycle: budgets/2.17 + buffer. */
  cycleAdjustment: number;
}

export interface ForecastResult {
  accountId: string;
  currentBalance: number;
  cycles: CycleProjection[];
  /** Worst life-adjusted balance across all cycles, including intra-cycle dips. */
  lowestPoint: { date: string; balance: number; reason: string };
  /** Per-cycle amount being subtracted for living costs (for display). */
  cycleAdjustment: number;
}

export interface ForecastSettings {
  perCycleBuffer: number;
  applyBudgets: boolean;
}

const DEFAULT_SETTINGS: ForecastSettings = {
  perCycleBuffer: 200,
  applyBudgets: true,
};

/**
 * Load forecast settings from `~/.ray/forecast.json`. Missing file or invalid
 * JSON falls back to defaults silently — settings are an optional overlay,
 * not a hard requirement.
 */
export function loadForecastSettings(): ForecastSettings {
  try {
    const path = join(homedir(), ".ray", "forecast.json");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ForecastSettings>;
    return {
      perCycleBuffer:
        typeof parsed.perCycleBuffer === "number"
          ? parsed.perCycleBuffer
          : DEFAULT_SETTINGS.perCycleBuffer,
      applyBudgets:
        typeof parsed.applyBudgets === "boolean"
          ? parsed.applyBudgets
          : DEFAULT_SETTINGS.applyBudgets,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86400000;

export function forecastBalance(options: ForecastOptions): ForecastResult {
  const {
    accountId,
    cycleAnchorDayOfWeek = 3,
    cycleLengthDays = 14,
    numberOfCycles = 4,
  } = options;

  const db = getDb();

  // 1. Current balance (warn-and-continue on null so the forecast is still
  //    useful for an account that hasn't synced a balance yet).
  const accountRow = db
    .prepare(`SELECT current_balance FROM accounts WHERE account_id = ?`)
    .get(accountId) as { current_balance: number | null } | undefined;

  if (!accountRow) {
    throw new Error(`Account not found: ${accountId}`);
  }

  let currentBalance = accountRow.current_balance;
  if (currentBalance === null) {
    console.warn(
      `[forecast] Warning: account ${accountId} has null current_balance; treating as 0.`,
    );
    currentBalance = 0;
  }

  // 2. Cycle boundaries — cycle 1 starts today so we don't lose visibility
  //    on bills that fall before the next anchor; cycles 2+ align to the
  //    anchor so the rest of the forecast lands on real paydays.
  const today = startOfUtcDay(new Date());
  const boundaries = computeCycleBoundaries(
    today,
    cycleAnchorDayOfWeek,
    cycleLengthDays,
    numberOfCycles,
  );

  // Life-adjustment: subtract typical monthly budgets (scaled to per-cycle)
  // plus a flat buffer for unexpected costs. Both come from settings/db,
  // both default sensibly when missing.
  const settings = loadForecastSettings();
  const totalMonthlyBudgets = settings.applyBudgets ? readTotalMonthlyBudgets(db) : 0;
  // 2.17 cycles per month: average month = 30.44 days / 14-day cycle.
  const cycleAdjustment = totalMonthlyBudgets / 2.17 + settings.perCycleBuffer;

  if (boundaries.length === 0) {
    return {
      accountId,
      currentBalance,
      cycles: [],
      lowestPoint: {
        date: toYMD(today),
        balance: currentBalance,
        reason: "starting balance",
      },
      cycleAdjustment,
    };
  }

  const windowStart = parseYMD(boundaries[0].startDate);
  const windowEnd = parseYMD(boundaries[boundaries.length - 1].endDate);

  // 3. Pull source rows. Recurring streams are scoped to the requested
  //    account; manual bills are taken in full (per the spec).
  const inflowRows = db
    .prepare(
      `SELECT description, merchant_name, frequency, avg_amount, last_amount, last_date
         FROM recurring
        WHERE is_active = 1
          AND stream_type = 'inflow'
          AND account_id = ?
          AND last_date IS NOT NULL`,
    )
    .all(accountId) as RecurringRow[];

  const outflowRows = db
    .prepare(
      `SELECT description, merchant_name, frequency, avg_amount, last_amount, last_date
         FROM recurring
        WHERE is_active = 1
          AND stream_type = 'outflow'
          AND account_id = ?
          AND last_date IS NOT NULL`,
    )
    .all(accountId) as RecurringRow[];

  const manualRows = db
    .prepare(
      `SELECT name, amount, day_of_month, frequency, next_due_date, last_paid_date
         FROM recurring_bills`,
    )
    .all() as ManualBillRow[];

  // 4. Project each source across the full window once, then bucket by cycle.
  const allIncome = projectRecurringStreams(inflowRows, windowStart, windowEnd);
  const allOutgoing: ForecastItem[] = [
    ...projectRecurringStreams(outflowRows, windowStart, windowEnd),
    ...projectManualBills(manualRows, windowStart, windowEnd),
  ];

  // 5. Walk the events chronologically per cycle, tracking both the bill-only
  //    running balance (existing behaviour) and a life-adjusted running balance
  //    (bill events plus an end-of-cycle deduction for typical living costs).
  //    Cycle 1 starts both balances at currentBalance; subsequent cycles
  //    inherit the life-adjusted ending of the previous cycle, so adjustments
  //    compound across the forecast.
  let runningBalance = currentBalance;
  let lifeRunning = currentBalance;
  let lowestPoint = {
    date: boundaries[0].startDate,
    balance: currentBalance,
    reason: "starting balance",
  };

  const cycles: CycleProjection[] = boundaries.map((boundary, cycleIndex) => {
    const startingBalance = runningBalance;
    const lifeAdjustedStartingBalance = lifeRunning;

    const incoming = allIncome
      .filter((it) => it.date >= boundary.startDate && it.date <= boundary.endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    const outgoing = allOutgoing
      .filter((it) => it.date >= boundary.startDate && it.date <= boundary.endDate)
      .sort((a, b) => a.date.localeCompare(b.date));

    // Same-day ordering: bills first (sign = -1), then income (sign = +1).
    // Worst-case for the lowest-point calculation, which is the whole point
    // of this tool.
    type Event = ForecastItem & { sign: -1 | 1 };
    const events: Event[] = [
      ...outgoing.map((o) => ({ ...o, sign: -1 as const })),
      ...incoming.map((i) => ({ ...i, sign: 1 as const })),
    ].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.sign - b.sign;
    });

    // Pre-scan so attribution can prefer the cycle's biggest bill over a
    // routine $9.99 charge that happens to push the balance to a new low.
    const largestBillInCycle = outgoing.reduce(
      (max, b) => Math.max(max, b.amount),
      0,
    );
    // 30% of the cycle's living-cost adjustment is "noticeable" — anything
    // smaller is treated as routine. The largest-bill clause keeps the rule
    // useful in cycles with no large bill at all.
    const significantBillThreshold = 0.3 * cycleAdjustment;

    for (const ev of events) {
      runningBalance += ev.sign * ev.amount;
      lifeRunning += ev.sign * ev.amount;
      // Only bills can establish a new low. Track against the life-adjusted
      // running balance so the lowest-point reflects the realistic picture.
      if (ev.sign === -1 && lifeRunning < lowestPoint.balance) {
        const isSignificant =
          ev.amount >= significantBillThreshold ||
          ev.amount >= largestBillInCycle;
        if (isSignificant) {
          lowestPoint = {
            date: ev.date,
            balance: lifeRunning,
            reason: `after ${ev.description} (-${formatMoney(ev.amount)})`,
          };
        } else {
          // Trivial charge tipped the balance lower, but the real cause is
          // upstream (a big bill earlier this cycle, or compounding living
          // costs). Record the new low but keep the existing attribution.
          lowestPoint = { ...lowestPoint, balance: lifeRunning };
        }
      }
    }

    // Apply this cycle's life adjustment at end-of-cycle. If this drops below
    // the recorded low, attribute it to the cycle itself.
    lifeRunning -= cycleAdjustment;
    if (cycleAdjustment > 0 && lifeRunning < lowestPoint.balance) {
      lowestPoint = {
        date: boundary.endDate,
        balance: lifeRunning,
        reason: `after cycle ${cycleIndex + 1} living costs (-${formatMoney(cycleAdjustment)})`,
      };
    }

    return {
      startDate: boundary.startDate,
      endDate: boundary.endDate,
      incomingItems: incoming,
      outgoingItems: outgoing,
      totalIncome: incoming.reduce((s, i) => s + i.amount, 0),
      totalBills: outgoing.reduce((s, o) => s + o.amount, 0),
      startingBalance,
      endingBalance: runningBalance,
      lifeAdjustedStartingBalance,
      lifeAdjustedEndingBalance: lifeRunning,
      cycleAdjustment,
    };
  });

  return { accountId, currentBalance, cycles, lowestPoint, cycleAdjustment };
}

/** Sum of all `monthly_limit` rows in `budgets`. Returns 0 if the table is empty. */
function readTotalMonthlyBudgets(db: ReturnType<typeof getDb>): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(monthly_limit), 0) AS total FROM budgets`)
    .get() as { total: number };
  return row.total;
}

// ---------------------------------------------------------------------------
// Cycle boundaries
// ---------------------------------------------------------------------------

interface CycleBoundary {
  startDate: string;
  endDate: string;
}

/**
 * Cycle 1 starts today and runs until the day before cycle 2 begins. Cycle 2
 * starts on the first anchor day on or after `today + cycleLength`, which
 * keeps subsequent cycles aligned to real paydays while guaranteeing cycle 1
 * is at least one full cycle long. With `cycleLength = 14` and a weekly
 * anchor, cycle 1 ends up between 14 and 20 days; cycles 2+ are exactly
 * `cycleLength` days each. End dates are inclusive.
 */
function computeCycleBoundaries(
  today: Date,
  anchorDow: number,
  cycleLength: number,
  numCycles: number,
): CycleBoundary[] {
  const cycle2Target = new Date(today.getTime() + cycleLength * MS_PER_DAY);
  const targetDow = cycle2Target.getUTCDay();
  const daysToAnchor = (anchorDow - targetDow + 7) % 7;
  const cycle2Start = new Date(cycle2Target.getTime() + daysToAnchor * MS_PER_DAY);

  const boundaries: CycleBoundary[] = [];
  if (numCycles >= 1) {
    boundaries.push({
      startDate: toYMD(today),
      endDate: toYMD(new Date(cycle2Start.getTime() - MS_PER_DAY)),
    });
  }
  for (let i = 1; i < numCycles; i++) {
    const start = new Date(cycle2Start.getTime() + (i - 1) * cycleLength * MS_PER_DAY);
    const end = new Date(start.getTime() + (cycleLength - 1) * MS_PER_DAY);
    boundaries.push({ startDate: toYMD(start), endDate: toYMD(end) });
  }
  return boundaries;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface RecurringRow {
  description: string;
  merchant_name: string | null;
  frequency: string;
  avg_amount: number;
  last_amount: number | null;
  last_date: string;
}

interface ManualBillRow {
  name: string;
  amount: number;
  day_of_month: number | null;
  frequency: string;
  next_due_date: string | null;
  last_paid_date: string | null;
}

/**
 * Walk forward from each stream's `last_date` using `predictNextBillDate`,
 * collecting every occurrence that lands inside the window. Streams with
 * an unsupported frequency (predictNextBillDate returns null) are silently
 * skipped, matching `getUpcomingBills` behaviour.
 */
function projectRecurringStreams(
  rows: RecurringRow[],
  windowStart: Date,
  windowEnd: Date,
): ForecastItem[] {
  const items: ForecastItem[] = [];
  for (const row of rows) {
    const amount = Math.abs(row.last_amount ?? row.avg_amount ?? 0);
    if (amount === 0) continue;
    const description = row.merchant_name || row.description;

    let cursor = row.last_date;
    while (true) {
      const next = predictNextBillDate(cursor, row.frequency);
      if (!next) break;
      if (next > windowEnd) break;
      const nextYMD = toYMD(next);
      if (next >= windowStart) {
        items.push({ date: nextYMD, description, amount, source: "recurring" });
      }
      cursor = nextYMD;
    }
  }
  return items;
}

/**
 * Project all occurrences of each manual bill that fall inside the window.
 * Dispatches on `frequency`:
 *   - monthly: walk month by month, emitting on `day_of_month` (clamped to
 *     the month's length, matching `getUpcomingBills`).
 *   - fortnightly / weekly: step from `next_due_date` by 14 / 7 days,
 *     fast-forwarding to the first occurrence inside the window then
 *     emitting until we cross the end.
 *   - bi-monthly / quarterly / yearly: same anchor as fortnightly/weekly
 *     but step in 2 / 3 / 12 calendar months, with end-of-month clamping.
 * Rows missing the field their cadence requires are skipped silently.
 */
function projectManualBills(
  rows: ManualBillRow[],
  windowStart: Date,
  windowEnd: Date,
): ForecastItem[] {
  const items: ForecastItem[] = [];
  for (const row of rows) {
    if (row.frequency === "monthly") {
      if (row.day_of_month === null) continue;
      pushMonthlyOccurrences(items, row, windowStart, windowEnd);
    } else if (row.frequency === "fortnightly" || row.frequency === "weekly") {
      if (!row.next_due_date) continue;
      const intervalDays = row.frequency === "fortnightly" ? 14 : 7;
      pushIntervalOccurrences(items, row, windowStart, windowEnd, intervalDays);
    } else if (
      row.frequency === "bi-monthly" ||
      row.frequency === "quarterly" ||
      row.frequency === "yearly"
    ) {
      if (!row.next_due_date) continue;
      const intervalMonths =
        row.frequency === "bi-monthly" ? 2 : row.frequency === "quarterly" ? 3 : 12;
      pushMonthIntervalOccurrences(items, row, windowStart, windowEnd, intervalMonths);
    }
    // Unknown frequencies fall through and emit nothing.
  }
  return items;
}

function pushMonthlyOccurrences(
  items: ForecastItem[],
  row: ManualBillRow,
  windowStart: Date,
  windowEnd: Date,
): void {
  const dayOfMonth = row.day_of_month!;
  let y = windowStart.getUTCFullYear();
  let m = windowStart.getUTCMonth();
  while (true) {
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = Math.min(dayOfMonth, daysInMonth);
    const date = new Date(Date.UTC(y, m, day));
    if (date > windowEnd) break;
    if (date >= windowStart && !isOccurrencePaid(row.last_paid_date, date, { months: 1 })) {
      items.push({
        date: toYMD(date),
        description: row.name,
        amount: row.amount,
        source: "manual",
      });
    }
    m++;
    if (m > 11) {
      y++;
      m = 0;
    }
  }
}

function pushIntervalOccurrences(
  items: ForecastItem[],
  row: ManualBillRow,
  windowStart: Date,
  windowEnd: Date,
  intervalDays: number,
): void {
  let d = new Date(row.next_due_date! + "T00:00:00Z");
  if (isNaN(d.getTime())) return;
  // Fast-forward (or rewind not needed; next_due_date is the anchor and
  // we only look forward from it). If next_due_date is before the window,
  // step to the first occurrence inside it.
  while (d < windowStart) {
    d = new Date(d.getTime() + intervalDays * MS_PER_DAY);
  }
  while (d <= windowEnd) {
    if (!isOccurrencePaid(row.last_paid_date, d, intervalDays)) {
      items.push({
        date: toYMD(d),
        description: row.name,
        amount: row.amount,
        source: "manual",
      });
    }
    d = new Date(d.getTime() + intervalDays * MS_PER_DAY);
  }
}

/**
 * Sibling of `pushIntervalOccurrences` for calendar-month cadences
 * (bi-monthly / quarterly / yearly). Steps via `addMonths` so end-of-month
 * anchors clamp instead of overflowing into the next month.
 */
function pushMonthIntervalOccurrences(
  items: ForecastItem[],
  row: ManualBillRow,
  windowStart: Date,
  windowEnd: Date,
  intervalMonths: number,
): void {
  let d = new Date(row.next_due_date! + "T00:00:00Z");
  if (isNaN(d.getTime())) return;
  while (d < windowStart) {
    d = addMonths(d, intervalMonths);
  }
  while (d <= windowEnd) {
    if (!isOccurrencePaid(row.last_paid_date, d, { months: intervalMonths })) {
      items.push({
        date: toYMD(d),
        description: row.name,
        amount: row.amount,
        source: "manual",
      });
    }
    d = addMonths(d, intervalMonths);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseYMD(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return (
    sign +
    "$" +
    abs.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
