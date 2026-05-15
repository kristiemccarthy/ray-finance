import type Database from "libsql";

export type BillSource = "card" | "recurring" | "manual";

export type UpcomingBill = {
  date: Date;
  name: string;
  amount: number;
  source: BillSource;
  /** Optional secondary amount shown in parens, e.g. minimum payment for credit cards. */
  note?: string;
  /** Set only for source = "manual" — drives mark-as-paid actions in the UI. */
  manualBillId?: number;
};

export type PlaidFrequency =
  | "WEEKLY"
  | "BIWEEKLY"
  | "SEMI_MONTHLY"
  | "MONTHLY"
  | "ANNUALLY"
  | "UNKNOWN"
  | string;

/**
 * Predict the next occurrence after `lastDate` given Plaid's reported frequency.
 * Returns null for UNKNOWN/unsupported frequencies.
 */
export function predictNextBillDate(lastDate: string, frequency: PlaidFrequency): Date | null {
  const last = new Date(lastDate + "T00:00:00Z");
  if (isNaN(last.getTime())) return null;

  switch (frequency) {
    case "WEEKLY":
      return addDays(last, 7);
    case "BIWEEKLY":
      return addDays(last, 14);
    case "SEMI_MONTHLY": {
      // Paychecks/bills on the 1st and 15th of the month.
      const d = last.getUTCDate();
      if (d < 15) return new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 15));
      return new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1));
    }
    case "MONTHLY":
      return addMonths(last, 1);
    case "ANNUALLY":
      return addMonths(last, 12);
    default:
      return null;
  }
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

/** Add months, clamping to the last day of the target month (Jan 31 + 1mo → Feb 28/29). */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const day = d.getUTCDate();
  const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, daysInTarget)));
}

/**
 * Collect upcoming outflows from Plaid recurring streams, credit/mortgage/student
 * liability due dates, and manual recurring_bills. Sorted by date ascending.
 * Returns bills whose predicted date is between tomorrow and today+`days` inclusive.
 */
export function getUpcomingBills(db: Database.Database, days: number): UpcomingBill[] {
  const now = new Date();
  const today = startOfUtcDay(now);
  const windowStart = addDays(today, 1);
  const windowEnd = addDays(today, days);

  const bills: UpcomingBill[] = [];

  // 1. Plaid recurring streams (outflows only)
  const streams = db.prepare(
    `SELECT description, merchant_name, frequency, avg_amount, last_amount, last_date
     FROM recurring
     WHERE is_active = 1 AND stream_type = 'outflow' AND last_date IS NOT NULL`
  ).all() as {
    description: string;
    merchant_name: string | null;
    frequency: string;
    avg_amount: number;
    last_amount: number | null;
    last_date: string;
  }[];

  for (const s of streams) {
    const next = predictNextBillDate(s.last_date, s.frequency);
    if (!next) continue;
    if (next < windowStart || next > windowEnd) continue;
    const amount = Math.abs(s.last_amount ?? s.avg_amount ?? 0);
    if (amount === 0) continue;
    bills.push({
      date: next,
      name: s.merchant_name || s.description,
      amount,
      source: "recurring",
    });
  }

  // 2. Liabilities with a scheduled due date
  const liabs = db.prepare(
    `SELECT l.type, l.current_balance, l.minimum_payment, l.next_payment_due, a.name as account_name
     FROM liabilities l
     JOIN accounts a ON a.account_id = l.account_id
     WHERE l.next_payment_due IS NOT NULL`
  ).all() as {
    type: string;
    current_balance: number | null;
    minimum_payment: number | null;
    next_payment_due: string;
    account_name: string;
  }[];

  for (const l of liabs) {
    const due = new Date(l.next_payment_due + "T00:00:00Z");
    if (isNaN(due.getTime())) continue;
    if (due < windowStart || due > windowEnd) continue;

    if (l.type === "credit") {
      const stmt = l.current_balance ?? 0;
      if (stmt <= 0) continue;
      bills.push({
        date: due,
        name: l.account_name,
        amount: stmt,
        source: "card",
        note: l.minimum_payment != null ? `min ${formatShortMoney(l.minimum_payment)}` : undefined,
      });
    } else {
      const min = l.minimum_payment ?? 0;
      if (min <= 0) continue;
      bills.push({
        date: due,
        name: l.account_name,
        amount: min,
        source: "card",
      });
    }
  }

  // 3. Manual recurring_bills — three families of cadence:
  //    - monthly: emit the next match of `day_of_month` strictly after today
  //      if it lands in the window (single occurrence, matching the long-
  //      standing behaviour for credit/liability dates above).
  //    - fortnightly / weekly: emit *every* occurrence in the window, walked
  //      from `next_due_date` in 14- or 7-day steps.
  //    - bi-monthly / quarterly / yearly: walk forward in 2 / 3 / 12 calendar
  //      months from `next_due_date`, emitting any occurrence that lands in
  //      the window. Calendar-month addition clamps end-of-month edges
  //      (Jan 31 + 1mo → Feb 28/29) so a bill due on the 31st survives Feb.
  //    Rows missing the field their cadence requires are skipped silently.
  const manual = db.prepare(
    `SELECT id, name, amount, day_of_month, frequency, next_due_date, last_paid_date FROM recurring_bills`
  ).all() as {
    id: number;
    name: string;
    amount: number;
    day_of_month: number | null;
    frequency: string;
    next_due_date: string | null;
    last_paid_date: string | null;
  }[];

  for (const m of manual) {
    if (m.frequency === "monthly") {
      if (m.day_of_month === null) continue;
      const next = nextDayOfMonthDate(today, m.day_of_month);
      if (next < windowStart || next > windowEnd) continue;
      if (isOccurrencePaid(m.last_paid_date, next, { months: 1 })) continue;
      bills.push({ date: next, name: m.name, amount: m.amount, source: "manual", manualBillId: m.id });
    } else if (m.frequency === "fortnightly" || m.frequency === "weekly") {
      if (!m.next_due_date) continue;
      const intervalDays = m.frequency === "fortnightly" ? 14 : 7;
      let d = new Date(m.next_due_date + "T00:00:00Z");
      if (isNaN(d.getTime())) continue;
      // Fast-forward to the first occurrence on or after windowStart, then
      // emit every occurrence up to windowEnd inclusive. Each occurrence's
      // own preceding interval defines its billing period, so a single
      // last_paid_date only suppresses the one cycle it covers.
      while (d < windowStart) d = addDays(d, intervalDays);
      while (d <= windowEnd) {
        if (!isOccurrencePaid(m.last_paid_date, d, intervalDays)) {
          bills.push({ date: d, name: m.name, amount: m.amount, source: "manual", manualBillId: m.id });
        }
        d = addDays(d, intervalDays);
      }
    } else if (m.frequency === "bi-monthly" || m.frequency === "quarterly" || m.frequency === "yearly") {
      if (!m.next_due_date) continue;
      const intervalMonths = m.frequency === "bi-monthly" ? 2 : m.frequency === "quarterly" ? 3 : 12;
      let d = new Date(m.next_due_date + "T00:00:00Z");
      if (isNaN(d.getTime())) continue;
      while (d < windowStart) d = addMonths(d, intervalMonths);
      while (d <= windowEnd) {
        if (!isOccurrencePaid(m.last_paid_date, d, { months: intervalMonths })) {
          bills.push({ date: d, name: m.name, amount: m.amount, source: "manual", manualBillId: m.id });
        }
        d = addMonths(d, intervalMonths);
      }
    }
  }

  bills.sort((a, b) => a.date.getTime() - b.date.getTime());
  return bills;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * For a manual bill occurrence on `occurrenceDate`, return true if
 * `lastPaidDate` falls within the billing period that precedes it. The
 * period is `[occurrenceDate - interval, occurrenceDate - 1]` inclusive.
 * `interval` is either a number of days (7 / 14 for weekly / fortnightly) or
 * `{ months: N }` for calendar-month cadences (1 = monthly, 2 = bi-monthly,
 * 3 = quarterly, 12 = yearly). Month arithmetic clamps to the last day of
 * the target month so a bill due on the 31st walks back cleanly through Feb.
 * A null or unparseable `lastPaidDate` returns false — nothing to suppress.
 */
export function isOccurrencePaid(
  lastPaidDate: string | null,
  occurrenceDate: Date,
  interval: number | { months: number },
): boolean {
  if (!lastPaidDate) return false;
  const paid = new Date(lastPaidDate + "T00:00:00Z");
  if (isNaN(paid.getTime())) return false;

  let periodStart: Date;
  if (typeof interval === "object") {
    periodStart = addMonths(occurrenceDate, -interval.months);
  } else {
    periodStart = addDays(occurrenceDate, -interval);
  }
  const periodEnd = addDays(occurrenceDate, -1);
  return paid >= periodStart && paid <= periodEnd;
}

/** Next calendar date matching the given day-of-month, clamping to month length. */
function nextDayOfMonthDate(today: Date, dayOfMonth: number): Date {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const daysThisMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const clampedThisMonth = Math.min(dayOfMonth, daysThisMonth);
  const candidate = new Date(Date.UTC(y, m, clampedThisMonth));
  if (candidate > today) return candidate;
  const daysNextMonth = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + 1, Math.min(dayOfMonth, daysNextMonth)));
}

function formatShortMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}
