// ---------------------------------------------------------------------------
// Retrospective module.
//
// Builds N-period comparison data for the `/retrospective` page. Each
// returned period is one of the most recently *completed* windows (today's
// own month/cycle is excluded so the numbers don't shift around as the day
// progresses).
//
// Each period carries its own totals AND a snapshot of the prior period's
// per-category totals — so the page can render "X% vs the period before"
// rows without a second pass. For the oldest visible period, `priorByCategory`
// is filled by an extra (hidden) period that was loaded internally; if
// history doesn't extend that far back, it's null and the page renders
// dollar amounts with no percentage.
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
  | "ALCOHOL"
  | "PET_CARE"
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

export interface PeriodSummary {
  window: PeriodWindow;
  /**
   * Earned income only — sum of `|amount|` for rows where
   * `flow_type = 'EARNED_INCOME'` and amount < 0. Excludes internal
   * transfers, external help, refunds, and any incoming flow the user
   * has tagged separately.
   */
  incomeTotal: number;
  /**
   * Outgoing spending only — sum of amount for rows where
   * `flow_type = 'SPENDING'` and amount > 0. Excludes repayments,
   * transfers, and any other non-spending outflow.
   */
  outflowTotal: number;
  /** incomeTotal − outflowTotal. Positive = surplus. */
  net: number;
  /** Per-category outflow totals — SPENDING flow only. */
  byCategory: Record<RetrospectiveCategoryKey, number>;
  /**
   * Per-category totals for the period immediately before this one. `null`
   * for the oldest visible period when we have no history to compare
   * against — the page renders dollar amounts only in that case.
   */
  priorByCategory: Record<RetrospectiveCategoryKey, number> | null;
  /** Largest three SPENDING outflows, descending. */
  topTransactions: TopTransaction[];
  /** Sum of |amount| for EXTERNAL_GIFT + REIMBURSEMENT rows, plus count. */
  externalHelp: { total: number; count: number };
  /** Sum of amount for REPAYMENT rows (positive — money out), plus count. */
  repayments: { total: number; count: number };
  /** True when at least one non-pending transaction landed in this window. */
  hasData: boolean;
}

export interface RetrospectiveData {
  view: RetrospectiveView;
  /** Most recent first. May be shorter than `count` when history is shallow. */
  periods: PeriodSummary[];
  /**
   * True when we couldn't build even one period with real activity. The page
   * uses this for the "Not enough history yet" empty state.
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
 * Most recent N completed calendar months. Position 0 = previous month
 * (today's month is excluded — it's still in progress). On May 18 with
 * N=5, returns [Apr, Mar, Feb, Jan, Dec].
 */
function getCompletedMonths(today: Date, count: number): PeriodWindow[] {
  const result: PeriodWindow[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1 - i, 1));
    result.push(calendarMonthWindow(d.getUTCFullYear(), d.getUTCMonth()));
  }
  return result;
}

/**
 * Most recent N completed pay cycles, anchored to the latest fortnightly
 * salary inflow on file. The cycle containing `today` is in-progress and
 * is skipped — position 0 is the one that ended right before today.
 * Returns null when no anchor is available AND the dow-fallback can't
 * place a starting cycle (effectively never — fallback always succeeds).
 */
function getCompletedCycles(today: Date, count: number): PeriodWindow[] {
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

  const result: PeriodWindow[] = [];
  for (let i = 1; i <= count; i++) {
    const start = new Date(
      currentCycleStart.getTime() - i * CYCLE_LENGTH_DAYS * MS_PER_DAY,
    );
    result.push(cycleWindow(start));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Category bucketing
// ---------------------------------------------------------------------------

const CATEGORY_KEYS: RetrospectiveCategoryKey[] = [
  "FOOD_AND_DRINK",
  "MEDICAL",
  "GENERAL_MERCHANDISE",
  "ENTERTAINMENT",
  "ALCOHOL",
  "PET_CARE",
  "BILLS",
  "OTHER",
];

const EMPTY_BY_CATEGORY: Record<RetrospectiveCategoryKey, number> = {
  FOOD_AND_DRINK: 0,
  MEDICAL: 0,
  GENERAL_MERCHANDISE: 0,
  ENTERTAINMENT: 0,
  ALCOHOL: 0,
  PET_CARE: 0,
  BILLS: 0,
  OTHER: 0,
};

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
): RetrospectiveCategoryKey {
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
    case "ALCOHOL":
      return "ALCOHOL";
    case "PET_CARE":
      return "PET_CARE";
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

interface RawPeriod {
  window: PeriodWindow;
  incomeTotal: number;
  outflowTotal: number;
  net: number;
  byCategory: Record<RetrospectiveCategoryKey, number>;
  topTransactions: TopTransaction[];
  externalHelp: { total: number; count: number };
  repayments: { total: number; count: number };
  hasData: boolean;
}

function loadRawPeriod(
  window: PeriodWindow,
  billNames: Set<string>,
): RawPeriod {
  const db = getDb();

  // Spending outflows: only rows tagged `flow_type = 'SPENDING'` with
  // amount > 0. Internal transfers, repayments, and refunds (REIMBURSEMENT
  // tagged) are all excluded — they're surfaced separately below.
  // `enriched_name` (from PayPal CSV import) wins over the raw bank
  // descriptor whenever it's been set — so "Paypal Australia 105036…"
  // surfaces as "Spotify" / "ChatGPT" / etc. in the top-3 list.
  const outflowRows = db
    .prepare(
      `SELECT COALESCE(enriched_name, name) AS name, amount, date, category
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount > 0
          AND pending = 0
          AND flow_type = 'SPENDING'
        ORDER BY amount DESC`,
    )
    .all(window.startDate, window.endDate) as TxRow[];

  // Earned income only — INTERNAL_TRANSFER inflows are filtered out at
  // the flow_type level rather than via category-name guessing.
  const incomeRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount < 0
          AND pending = 0
          AND flow_type = 'EARNED_INCOME'`,
    )
    .get(window.startDate, window.endDate) as { total: number; count: number };
  const incomeTotal = Math.abs(incomeRow.total);

  // External help: gifts from family/friends + reimbursements/refunds.
  // Same sign convention as income (incoming = negative on row), so abs
  // for display.
  const helpRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND pending = 0
          AND flow_type IN ('EXTERNAL_GIFT', 'REIMBURSEMENT')`,
    )
    .get(window.startDate, window.endDate) as { total: number; count: number };
  const externalHelp = {
    total: Math.abs(helpRow.total),
    count: helpRow.count,
  };

  // Repayments: loan principal etc. Always outgoing (amount > 0).
  const repayRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount > 0
          AND pending = 0
          AND flow_type = 'REPAYMENT'`,
    )
    .get(window.startDate, window.endDate) as { total: number; count: number };
  const repayments = { total: repayRow.total, count: repayRow.count };

  const byCategory: Record<RetrospectiveCategoryKey, number> = {
    ...EMPTY_BY_CATEGORY,
  };
  let outflowTotal = 0;
  for (const row of outflowRows) {
    const bucket = bucketize(row.category, row.name, billNames);
    byCategory[bucket] += row.amount;
    outflowTotal += row.amount;
  }

  const topTransactions: TopTransaction[] = outflowRows
    .slice(0, 3)
    .map((r) => ({ name: r.name, amount: r.amount, date: r.date }));

  const hasData =
    outflowRows.length > 0 ||
    incomeRow.count > 0 ||
    helpRow.count > 0 ||
    repayRow.count > 0;

  return {
    window,
    incomeTotal,
    outflowTotal,
    net: incomeTotal - outflowTotal,
    byCategory,
    topTransactions,
    externalHelp,
    repayments,
    hasData,
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export const DEFAULT_PERIOD_COUNT = 5;
export const ALLOWED_PERIOD_COUNTS = [3, 5, 12] as const;

export function getRetrospective(
  view: RetrospectiveView,
  count: number = DEFAULT_PERIOD_COUNT,
  now: Date = new Date(),
): RetrospectiveData {
  const today = startOfUtcDay(now);

  // Pull one extra window so the oldest visible period has a prior-period
  // snapshot to compare against. The +1 is only consumed for its
  // `byCategory` — never rendered itself.
  const candidateWindows =
    view === "calendar"
      ? getCompletedMonths(today, count + 1)
      : getCompletedCycles(today, count + 1);

  if (candidateWindows.length === 0) {
    return { view, periods: [], notEnoughHistory: true };
  }

  const billNames = loadBillNames();
  const rawPeriods = candidateWindows.map((w) => loadRawPeriod(w, billNames));

  // Visible periods are the first `count` of the raw set.
  const visible = rawPeriods.slice(0, count);
  const hidden = rawPeriods[count]; // undefined when history shallower than N+1.

  // "Not enough history" only trips when no visible period has any
  // activity at all. A single sparse period is still worth showing.
  if (!visible.some((p) => p.hasData)) {
    return { view, periods: [], notEnoughHistory: true };
  }

  const periods: PeriodSummary[] = visible.map((p, i) => {
    // Prior = the next *raw* period (which is older, since they're sorted
    // most-recent-first). For periods[N-1] this falls through to the
    // hidden N+1th — null when we didn't manage to load one with real
    // history beyond the visible window.
    const next: RawPeriod | undefined = visible[i + 1] ?? hidden;
    const priorByCategory =
      next && next.hasData ? next.byCategory : null;
    return {
      window: p.window,
      incomeTotal: p.incomeTotal,
      outflowTotal: p.outflowTotal,
      net: p.net,
      byCategory: p.byCategory,
      priorByCategory,
      topTransactions: p.topTransactions,
      externalHelp: p.externalHelp,
      repayments: p.repayments,
      hasData: p.hasData,
    };
  });

  return { view, periods, notEnoughHistory: false };
}

// Re-exported so the page can iterate in the spec'd order without
// duplicating the list.
export const RETROSPECTIVE_CATEGORY_ORDER = CATEGORY_KEYS;
