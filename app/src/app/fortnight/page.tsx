import Link from "next/link";
import { getDb } from "@ray/db/connection";
import { getPendingSummary, getPendingForCycle } from "@ray/pending";
import {
  categoriseWithRules,
  loadCategoryOverrides,
  DEFAULT_CATEGORY,
} from "@ray/csv-import/categoriser";

export const dynamic = "force-dynamic";

const MS_PER_DAY = 86_400_000;
const ANCHOR_DOW = 3; // Wednesday — salary lands fortnightly on this day.
const CYCLE_LENGTH_DAYS = 14;
// 30.44 days / 14 = 2.174 cycles per average month. Matches balance-forecast.
const CYCLES_PER_MONTH = 2.17;

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const moneyFormatterCents = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

interface BudgetRow {
  category: string;
  monthly_limit: number;
}

interface CategoryRow {
  category: string;
  total: number;
}

interface Cycle {
  startDate: string;
  endDate: string;
  dayOfCycle: number;
  fractionElapsed: number;
}

interface CategoryStatus {
  category: string;
  label: string;
  spent: number;
  fortnightTarget: number;
  expectedByNow: number;
  variance: number;
  status: "blue" | "green" | "amber" | "red";
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseYMD(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

/**
 * Anchor the current cycle to the most recent actual salary deposit so the
 * 14-day window lines up with the fortnightly pay rhythm rather than just
 * "the most recent Wednesday" (which could land mid-cycle for fortnightly
 * pay). Falls back to dow-3 arithmetic if no inflow stream is on file.
 */
function computeCurrentCycle(today: Date): Cycle {
  const db = getDb();
  // Filter to fortnightly inflows and pick the largest by avg_amount — salary
  // dwarfs other repeat inflows (personal payments, card top-ups). Ordering by
  // `last_date` would pick whichever fortnightly inflow happened to land most
  // recently, which is often not the actual paycheck.
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
    // Walk forward in 14-day steps to the most recent anchor <= today.
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
  const fractionElapsed = Math.min(
    1,
    Math.max(0, dayOfCycle / CYCLE_LENGTH_DAYS),
  );

  return {
    startDate: toYMD(cycleStart),
    endDate: toYMD(cycleEnd),
    dayOfCycle,
    fractionElapsed,
  };
}

function humaniseCategory(category: string): string {
  const overrides: Record<string, string> = {
    FOOD_AND_DRINK: "Food & Drink",
    GENERAL_MERCHANDISE: "Shopping",
    GENERAL_SERVICES: "Services",
    RENT_AND_UTILITIES: "Rent & Utilities",
    BANK_FEES: "Bank Fees",
    ALCOHOL: "Alcohol",
    PET_CARE: "Pet Care",
  };
  if (overrides[category]) return overrides[category];
  return category
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

function statusFromRatio(
  spent: number,
  expected: number,
): CategoryStatus["status"] {
  // If nothing's expected yet (very start of cycle), treat any spend > 0 as
  // ahead of pace. Avoids divide-by-zero and a misleading "blue" reading.
  if (expected <= 0) return spent > 0 ? "amber" : "blue";
  const ratio = spent / expected;
  if (ratio < 0.9) return "blue";
  if (ratio <= 1.1) return "green";
  if (ratio <= 1.25) return "amber";
  return "red";
}

const STATUS_STRIPE: Record<CategoryStatus["status"], string> = {
  blue: "bg-blue-400",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

const STATUS_TEXT: Record<CategoryStatus["status"], string> = {
  blue: "text-blue-600",
  green: "text-emerald-600",
  amber: "text-amber-600",
  red: "text-red-600",
};

function loadCategoryStatuses(
  cycle: Cycle,
): { categories: CategoryStatus[]; other: number } {
  const db = getDb();
  const budgets = db
    .prepare(`SELECT category, monthly_limit FROM budgets ORDER BY monthly_limit DESC`)
    .all() as BudgetRow[];

  const totals = db
    .prepare(
      `SELECT category, COALESCE(SUM(amount), 0) AS total
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount > 0
          AND pending = 0
        GROUP BY category`,
    )
    .all(cycle.startDate, cycle.endDate) as CategoryRow[];

  const totalsByCategory = new Map<string, number>();
  for (const row of totals) {
    totalsByCategory.set(row.category, row.total);
  }

  const budgetCategorySet = new Set(budgets.map((b) => b.category));
  // Family of categories that aren't real outgoing spend — mirrors the
  // settled "Other" query's exclusions below.
  const NON_SPEND = new Set([
    "TRANSFER_IN",
    "TRANSFER_OUT",
    "INCOME",
    "LOAN_PAYMENTS",
  ]);

  // Settled-only budgeted total, captured before folding pending in, so the
  // "Other" maths can subtract the right (settled) figure from the settled
  // all-outflows query.
  let settledBudgetedTotal = 0;
  for (const b of budgets) settledBudgetedTotal += totalsByCategory.get(b.category) ?? 0;

  // Fold in-cycle pending into the per-category totals. Pending rows carry no
  // stored category, so we categorise each at query time with Ray's existing
  // categoriser (PFC description rules + user overrides). Same outflow filters
  // as the settled queries: positive amounts only, transfers/income excluded.
  // Budgeted categories flow into their cards; everything else accrues into a
  // pending "Other" bucket added to the settled "Other" below.
  const rules = loadCategoryOverrides();
  const pendingRows = getPendingForCycle(cycle.startDate, cycle.endDate);
  let pendingOther = 0;
  for (const row of pendingRows) {
    if (row.amount <= 0) continue;
    const result = categoriseWithRules(
      row.description,
      row.description,
      rules,
      row.amount,
    );
    const category = result?.category ?? DEFAULT_CATEGORY.category;
    if (NON_SPEND.has(category)) continue;
    if (budgetCategorySet.has(category)) {
      totalsByCategory.set(category, (totalsByCategory.get(category) ?? 0) + row.amount);
    } else {
      pendingOther += row.amount;
    }
  }

  const categories: CategoryStatus[] = budgets.map((b) => {
    const spent = totalsByCategory.get(b.category) ?? 0;
    const fortnightTarget = b.monthly_limit / CYCLES_PER_MONTH;
    const expectedByNow = cycle.fractionElapsed * fortnightTarget;
    const variance = spent - expectedByNow;
    return {
      category: b.category,
      label: humaniseCategory(b.category),
      spent,
      fortnightTarget,
      expectedByNow,
      variance,
      status: statusFromRatio(spent, expectedByNow),
    };
  });

  // "Other" = everything else that's a real outgoing spend in the cycle. Skip
  // transfers (between own accounts) and INCOME (sign quirks); everything
  // else is fair game and matches the footer caveat about including bills.
  const allOutflows = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
        WHERE date BETWEEN ? AND ?
          AND amount > 0
          AND pending = 0
          AND category NOT IN ('TRANSFER_IN', 'TRANSFER_OUT', 'INCOME', 'LOAN_PAYMENTS')`,
    )
    .get(cycle.startDate, cycle.endDate) as { total: number };

  // Settled non-budgeted spend, plus the pending non-budgeted spend folded in
  // above. Subtract the *settled* budgeted total (not the now-pending-inclusive
  // card totals) so pending budgeted spend isn't double-counted out of "Other".
  const settledOther = Math.max(0, allOutflows.total - settledBudgetedTotal);
  const other = settledOther + pendingOther;

  return { categories, other };
}

/**
 * Format a variance for the "X over/under pace" lines. Over-pace amounts get
 * an explicit "+" to signal direction; under-pace amounts drop the minus and
 * render as a plain dollar figure — the trailing "under pace" already conveys
 * the sign, and the bare minus reads as a typographical wart.
 */
function paceMoney(variance: number): string {
  if (variance < 0) return moneyFormatter.format(Math.abs(variance));
  return `+${moneyFormatter.format(variance)}`;
}

/**
 * Sum of cycle outflows whose display name matches an active recurring
 * outflow stream. Approximation — Plaid clusters set `recurring.merchant_name`
 * to the post-alias display name, which is also what `transactions.name`
 * carries after our own alias pass. A transaction that's not in a recurring
 * stream (one-off groceries, ad-hoc purchases) is excluded.
 */
function loadBillsPaid(cycle: Cycle): number {
  const db = getDb();
  // Match on the enriched name when available — `recurring.merchant_name`
  // is now derived from the enriched value (the detector groups by
  // `COALESCE(enriched_name, name)`), so a PayPal-paid subscription's
  // bank descriptor ("Paypal Australia ###") would never satisfy the IN
  // clause if we compared against `t.name` directly.
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS total
         FROM transactions t
        WHERE t.date BETWEEN ? AND ?
          AND t.amount > 0
          AND t.pending = 0
          AND COALESCE(t.enriched_name, t.name) IN (
            SELECT merchant_name FROM recurring
             WHERE is_active = 1
               AND stream_type = 'outflow'
               AND merchant_name IS NOT NULL
          )`,
    )
    .get(cycle.startDate, cycle.endDate) as { total: number };
  return row.total;
}

export default function FortnightPage() {
  const today = startOfUtcDay(new Date());
  const cycle = computeCurrentCycle(today);
  const { categories, other } = loadCategoryStatuses(cycle);
  const billsPaid = loadBillsPaid(cycle);
  // Scope pending to the current cycle so stale pending from a prior cycle
  // doesn't leak into this fortnight's totals.
  const pending = getPendingSummary(cycle.startDate, cycle.endDate);

  // Category cards now fold in-cycle pending into their spent totals (see
  // loadCategoryStatuses), so the summed card total is authoritative for the
  // headline — settled + pending in one figure, no separate pending add-on.
  const totalSpent = categories.reduce((s, c) => s + c.spent, 0);
  const totalFortnightTarget = categories.reduce(
    (s, c) => s + c.fortnightTarget,
    0,
  );
  const totalExpected = cycle.fractionElapsed * totalFortnightTarget;
  const totalVariance = totalSpent - totalExpected;
  const totalStatus = statusFromRatio(totalSpent, totalExpected);
  // Lead with what's left, not what's spent. Negative = blown the budget.
  // Strict `< 0` so an exact-zero remaining still reads as "$0 remaining"
  // rather than the louder "over budget" framing.
  const totalRemaining = totalFortnightTarget - totalSpent;
  const isOverBudget = totalRemaining < 0;

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          This Fortnight
        </h1>

        <section className="mt-12 mb-14 text-center">
          <div className="text-sm text-neutral-500">
            Day {cycle.dayOfCycle} of {CYCLE_LENGTH_DAYS}
          </div>
          <div
            className={`mt-2 text-3xl font-semibold tabular-nums ${
              isOverBudget ? "text-red-600" : "text-neutral-900"
            }`}
          >
            {isOverBudget
              ? `${moneyFormatter.format(Math.abs(totalRemaining))} over budget`
              : `${moneyFormatter.format(totalRemaining)} remaining`}
          </div>
          <div className="mt-1 text-sm text-neutral-500">
            across {moneyFormatter.format(totalFortnightTarget)} fortnight budget
          </div>
          <div className="mt-2 text-sm text-neutral-500 tabular-nums">
            {moneyFormatter.format(totalSpent)} spent so far
          </div>
          {pending.total > 0 && (
            <div className="mt-1 text-xs text-neutral-500 tabular-nums">
              of which{" "}
              <Link
                href="/"
                className="underline-offset-2 hover:text-neutral-800 hover:underline"
              >
                {moneyFormatter.format(pending.total)} is still pending across{" "}
                {pending.count}{" "}
                {pending.count === 1 ? "transaction" : "transactions"}
              </Link>
            </div>
          )}
          <div className={`mt-3 text-sm font-medium ${STATUS_TEXT[totalStatus]}`}>
            {paceMoney(totalVariance)}{" "}
            {totalVariance >= 0 ? "over" : "under"} pace
          </div>
        </section>

        <ul className="space-y-3">
          {categories.map((c) => (
            <CategoryCard key={c.category} cat={c} />
          ))}
        </ul>

        <p className="mt-8 text-center text-xs text-neutral-500">
          Bills paid this cycle:{" "}
          <span className="tabular-nums">
            {moneyFormatterCents.format(billsPaid)}
          </span>
        </p>

        {other > 0 && (
          <p className="mt-2 text-center text-xs text-neutral-500">
            Other spending this cycle:{" "}
            <span className="tabular-nums">
              {moneyFormatterCents.format(other)}
            </span>
          </p>
        )}

        <p className="mt-16 text-center text-xs leading-relaxed text-neutral-400">
          Includes all spending in your accounts — bills and discretionary.
          Compare to per-category fortnightly budget pace.
        </p>
      </div>
    </main>
  );
}

function CategoryCard({ cat }: { cat: CategoryStatus }) {
  const overUnder = cat.variance >= 0 ? "over pace" : "under pace";
  // Same framing as the hero: lead with remaining, flip to "over budget"
  // only on strictly negative remaining. Stripe colour stays driven by
  // pace ratio so being-over-budget and being-over-pace can disagree
  // visually (which is intentional — you could be just-barely-over budget
  // while still under pace late in the cycle).
  const remaining = cat.fortnightTarget - cat.spent;
  const isOverBudget = remaining < 0;
  return (
    <li className="flex overflow-hidden rounded-md border border-stone-200 bg-white">
      <span aria-hidden className={`w-1 shrink-0 ${STATUS_STRIPE[cat.status]}`} />
      <div className="flex-1 px-5 py-5">
        <div className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          {cat.label}
        </div>
        <div
          className={`mt-1 text-2xl font-semibold tabular-nums ${
            isOverBudget ? "text-red-600" : "text-neutral-900"
          }`}
        >
          {isOverBudget
            ? `${moneyFormatter.format(Math.abs(remaining))} over budget`
            : `${moneyFormatter.format(remaining)} remaining`}
        </div>
        <div className="mt-1 text-xs text-neutral-500 tabular-nums">
          {moneyFormatterCents.format(cat.spent)} spent of{" "}
          {moneyFormatter.format(cat.fortnightTarget)}
        </div>
        <div className={`mt-2 text-xs font-medium ${STATUS_TEXT[cat.status]}`}>
          {paceMoney(cat.variance)} {overUnder}
        </div>
      </div>
    </li>
  );
}
