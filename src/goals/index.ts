// ---------------------------------------------------------------------------
// Goals module.
//
// Three goal types share one table:
//   - savings:         "have $X in account by date Y"
//   - category-cap:    "spend at most $X on category Y this pay cycle"
//   - subscription-cap: "spend at most $X/month on a chosen set of bills"
//
// Status calculation lives here so the page can call `computeGoalStatus(goal)`
// without knowing the internals. Each goal type has its own computer, all
// returning the same `GoalStatus` shape so the card component stays simple.
// ---------------------------------------------------------------------------

import { getDb } from "../db/connection.js";
import { predictNextBillDate, addMonths } from "../db/bills.js";
import { forecastBalance } from "../csv-import/balance-forecast.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GoalType = "savings" | "category-cap" | "subscription-cap";

/**
 * Savings sub-modes:
 *   - balance: current = account.current_balance (passive tracking)
 *   - ledger: current = sum of user-logged contributions (explicit tracking)
 * Non-savings goals carry mode = 'balance' as a no-op so the column stays
 * NOT NULL.
 */
export type GoalMode = "balance" | "ledger";

export type GoalStatusLabel =
  | "on-track"
  | "off-track"
  | "achieved"
  | "missed"
  | "tight";

export interface SavingsGoalDetails {
  /** 'balance' or 'ledger' — drives which numbers the card displays. */
  mode: GoalMode;
  gapToTarget: number;
  monthsToTarget: number;
  savingsRateNeededMonthly: number;
  // --- ledger-only fields (zero/empty for balance mode) ---
  /** Number of logged contributions. */
  contributionCount: number;
  /** Days between the first contribution and today (or 0 if none). */
  daysSinceFirst: number;
  /** sum / contributionCount, or 0 if none. */
  avgPerContribution: number;
  /** (target - current) / monthsRemaining, capped at 0. */
  requiredMonthlyToHit: number;
  /** Display name of the linked account, for the "Held in: X" line. */
  accountName: string | null;
}

export interface CategoryCapDetails {
  dayOfCycle: number;
  cycleLengthDays: number;
  cycleStart: string;
  cycleEnd: string;
}

export interface SubscriptionListEntry {
  name: string;
  amount: number;
  willHitThisMonth: boolean;
}

export interface SubscriptionCapDetails {
  subscriptionsList: SubscriptionListEntry[];
  monthStart: string;
  monthEnd: string;
}

export type GoalDetails =
  | SavingsGoalDetails
  | CategoryCapDetails
  | SubscriptionCapDetails;

export interface GoalStatus {
  /** 0–1 fraction; can exceed 1 when overshooting. */
  progress: number;
  status: GoalStatusLabel;
  current: number;
  projected: number;
  details: GoalDetails;
}

/**
 * Display-shaped goal — JSON columns are parsed, dates are typed strings, and
 * `archived_at` is normalised to null. The raw DB row is `GoalRow` (internal).
 */
export interface Goal {
  id: number;
  type: GoalType;
  mode: GoalMode;
  name: string;
  target_amount: number;
  target_date: string | null;
  account_id: string | null;
  category: string | null;
  included_bill_ids: string[] | null;
  created_at: string;
  archived_at: string | null;
}

/** Input shape for create/update — `id` and timestamps are server-managed. */
export interface GoalInput {
  type: GoalType;
  /** Defaults to 'balance' if omitted; only meaningful for savings goals. */
  mode?: GoalMode;
  name: string;
  target_amount: number;
  target_date?: string | null;
  account_id?: string | null;
  category?: string | null;
  included_bill_ids?: string[] | null;
}

export interface GoalContribution {
  id: number;
  goal_id: number;
  amount: number;
  contribution_date: string;
  note: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GoalRow {
  id: number;
  type: string;
  mode: string | null;
  name: string;
  target_amount: number;
  target_date: string | null;
  account_id: string | null;
  category: string | null;
  included_bill_ids: string | null;
  created_at: string | null;
  archived_at: string | null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listActiveGoals(): Goal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, type, mode, name, target_amount, target_date, account_id, category,
              included_bill_ids, created_at, archived_at
         FROM goals
        WHERE archived_at IS NULL
        ORDER BY created_at DESC, id DESC`,
    )
    .all() as GoalRow[];
  return rows.map(rowToGoal);
}

export function getGoal(id: number): Goal | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, type, mode, name, target_amount, target_date, account_id, category,
              included_bill_ids, created_at, archived_at
         FROM goals
        WHERE id = ?`,
    )
    .get(id) as GoalRow | undefined;
  return row ? rowToGoal(row) : null;
}

export function createGoal(input: GoalInput): number {
  const db = getDb();
  const mode = effectiveMode(input);
  const info = db
    .prepare(
      `INSERT INTO goals (type, mode, name, target_amount, target_date, account_id, category, included_bill_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'))`,
    )
    .run(
      input.type,
      mode,
      input.name,
      input.target_amount,
      input.target_date ?? null,
      input.account_id ?? null,
      input.category ?? null,
      input.included_bill_ids ? JSON.stringify(input.included_bill_ids) : null,
    );
  return Number(info.lastInsertRowid);
}

export function updateGoal(id: number, input: GoalInput): void {
  const db = getDb();
  const mode = effectiveMode(input);
  db.prepare(
    `UPDATE goals
        SET type = ?,
            mode = ?,
            name = ?,
            target_amount = ?,
            target_date = ?,
            account_id = ?,
            category = ?,
            included_bill_ids = ?
      WHERE id = ?`,
  ).run(
    input.type,
    mode,
    input.name,
    input.target_amount,
    input.target_date ?? null,
    input.account_id ?? null,
    input.category ?? null,
    input.included_bill_ids ? JSON.stringify(input.included_bill_ids) : null,
    id,
  );
}

/**
 * `mode` is only meaningful for savings goals; for caps it's forced to
 * 'balance' so the column stays a stable no-op. Callers can still pass
 * mode for any type — it just gets ignored for non-savings.
 */
function effectiveMode(input: GoalInput): GoalMode {
  if (input.type !== "savings") return "balance";
  return input.mode === "ledger" ? "ledger" : "balance";
}

export function deleteGoal(id: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM goals WHERE id = ?`).run(id);
}

export function archiveGoal(id: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE goals SET archived_at = date('now') WHERE id = ? AND archived_at IS NULL`,
  ).run(id);
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    type: (row.type as GoalType) ?? "savings",
    mode: row.mode === "ledger" ? "ledger" : "balance",
    name: row.name,
    target_amount: row.target_amount,
    target_date: row.target_date,
    account_id: row.account_id,
    category: row.category,
    included_bill_ids: parseBillIds(row.included_bill_ids),
    created_at: row.created_at ?? "1970-01-01",
    archived_at: row.archived_at,
  };
}

function parseBillIds(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contributions — used by ledger-mode savings goals
// ---------------------------------------------------------------------------

export function listContributions(goalId: number): GoalContribution[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, goal_id, amount, contribution_date, note, created_at
         FROM goal_contributions
        WHERE goal_id = ?
        ORDER BY contribution_date DESC, id DESC`,
    )
    .all(goalId) as GoalContribution[];
}

export function addContribution(
  goalId: number,
  amount: number,
  contributionDate: string,
  note: string | null = null,
): number {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO goal_contributions (goal_id, amount, contribution_date, note)
       VALUES (?, ?, ?, ?)`,
    )
    .run(goalId, amount, contributionDate, note);
  return Number(info.lastInsertRowid);
}

export function deleteContribution(id: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM goal_contributions WHERE id = ?`).run(id);
}

export function sumContributions(goalId: number): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM goal_contributions
        WHERE goal_id = ?`,
    )
    .get(goalId) as { total: number };
  return row.total;
}

// ---------------------------------------------------------------------------
// Account over-allocation
// ---------------------------------------------------------------------------

export interface AccountAllocation {
  account_id: string;
  /** Display name (falls back to account_id if no row matched). */
  account_name: string;
  /** Sum of contributions across all ledger-mode goals on this account. */
  allocated: number;
  /** Current balance from `accounts.current_balance`. */
  balance: number;
  /** True when `allocated > balance` — drives the warning banner. */
  overallocated: boolean;
}

/**
 * For a given account, sum up the contributions across every ledger-mode
 * goal pointed at it, compare to the account's balance, and return the
 * allocation/over-allocation snapshot. Unknown accounts return zeros for
 * balance — they still surface their allocation total so the warning can
 * render something meaningful.
 */
export function computeAccountOverallocation(
  accountId: string,
): AccountAllocation {
  const db = getDb();
  const allocatedRow = db
    .prepare(
      `SELECT COALESCE(SUM(gc.amount), 0) AS total
         FROM goal_contributions gc
         JOIN goals g ON g.id = gc.goal_id
        WHERE g.mode = 'ledger'
          AND g.archived_at IS NULL
          AND g.account_id = ?`,
    )
    .get(accountId) as { total: number };

  const acctRow = db
    .prepare(
      `SELECT name, current_balance FROM accounts WHERE account_id = ?`,
    )
    .get(accountId) as {
    name: string;
    current_balance: number | null;
  } | undefined;

  const allocated = allocatedRow.total;
  const balance = acctRow?.current_balance ?? 0;
  return {
    account_id: accountId,
    account_name: acctRow?.name ?? accountId,
    allocated,
    balance,
    overallocated: allocated > balance,
  };
}

/**
 * Convenience for the page header: returns one allocation snapshot per
 * account that has at least one ledger-mode goal. Useful for rendering
 * the over-allocation banner without the page having to dig through goals
 * to find unique account IDs.
 */
export function listLedgerAccountAllocations(): AccountAllocation[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT account_id
         FROM goals
        WHERE mode = 'ledger'
          AND archived_at IS NULL
          AND account_id IS NOT NULL`,
    )
    .all() as { account_id: string }[];
  return rows.map((r) => computeAccountOverallocation(r.account_id));
}

// ---------------------------------------------------------------------------
// Status computation — dispatches on goal type
// ---------------------------------------------------------------------------

export function computeGoalStatus(goal: Goal, now: Date = new Date()): GoalStatus {
  switch (goal.type) {
    case "savings":
      return computeSavingsStatus(goal, now);
    case "category-cap":
      return computeCategoryCapStatus(goal, now);
    case "subscription-cap":
      return computeSubscriptionCapStatus(goal, now);
  }
}

// ---------------------------------------------------------------------------
// Savings status
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const CYCLE_LENGTH_DAYS = 14;
const AVG_DAYS_PER_MONTH = 30.44;

function computeSavingsStatus(goal: Goal, now: Date): GoalStatus {
  return goal.mode === "ledger"
    ? computeLedgerSavingsStatus(goal, now)
    : computeBalanceSavingsStatus(goal, now);
}

function computeBalanceSavingsStatus(goal: Goal, now: Date): GoalStatus {
  const db = getDb();
  const accountId = goal.account_id ?? "";
  const accountRow = db
    .prepare(
      `SELECT name, subtype, current_balance FROM accounts WHERE account_id = ?`,
    )
    .get(accountId) as {
    name: string;
    subtype: string | null;
    current_balance: number | null;
  } | undefined;
  const current = accountRow?.current_balance ?? 0;
  const accountName = accountRow?.name ?? null;
  // Savings accounts have no recurring bills routed through them — the
  // forecast engine (designed for spending accounts) would otherwise
  // subtract monthly budget + buffer from this balance for every cycle
  // and produce a wildly negative projection. For these accounts, the
  // realistic passive projection is "balance unchanged" — savings only
  // grow when the user actively moves money in.
  const isPassiveAccount = accountRow?.subtype === "savings";

  const today = startOfUtcDay(now);
  const targetDate = goal.target_date ? parseYMD(goal.target_date) : null;

  // Project balance forward to the target date. For passive savings
  // accounts the projection is static (balance unchanged) — see the
  // `isPassiveAccount` note above. For spending accounts we run the
  // existing forecast and pull the cycle that contains the target date.
  let projected = current;
  let monthsToTarget = 0;
  if (targetDate && targetDate > today) {
    const days = Math.max(1, Math.ceil((targetDate.getTime() - today.getTime()) / MS_PER_DAY));
    monthsToTarget = days / AVG_DAYS_PER_MONTH;
    if (!isPassiveAccount) {
      const cyclesNeeded = Math.min(52, Math.max(1, Math.ceil(days / CYCLE_LENGTH_DAYS)));
      try {
        const forecast = forecastBalance({
          accountId,
          cycleAnchorDayOfWeek: 3,
          numberOfCycles: cyclesNeeded,
        });
        // Use the cycle whose end is on or after the target date, otherwise the
        // last cycle (we projected enough that this can only happen if cycles
        // skewed shorter than expected).
        const targetYmd = goal.target_date!;
        const containing = forecast.cycles.find((c) => c.endDate >= targetYmd);
        const cycle = containing ?? forecast.cycles[forecast.cycles.length - 1];
        projected = cycle?.lifeAdjustedEndingBalance ?? current;
      } catch {
        // Unknown account — fall back to current balance so the page still
        // renders something useful.
        projected = current;
      }
    }
    // Passive accounts keep `projected = current`, set at declaration above.
  }

  const gapToTarget = goal.target_amount - projected;
  const savingsRateNeededMonthly =
    monthsToTarget > 0 && gapToTarget > 0 ? gapToTarget / monthsToTarget : 0;

  let status: GoalStatusLabel;
  if (current >= goal.target_amount) {
    status = "achieved";
  } else if (targetDate && targetDate < today) {
    status = "missed";
  } else if (projected >= goal.target_amount) {
    status = "on-track";
  } else {
    status = "off-track";
  }

  return {
    progress: goal.target_amount > 0 ? current / goal.target_amount : 0,
    status,
    current,
    projected,
    details: {
      mode: "balance",
      gapToTarget,
      monthsToTarget,
      savingsRateNeededMonthly,
      contributionCount: 0,
      daysSinceFirst: 0,
      avgPerContribution: 0,
      requiredMonthlyToHit: 0,
      accountName,
    },
  };
}

/**
 * Ledger-mode savings: progress comes from the explicit `goal_contributions`
 * log. Projection extrapolates the user's contribution pace forward to the
 * target date (avg-per-day × days remaining). If there are no contributions
 * yet, projection is just `current` so the gap reads as the full target.
 */
function computeLedgerSavingsStatus(goal: Goal, now: Date): GoalStatus {
  const db = getDb();
  const today = startOfUtcDay(now);
  const targetDate = goal.target_date ? parseYMD(goal.target_date) : null;

  // Pull the raw contribution facts in one query so we don't round-trip
  // for count / sum / earliest separately.
  const aggRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total,
              COUNT(*) AS count,
              MIN(contribution_date) AS first_date
         FROM goal_contributions
        WHERE goal_id = ?`,
    )
    .get(goal.id) as { total: number; count: number; first_date: string | null };

  const current = aggRow.total;
  const contributionCount = aggRow.count;

  let daysSinceFirst = 0;
  if (aggRow.first_date) {
    const first = parseYMD(aggRow.first_date);
    daysSinceFirst = Math.max(
      0,
      Math.floor((today.getTime() - first.getTime()) / MS_PER_DAY),
    );
  }

  const avgPerContribution =
    contributionCount > 0 ? current / contributionCount : 0;

  // Avg per day uses days-since-first so a single same-day contribution
  // doesn't get projected as the full daily rate forever. We need at least
  // one elapsed day of history before extrapolating a pace.
  const avgPerDay =
    daysSinceFirst > 0 && current > 0 ? current / daysSinceFirst : 0;

  let daysRemaining = 0;
  let monthsToTarget = 0;
  if (targetDate && targetDate > today) {
    daysRemaining = Math.ceil(
      (targetDate.getTime() - today.getTime()) / MS_PER_DAY,
    );
    monthsToTarget = daysRemaining / AVG_DAYS_PER_MONTH;
  }

  const projected =
    contributionCount === 0 || avgPerDay === 0
      ? current
      : current + avgPerDay * daysRemaining;

  const gapToTarget = goal.target_amount - projected;
  const requiredMonthlyToHit =
    monthsToTarget > 0 && goal.target_amount > current
      ? (goal.target_amount - current) / monthsToTarget
      : 0;
  const savingsRateNeededMonthly = requiredMonthlyToHit;

  let status: GoalStatusLabel;
  if (current >= goal.target_amount) {
    status = "achieved";
  } else if (targetDate && targetDate < today) {
    status = "missed";
  } else if (projected >= goal.target_amount) {
    status = "on-track";
  } else {
    status = "off-track";
  }

  const accountRow = goal.account_id
    ? (db
        .prepare(`SELECT name FROM accounts WHERE account_id = ?`)
        .get(goal.account_id) as { name: string } | undefined)
    : undefined;

  return {
    progress: goal.target_amount > 0 ? current / goal.target_amount : 0,
    status,
    current,
    projected,
    details: {
      mode: "ledger",
      gapToTarget,
      monthsToTarget,
      savingsRateNeededMonthly,
      contributionCount,
      daysSinceFirst,
      avgPerContribution,
      requiredMonthlyToHit,
      accountName: accountRow?.name ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Category-cap status
// ---------------------------------------------------------------------------

function computeCategoryCapStatus(goal: Goal, now: Date): GoalStatus {
  const db = getDb();
  const today = startOfUtcDay(now);
  const cycle = computeCurrentCycle(today);

  const category = goal.category ?? "";
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount > 0
          AND pending = 0
          AND category = ?`,
    )
    .get(cycle.startDate, cycle.endDate, category) as { total: number };

  const current = row.total;
  // Linear projection to cycle end. `dayOfCycle` is 1-indexed; guard against
  // a same-day computation (day 0) producing a divide-by-zero.
  const dayOfCycle = Math.max(1, cycle.dayOfCycle);
  const projected = current * (CYCLE_LENGTH_DAYS / dayOfCycle);

  const cycleOver = today > parseYMD(cycle.endDate);
  let status: GoalStatusLabel;
  if (cycleOver) {
    status = current <= goal.target_amount ? "achieved" : "missed";
  } else if (projected <= goal.target_amount) {
    // Tight band: within 10% of cap reads as amber, not green.
    status = projected >= goal.target_amount * 0.9 ? "tight" : "on-track";
  } else {
    status = "off-track";
  }

  return {
    progress: goal.target_amount > 0 ? current / goal.target_amount : 0,
    status,
    current,
    projected,
    details: {
      dayOfCycle: cycle.dayOfCycle,
      cycleLengthDays: CYCLE_LENGTH_DAYS,
      cycleStart: cycle.startDate,
      cycleEnd: cycle.endDate,
    },
  };
}

// ---------------------------------------------------------------------------
// Subscription-cap status
// ---------------------------------------------------------------------------

interface BillSpec {
  /** Composite id — "manual:<id>" or "stream:<stream_id>". */
  key: string;
  name: string;
  amount: number;
  /**
   * Whether a transaction matching this bill has already cleared this
   * calendar month — `current` sums these amounts.
   */
  hitThisMonth: boolean;
  /** Whether the bill is expected to charge at any point this month. */
  willHitThisMonth: boolean;
}

function computeSubscriptionCapStatus(goal: Goal, now: Date): GoalStatus {
  const today = startOfUtcDay(now);
  const monthStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  const monthEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
  );

  const includedIds = new Set(goal.included_bill_ids ?? []);
  const specs = collectIncludedBills(includedIds, monthStart, monthEnd);

  let current = 0;
  let projected = 0;
  for (const s of specs) {
    if (s.hitThisMonth) current += s.amount;
    if (s.willHitThisMonth) projected += s.amount;
  }

  const status: GoalStatusLabel =
    projected <= goal.target_amount ? "on-track" : "off-track";

  return {
    progress: goal.target_amount > 0 ? projected / goal.target_amount : 0,
    status,
    current,
    projected,
    details: {
      subscriptionsList: specs.map((s) => ({
        name: s.name,
        amount: s.amount,
        willHitThisMonth: s.willHitThisMonth,
      })),
      monthStart: toYMD(monthStart),
      monthEnd: toYMD(monthEnd),
    },
  };
}

/**
 * Resolve the included bill keys back into name/amount and decide whether
 * each one has cleared (transactions match this month) and whether it's
 * expected to charge again (next predicted date ≤ monthEnd).
 *
 * Bills can be either manual (`manual:<id>` → recurring_bills) or
 * stream-detected (`stream:<id>` → recurring). Anything in the include set
 * but missing from the DB is silently skipped — the goal is allowed to
 * outlive a deleted subscription without erroring.
 */
function collectIncludedBills(
  includedIds: Set<string>,
  monthStart: Date,
  monthEnd: Date,
): BillSpec[] {
  if (includedIds.size === 0) return [];

  const db = getDb();
  const specs: BillSpec[] = [];

  // --- Recurring streams ---
  const streamRows = db
    .prepare(
      `SELECT stream_id, description, merchant_name, frequency, avg_amount, last_amount, last_date
         FROM recurring
        WHERE is_active = 1
          AND stream_type = 'outflow'`,
    )
    .all() as {
    stream_id: string;
    description: string;
    merchant_name: string | null;
    frequency: string;
    avg_amount: number;
    last_amount: number | null;
    last_date: string | null;
  }[];

  for (const r of streamRows) {
    const key = `stream:${r.stream_id}`;
    if (!includedIds.has(key)) continue;
    const name = r.merchant_name || r.description;
    const amount = Math.abs(r.last_amount ?? r.avg_amount ?? 0);

    const hitThisMonth = streamHitThisMonth(r.last_date, monthStart, monthEnd);
    const willHitThisMonth = hitThisMonth || streamPredictedThisMonth(
      r.last_date,
      r.frequency,
      monthStart,
      monthEnd,
    );

    specs.push({ key, name, amount, hitThisMonth, willHitThisMonth });
  }

  // --- Manual bills ---
  const manualRows = db
    .prepare(
      `SELECT id, name, amount, day_of_month, frequency, next_due_date, last_paid_date
         FROM recurring_bills`,
    )
    .all() as {
    id: number;
    name: string;
    amount: number;
    day_of_month: number | null;
    frequency: string;
    next_due_date: string | null;
    last_paid_date: string | null;
  }[];

  for (const r of manualRows) {
    const key = `manual:${r.id}`;
    if (!includedIds.has(key)) continue;
    const hitThisMonth = manualHitThisMonth(r.last_paid_date, monthStart, monthEnd);
    const willHitThisMonth =
      hitThisMonth ||
      manualPredictedThisMonth(r, monthStart, monthEnd);
    specs.push({
      key,
      name: r.name,
      amount: r.amount,
      hitThisMonth,
      willHitThisMonth,
    });
  }

  return specs;
}

function streamHitThisMonth(
  lastDate: string | null,
  monthStart: Date,
  monthEnd: Date,
): boolean {
  if (!lastDate) return false;
  const d = parseYMD(lastDate);
  return d >= monthStart && d <= monthEnd;
}

function streamPredictedThisMonth(
  lastDate: string | null,
  frequency: string,
  monthStart: Date,
  monthEnd: Date,
): boolean {
  if (!lastDate) return false;
  let cursor = lastDate;
  // Walk forward at most 60 hops — plenty for any sane recurring cadence
  // inside a single month, and a hard ceiling against pathological inputs.
  for (let i = 0; i < 60; i++) {
    const next = predictNextBillDate(cursor, frequency);
    if (!next) return false;
    if (next > monthEnd) return false;
    if (next >= monthStart) return true;
    cursor = toYMD(next);
  }
  return false;
}

function manualHitThisMonth(
  lastPaidDate: string | null,
  monthStart: Date,
  monthEnd: Date,
): boolean {
  if (!lastPaidDate) return false;
  const d = parseYMD(lastPaidDate);
  return d >= monthStart && d <= monthEnd;
}

function manualPredictedThisMonth(
  row: {
    day_of_month: number | null;
    frequency: string;
    next_due_date: string | null;
  },
  monthStart: Date,
  monthEnd: Date,
): boolean {
  if (row.frequency === "monthly") {
    if (row.day_of_month === null) return false;
    const day = Math.min(
      row.day_of_month,
      monthEnd.getUTCDate(),
    );
    const target = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day),
    );
    return target >= monthStart && target <= monthEnd;
  }
  if (!row.next_due_date) return false;
  let d = parseYMD(row.next_due_date);
  if (row.frequency === "fortnightly" || row.frequency === "weekly") {
    const step = row.frequency === "fortnightly" ? 14 : 7;
    while (d < monthStart) d = new Date(d.getTime() + step * MS_PER_DAY);
    return d <= monthEnd;
  }
  if (
    row.frequency === "bi-monthly" ||
    row.frequency === "quarterly" ||
    row.frequency === "yearly"
  ) {
    const months =
      row.frequency === "bi-monthly"
        ? 2
        : row.frequency === "quarterly"
          ? 3
          : 12;
    while (d < monthStart) d = addMonths(d, months);
    return d <= monthEnd;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pay-cycle resolution — mirrors /fortnight's anchor logic
// ---------------------------------------------------------------------------

const ANCHOR_DOW = 3;

interface Cycle {
  startDate: string;
  endDate: string;
  dayOfCycle: number;
}

function computeCurrentCycle(today: Date): Cycle {
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

  let cycleStart: Date;
  if (salaryRow?.last_date) {
    let d = parseYMD(salaryRow.last_date);
    while (d.getTime() + CYCLE_LENGTH_DAYS * MS_PER_DAY <= today.getTime()) {
      d = new Date(d.getTime() + CYCLE_LENGTH_DAYS * MS_PER_DAY);
    }
    cycleStart = d;
  } else {
    const todayDow = today.getUTCDay();
    const daysBack = (todayDow - ANCHOR_DOW + 7) % 7;
    cycleStart = new Date(today.getTime() - daysBack * MS_PER_DAY);
  }

  const cycleEnd = new Date(
    cycleStart.getTime() + (CYCLE_LENGTH_DAYS - 1) * MS_PER_DAY,
  );
  const dayOfCycle =
    Math.floor((today.getTime() - cycleStart.getTime()) / MS_PER_DAY) + 1;

  return {
    startDate: toYMD(cycleStart),
    endDate: toYMD(cycleEnd),
    dayOfCycle,
  };
}

// ---------------------------------------------------------------------------
// Date helpers
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
