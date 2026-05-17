// ---------------------------------------------------------------------------
// Retrospective module.
//
// Builds month-over-month (or cycle-over-cycle) comparison data for the
// `/retrospective` page. The two periods returned are always the two most
// recently *completed* windows — today's own month/cycle is excluded so the
// numbers don't shift around as the day progresses.
// ---------------------------------------------------------------------------

import { getDb } from "../db/connection.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetrospectiveView = "calendar" | "cycles";

export type RetrospectiveCategoryKey =
  | "FOOD_AND_DRINK"
  | "MEDICAL"
  | "GENERAL_MERCHANDISE"
  | "ENTERTAINMENT"
  | "BILLS"
  | "OTHER";

export interface PeriodWindow {
  /** Inclusive YYYY-MM-DD. */
  startDate: string;
  /** Inclusive YYYY-MM-DD. */
  endDate: string;
  /** Long-form label, e.g. "April 2026" or "22 Apr – 5 May". */
  label: string;
}

export interface TopTransaction {
  name: string;
  amount: number;
  date: string;
}

export interface PeriodTotals {
  window: PeriodWindow;
  /** Absolute dollars of incoming money (sign of source rows is negative). */
  incomeTotal: number;
  /** Dollars of outgoing money. */
  outflowTotal: number;
  /** incomeTotal − outflowTotal. Positive = surplus. */
  net: number;
  /** Per-category outflow totals keyed by `RetrospectiveCategoryKey`. */
  byCategory: Record<RetrospectiveCategoryKey, number>;
  /** Largest three outflows, descending. */
  topTransactions: TopTransaction[];
}

export interface RetrospectiveData {
  view: RetrospectiveView;
  /** Most recent completed period. */
  recent: PeriodTotals | null;
  /** Period before `recent`. */
  comparison: PeriodTotals | null;
  /**
   * True when we have less than two completed periods of data. The page
   * uses this to render the "Not enough history yet" empty state.
   */
  notEnoughHistory: boolean;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const CYCLE_LENGTH_DAYS = 14;
const ANCHOR_DOW = 3;

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseYMD(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SHORT_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function calendarMonthWindow(year: number, monthIdx: number): PeriodWindow {
  const start = new Date(Date.UTC(year, monthIdx, 1));
  const end = new Date(Date.UTC(year, monthIdx + 1, 0));
  return {
    startDate: toYMD(start),
    endDate: toYMD(end),
    label: `${MONTH_NAMES[monthIdx]} ${year}`,
  };
}

function cycleWindow(start: Date): PeriodWindow {
  const end = new Date(start.getTime() + (CYCLE_LENGTH_DAYS - 1) * MS_PER_DAY);
  const startLabel = `${start.getUTCDate()} ${SHORT_MONTH_NAMES[start.getUTCMonth()]}`;
  const endLabel = `${end.getUTCDate()} ${SHORT_MONTH_NAMES[end.getUTCMonth()]}`;
  return {
    startDate: toYMD(start),
    endDate: toYMD(end),
    label: `${startLabel} – ${endLabel}`,
  };
}

/**
 * Returns the two most recently completed calendar-month windows.
 * "Completed" excludes the current month, so on May 17 we return
 * [April, March].
 */
function getCompletedMonths(today: Date): [PeriodWindow, PeriodWindow] {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const recentDate = new Date(Date.UTC(y, m - 1, 1));
  const compareDate = new Date(Date.UTC(y, m - 2, 1));
  return [
    calendarMonthWindow(recentDate.getUTCFullYear(), recentDate.getUTCMonth()),
    calendarMonthWindow(compareDate.getUTCFullYear(), compareDate.getUTCMonth()),
  ];
}

/**
 * Returns the two most recently *completed* pay cycles. Anchored to the
 * latest fortnightly salary inflow on file (same logic as /fortnight). The
 * cycle containing `today` is in-progress and is excluded.
 */
function getCompletedCycles(today: Date): [PeriodWindow, PeriodWindow] | null {
  const db = getDb();
  const salaryRow = db
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

  let currentCycleStart: Date;
  if (salaryRow?.last_date) {
    let d = parseYMD(salaryRow.last_date);
    while (d.getTime() + CYCLE_LENGTH_DAYS * MS_PER_DAY <= today.getTime()) {
      d = new Date(d.getTime() + CYCLE_LENGTH_DAYS * MS_PER_DAY);
    }
    currentCycleStart = d;
  } else {
    const todayDow = today.getUTCDay();
    const daysBack = (todayDow - ANCHOR_DOW + 7) % 7;
    currentCycleStart = new Date(today.getTime() - daysBack * MS_PER_DAY);
  }

  const recentStart = new Date(
    currentCycleStart.getTime() - CYCLE_LENGTH_DAYS * MS_PER_DAY,
  );
  const compareStart = new Date(
    currentCycleStart.getTime() - 2 * CYCLE_LENGTH_DAYS * MS_PER_DAY,
  );

  return [cycleWindow(recentStart), cycleWindow(compareStart)];
}

// ---------------------------------------------------------------------------
// Category bucketing
// ---------------------------------------------------------------------------

const CATEGORY_KEYS: RetrospectiveCategoryKey[] = [
  "FOOD_AND_DRINK",
  "MEDICAL",
  "GENERAL_MERCHANDISE",
  "ENTERTAINMENT",
  "BILLS",
  "OTHER",
];

const EMPTY_BY_CATEGORY: Record<RetrospectiveCategoryKey, number> = {
  FOOD_AND_DRINK: 0,
  MEDICAL: 0,
  GENERAL_MERCHANDISE: 0,
  ENTERTAINMENT: 0,
  BILLS: 0,
  OTHER: 0,
};

/**
 * Names that should be classified as Bills regardless of Plaid category.
 * Comprises:
 *   - Active recurring outflow stream merchants (Plaid-detected subscriptions)
 *   - Manual recurring_bills entries (user-defined fixed costs)
 *
 * Comparison is case-insensitive against `transactions.name`.
 */
function loadBillNames(): Set<string> {
  const db = getDb();
  const recurring = db
    .prepare(
      `SELECT DISTINCT merchant_name
         FROM recurring
        WHERE is_active = 1
          AND stream_type = 'outflow'
          AND merchant_name IS NOT NULL`,
    )
    .all() as { merchant_name: string }[];

  const manual = db
    .prepare(`SELECT DISTINCT name FROM recurring_bills`)
    .all() as { name: string }[];

  const set = new Set<string>();
  for (const r of recurring) set.add(r.merchant_name.toLowerCase());
  for (const m of manual) set.add(m.name.toLowerCase());
  return set;
}

function bucketize(
  category: string | null,
  name: string,
  billNames: Set<string>,
): RetrospectiveCategoryKey | null {
  // Bills take priority — a recurring grocery subscription should land in
  // Bills, not Food & Drink, so the discretionary categories actually
  // measure discretionary spending.
  if (billNames.has(name.toLowerCase())) return "BILLS";
  switch (category) {
    case "FOOD_AND_DRINK":
      return "FOOD_AND_DRINK";
    case "MEDICAL":
      return "MEDICAL";
    case "GENERAL_MERCHANDISE":
      return "GENERAL_MERCHANDISE";
    case "ENTERTAINMENT":
      return "ENTERTAINMENT";
    default:
      return "OTHER";
  }
}

// ---------------------------------------------------------------------------
// Period aggregation
// ---------------------------------------------------------------------------

interface TxRow {
  name: string;
  amount: number;
  date: string;
  category: string | null;
}

function loadPeriodTotals(
  window: PeriodWindow,
  billNames: Set<string>,
): PeriodTotals {
  const db = getDb();

  // Outflows: amount > 0, excluding internal transfers and loan principal
  // (loans are accounted in the balance sheet, not the spending view).
  const outflowRows = db
    .prepare(
      `SELECT name, amount, date, category
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount > 0
          AND pending = 0
          AND (category IS NULL OR category NOT IN ('TRANSFER_IN', 'TRANSFER_OUT', 'INCOME', 'LOAN_PAYMENTS'))
        ORDER BY amount DESC`,
    )
    .all(window.startDate, window.endDate) as TxRow[];

  // Income: amount < 0, excluding TRANSFER_IN (incoming internal movement).
  const incomeRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount < 0
          AND pending = 0
          AND (category IS NULL OR category != 'TRANSFER_IN')`,
    )
    .get(window.startDate, window.endDate) as { total: number };

  const incomeTotal = Math.abs(incomeRow.total);

  const byCategory: Record<RetrospectiveCategoryKey, number> = {
    ...EMPTY_BY_CATEGORY,
  };
  let outflowTotal = 0;
  for (const row of outflowRows) {
    const bucket = bucketize(row.category, row.name, billNames);
    if (!bucket) continue;
    byCategory[bucket] += row.amount;
    outflowTotal += row.amount;
  }

  // Top 3 by amount — `outflowRows` is already sorted DESC and excludes
  // transfers, so the first three are exactly what we want.
  const topTransactions: TopTransaction[] = outflowRows
    .slice(0, 3)
    .map((r) => ({ name: r.name, amount: r.amount, date: r.date }));

  return {
    window,
    incomeTotal,
    outflowTotal,
    net: incomeTotal - outflowTotal,
    byCategory,
    topTransactions,
  };
}

/**
 * Returns true if the period has any non-pending transaction activity at all
 * — used to decide "Not enough history yet" without misclassifying a
 * just-quiet month as missing data.
 */
function periodHasAnyData(window: PeriodWindow): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND pending = 0`,
    )
    .get(window.startDate, window.endDate) as { count: number };
  return row.count > 0;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function getRetrospective(
  view: RetrospectiveView,
  now: Date = new Date(),
): RetrospectiveData {
  const today = startOfUtcDay(now);

  let recentWindow: PeriodWindow | null = null;
  let compareWindow: PeriodWindow | null = null;

  if (view === "calendar") {
    const [r, c] = getCompletedMonths(today);
    recentWindow = r;
    compareWindow = c;
  } else {
    const cycles = getCompletedCycles(today);
    if (cycles) {
      recentWindow = cycles[0];
      compareWindow = cycles[1];
    }
  }

  if (!recentWindow || !compareWindow) {
    return { view, recent: null, comparison: null, notEnoughHistory: true };
  }

  // "Not enough history" means the older of the two periods has zero
  // transactions on file. Empty recent window with data in the older one
  // is still a valid (albeit quiet) comparison.
  if (!periodHasAnyData(compareWindow)) {
    return { view, recent: null, comparison: null, notEnoughHistory: true };
  }

  const billNames = loadBillNames();
  const recent = loadPeriodTotals(recentWindow, billNames);
  const comparison = loadPeriodTotals(compareWindow, billNames);

  return { view, recent, comparison, notEnoughHistory: false };
}

// Re-exported so the page can iterate in the spec'd order without
// duplicating the list.
export const RETROSPECTIVE_CATEGORY_ORDER = CATEGORY_KEYS;
