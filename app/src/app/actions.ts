"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@ray/db/connection";

// ---------------------------------------------------------------------------
// Types shared with the bill form
// ---------------------------------------------------------------------------

export type BillFrequency = "monthly" | "fortnightly" | "weekly";
export type AmountType = "fixed" | "range";

export type BillFormValues = {
  name: string;
  amountType: AmountType;
  amount: string;
  amountMin: string;
  amountMax: string;
  frequency: BillFrequency;
  dayOfMonth: string;
  nextDueDate: string;
  type: string;
  accountId: string;
};

export type BillFormState = {
  errors?: Partial<Record<keyof BillFormValues, string>>;
  values?: BillFormValues;
};

// ---------------------------------------------------------------------------
// Mark paid (existing)
// ---------------------------------------------------------------------------

/**
 * Stamp a manual bill as paid today. `last_paid_date` covers the bill's
 * current billing period, so the row will disappear from /, /forecast,
 * and /fortnight until the next cycle rolls around.
 */
export async function markBillPaid(billId: number): Promise<void> {
  const db = getDb();
  db.prepare(`UPDATE recurring_bills SET last_paid_date = date('now') WHERE id = ?`).run(
    billId,
  );
  revalidateBillViews();
}

// ---------------------------------------------------------------------------
// Validation helper — shared between add and update
// ---------------------------------------------------------------------------

type ParsedBill = {
  name: string;
  amount: number;
  frequency: BillFrequency;
  day_of_month: number | null;
  next_due_date: string | null;
  type: string | null;
  account_id: string | null;
};

function valuesFromFormData(formData: FormData): BillFormValues {
  return {
    name: String(formData.get("name") ?? "").trim(),
    amountType: (String(formData.get("amountType") ?? "fixed") as AmountType) === "range"
      ? "range"
      : "fixed",
    amount: String(formData.get("amount") ?? "").trim(),
    amountMin: String(formData.get("amountMin") ?? "").trim(),
    amountMax: String(formData.get("amountMax") ?? "").trim(),
    frequency: normaliseFrequency(String(formData.get("frequency") ?? "monthly")),
    dayOfMonth: String(formData.get("dayOfMonth") ?? "").trim(),
    nextDueDate: String(formData.get("nextDueDate") ?? "").trim(),
    type: String(formData.get("type") ?? "").trim(),
    accountId: String(formData.get("accountId") ?? "").trim(),
  };
}

function normaliseFrequency(s: string): BillFrequency {
  if (s === "fortnightly" || s === "weekly") return s;
  return "monthly";
}

/**
 * Server-side validation. Mirrors the rules the form enforces client-side
 * but runs unconditionally — defence in depth against malformed POSTs.
 * Returns either the cleaned row ready for INSERT/UPDATE or per-field
 * error messages keyed by the form field name.
 */
function validate(
  values: BillFormValues,
):
  | { ok: true; data: ParsedBill }
  | { ok: false; errors: Partial<Record<keyof BillFormValues, string>> } {
  const errors: Partial<Record<keyof BillFormValues, string>> = {};

  if (!values.name) errors.name = "Name is required.";

  let amount = 0;
  let displayName = values.name;
  if (values.amountType === "range") {
    const lo = Number.parseFloat(values.amountMin);
    const hi = Number.parseFloat(values.amountMax);
    if (!Number.isFinite(lo) || lo <= 0) {
      errors.amountMin = "Min must be a positive number.";
    }
    if (!Number.isFinite(hi) || hi <= 0) {
      errors.amountMax = "Max must be a positive number.";
    }
    if (
      Number.isFinite(lo) &&
      Number.isFinite(hi) &&
      lo > 0 &&
      hi > 0 &&
      hi < lo
    ) {
      errors.amountMax = "Max must be greater than or equal to min.";
    }
    if (!errors.amountMin && !errors.amountMax) {
      amount = (lo + hi) / 2;
      displayName = `${values.name} ($${formatBound(lo)}-$${formatBound(hi)})`;
    }
  } else {
    const n = Number.parseFloat(values.amount);
    if (!Number.isFinite(n) || n <= 0) {
      errors.amount = "Amount must be a positive number.";
    } else {
      amount = n;
    }
  }

  let day_of_month: number | null = null;
  let next_due_date: string | null = null;
  if (values.frequency === "monthly") {
    const d = Number.parseInt(values.dayOfMonth, 10);
    if (!Number.isInteger(d) || d < 1 || d > 31) {
      errors.dayOfMonth = "Day of month must be between 1 and 31.";
    } else {
      day_of_month = d;
    }
  } else {
    // fortnightly / weekly — need a valid ISO date.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.nextDueDate)) {
      errors.nextDueDate = "Next due date is required (YYYY-MM-DD).";
    } else {
      const parsed = new Date(values.nextDueDate + "T00:00:00Z");
      if (isNaN(parsed.getTime())) {
        errors.nextDueDate = "Next due date is not a valid date.";
      } else {
        next_due_date = values.nextDueDate;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      name: displayName,
      amount,
      frequency: values.frequency,
      day_of_month,
      next_due_date,
      type: values.type || "manual",
      account_id: values.accountId || null,
    },
  };
}

function formatBound(n: number): string {
  const fixed = n.toFixed(2);
  return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed;
}

function revalidateBillViews(): void {
  revalidatePath("/");
  revalidatePath("/forecast");
  revalidatePath("/fortnight");
  revalidatePath("/bills/manage");
}

// ---------------------------------------------------------------------------
// Add / update / delete
// ---------------------------------------------------------------------------

export async function addBill(
  _prev: BillFormState,
  formData: FormData,
): Promise<BillFormState> {
  const values = valuesFromFormData(formData);
  const result = validate(values);
  if (!result.ok) return { errors: result.errors, values };

  const db = getDb();
  db.prepare(
    `INSERT INTO recurring_bills
       (name, amount, day_of_month, type, account_id, frequency, next_due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.data.name,
    result.data.amount,
    result.data.day_of_month,
    result.data.type,
    result.data.account_id,
    result.data.frequency,
    result.data.next_due_date,
  );

  revalidateBillViews();
  redirect("/bills/manage");
}

export async function updateBill(
  id: number,
  _prev: BillFormState,
  formData: FormData,
): Promise<BillFormState> {
  const values = valuesFromFormData(formData);
  const result = validate(values);
  if (!result.ok) return { errors: result.errors, values };

  const db = getDb();
  db.prepare(
    `UPDATE recurring_bills
        SET name = ?,
            amount = ?,
            day_of_month = ?,
            type = ?,
            account_id = ?,
            frequency = ?,
            next_due_date = ?
      WHERE id = ?`,
  ).run(
    result.data.name,
    result.data.amount,
    result.data.day_of_month,
    result.data.type,
    result.data.account_id,
    result.data.frequency,
    result.data.next_due_date,
    id,
  );

  revalidateBillViews();
  redirect("/bills/manage");
}

export async function deleteBill(id: number): Promise<void> {
  const db = getDb();
  db.prepare(`DELETE FROM recurring_bills WHERE id = ?`).run(id);
  revalidateBillViews();
  redirect("/bills/manage");
}
