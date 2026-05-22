"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@ray/db/connection";
import {
  refreshFromDirectory,
  type RefreshSummary,
} from "@ray/csv-import/refresh";
import {
  extractPendingFromImage,
  replacePending,
  getPendingSummary,
  type PendingSummary,
  type SupportedImageMimeType,
} from "@ray/pending";
import {
  parsePaypalCsv,
  importPaypalCsv,
  matchPaypalToBank,
  recategoriseEnrichedTransactions,
  type PaypalImportSummary,
} from "@ray/paypal";
import { detectRecurring } from "@ray/csv-import/recurring-detector";
import {
  recategoriseAllTransactions,
  recategoriseTransaction,
} from "@ray/csv-import/recategorise";
// Sync constants (and derived value-sets) live in a plain-TS module —
// "use server" files can only export async actions, not constants.
import {
  VALID_CATEGORY_VALUES,
  VALID_FLOW_TYPES,
} from "./settings/categories/form-values";
import {
  forecastBalance,
  loadForecastSources,
  type ForecastResult,
} from "@ray/csv-import/balance-forecast";
import {
  applyScenario,
  sanitiseScenario,
  type Scenario,
} from "@ray/forecast/scenario";
import {
  createGoal as createGoalRow,
  updateGoal as updateGoalRow,
  deleteGoal as deleteGoalRow,
  archiveGoal as archiveGoalRow,
  addContribution,
  deleteContribution,
  type GoalInput,
  type GoalMode,
  type GoalType,
} from "@ray/goals";

// ---------------------------------------------------------------------------
// Types shared with the bill form
// ---------------------------------------------------------------------------

export type BillFrequency =
  | "monthly"
  | "bi-monthly"
  | "quarterly"
  | "yearly"
  | "fortnightly"
  | "weekly";
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
  if (
    s === "fortnightly" ||
    s === "weekly" ||
    s === "bi-monthly" ||
    s === "quarterly" ||
    s === "yearly"
  ) {
    return s;
  }
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
// Refresh data (CSV / PDF re-import)
// ---------------------------------------------------------------------------

/** Where bank statement exports land. Hard-coded for this single-user app. */
const STATEMENTS_DIR = String.raw`C:\Users\krist\Downloads\Bank statements`;

/**
 * Re-import every configured statement file from the downloads directory.
 * Each source is run in its own try/catch by `refreshFromDirectory`, so a
 * malformed CSV doesn't block the others. Re-renders every view that
 * derives from transactions so the UI catches up in one round-trip.
 */
export async function refreshData(): Promise<RefreshSummary> {
  const summary = await refreshFromDirectory(STATEMENTS_DIR);
  revalidatePath("/");
  revalidatePath("/forecast");
  revalidatePath("/fortnight");
  revalidatePath("/balances");
  return summary;
}

// ---------------------------------------------------------------------------
// Update pending (Claude vision)
// ---------------------------------------------------------------------------

/**
 * Outcome of an update-pending attempt. `ok: true` always carries a
 * `summary`; `ok: false` always carries an `error`. The client toast
 * decides which copy to show based on the discriminator.
 */
export type UpdatePendingResult =
  | { ok: true; summary: PendingSummary }
  | { ok: false; error: string };

const SUPPORTED_PENDING_MIME_TYPES: SupportedImageMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/**
 * Take an uploaded screenshot of pending transactions, run it through
 * Claude vision, and replace the `pending_transactions` table with the
 * extracted rows. Returns the new summary on success, or a string error
 * for the toast to display. Never throws — anything that goes wrong is
 * caught and surfaced through the result type so the client doesn't have
 * to reach into Next's error boundary.
 *
 * Cost reminder: each successful call burns ~1–2 cents of API budget.
 */
export async function updatePending(
  formData: FormData,
): Promise<UpdatePendingResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file uploaded." };
  }
  const mimeType = file.type as SupportedImageMimeType;
  if (!SUPPORTED_PENDING_MIME_TYPES.includes(mimeType)) {
    return {
      ok: false,
      error: `Unsupported image type "${file.type}". Use PNG, JPEG, WebP, or GIF.`,
    };
  }

  const arrayBuffer = await file.arrayBuffer();
  const imageBytes = Buffer.from(arrayBuffer);

  try {
    const rows = await extractPendingFromImage(imageBytes, mimeType);
    replacePending(rows);
    const summary = getPendingSummary();
    revalidatePath("/");
    revalidatePath("/fortnight");
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// PayPal CSV import
// ---------------------------------------------------------------------------

export type ImportPaypalResult =
  | { ok: true; summary: PaypalImportSummary }
  | { ok: false; error: string };

/**
 * Parse a PayPal "Completed Payments" CSV, replace the
 * `paypal_transactions` table, match against bank rows, then re-run the
 * recurring detector so newly-enriched subscriptions get clustered. Every
 * step that touches user-facing data is revalidated at the end.
 *
 * Errors come back through the result object — the upload modal renders
 * them in-place rather than throwing through Next's error boundary.
 */
export async function importPaypal(
  formData: FormData,
): Promise<ImportPaypalResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file uploaded." };
  }
  if (!/\.csv$/i.test(file.name)) {
    return {
      ok: false,
      error: `Expected a .csv file, got "${file.name}". Make sure you downloaded "Completed Payments" as CSV.`,
    };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const records = parsePaypalCsv(buffer);
    if (records.length === 0) {
      return {
        ok: false,
        error: "The CSV parsed cleanly but contained no payment rows.",
      };
    }

    const totalImported = importPaypalCsv(records);
    const { matched, ambiguous, unmatched } = matchPaypalToBank();
    recategoriseEnrichedTransactions();
    // Re-run the detector so PayPal-paid subscriptions get clustered now
    // that their bank rows share a stable enriched name. Detector is
    // cheap (scans the transactions table once) — worth doing inline so
    // the result summary reflects the post-detection state.
    detectRecurring();

    revalidatePath("/");
    revalidatePath("/forecast");
    revalidatePath("/fortnight");
    revalidatePath("/retrospective");

    const summary: PaypalImportSummary = {
      totalParsed: records.length,
      totalImported,
      matched,
      ambiguous,
      unmatched,
    };
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
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

// ---------------------------------------------------------------------------
// What-if scenario forecast
// ---------------------------------------------------------------------------

const WHAT_IF_ACCOUNT_ID = "csv:st-george:personal";

export type ScenarioForecastResult =
  | { ok: true; result: ForecastResult }
  | { ok: false; error: string };

/** Allowed horizon values — anything else gets clamped to the default. */
const ALLOWED_HORIZONS = [4, 7, 13, 26] as const;
const DEFAULT_HORIZON = 4;

/**
 * Recompute the balance forecast with a scenario applied. Loads the same
 * sources the baseline forecast uses, runs them through `applyScenario`,
 * then hands the transformed sources to `forecastBalance`.
 *
 * `horizon` is the number of cycles to project (4 / 7 / 13 / 26). Unknown
 * values fall back to 4 to keep the action defensive against client drift.
 *
 * Errors never throw — they come back through the result object so the
 * client can show a toast and keep the existing forecast on screen.
 */
export async function computeScenarioForecast(
  scenario: Scenario,
  horizon: number = DEFAULT_HORIZON,
): Promise<ScenarioForecastResult> {
  try {
    const cycles = (ALLOWED_HORIZONS as readonly number[]).includes(horizon)
      ? horizon
      : DEFAULT_HORIZON;
    const clean = sanitiseScenario(scenario);
    const sources = loadForecastSources(WHAT_IF_ACCOUNT_ID);
    const transformed = applyScenario(sources, clean);
    const result = forecastBalance({
      accountId: WHAT_IF_ACCOUNT_ID,
      cycleAnchorDayOfWeek: 3,
      numberOfCycles: cycles,
      sources: transformed,
    });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function deleteBill(id: number): Promise<void> {
  const db = getDb();
  db.prepare(`DELETE FROM recurring_bills WHERE id = ?`).run(id);
  revalidateBillViews();
  redirect("/bills/manage");
}

// ---------------------------------------------------------------------------
// Goals — form values, validation, and CRUD server actions
// ---------------------------------------------------------------------------

export type GoalFormValues = {
  type: GoalType;
  /**
   * Savings sub-mode. Ignored (forced to 'balance') for cap types so the
   * form can carry it around safely without per-type branching.
   */
  mode: GoalMode;
  name: string;
  /** Savings: target amount. Category cap: per-cycle cap. Sub cap: per-month cap. */
  targetAmount: string;
  /** Savings only. */
  targetDate: string;
  /** Savings only. */
  accountId: string;
  /** Category cap only. */
  category: string;
  /** Subscription cap only — array of composite "manual:<id>" / "stream:<id>" keys. */
  includedBillIds: string[];
};

export type GoalFormState = {
  errors?: Partial<Record<keyof GoalFormValues, string>>;
  values?: GoalFormValues;
};

const GOAL_TYPES: GoalType[] = ["savings", "category-cap", "subscription-cap"];
const CATEGORY_CAP_OPTIONS = [
  "FOOD_AND_DRINK",
  "MEDICAL",
  "GENERAL_MERCHANDISE",
  "ENTERTAINMENT",
  "ALCOHOL",
  "PET_CARE",
];

function goalValuesFromFormData(formData: FormData): GoalFormValues {
  const typeRaw = String(formData.get("type") ?? "savings");
  const type: GoalType = (GOAL_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as GoalType)
    : "savings";
  const modeRaw = String(formData.get("mode") ?? "balance");
  const mode: GoalMode = modeRaw === "ledger" ? "ledger" : "balance";
  return {
    type,
    mode,
    name: String(formData.get("name") ?? "").trim(),
    targetAmount: String(formData.get("targetAmount") ?? "").trim(),
    targetDate: String(formData.get("targetDate") ?? "").trim(),
    accountId: String(formData.get("accountId") ?? "").trim(),
    category: String(formData.get("category") ?? "").trim(),
    // Multi-select arrives as repeated form keys — `getAll` returns them all.
    includedBillIds: formData.getAll("includedBillIds").map((v) => String(v)),
  };
}

/**
 * Validate per type. Returns either a clean `GoalInput` ready for DB write,
 * or per-field error messages so the form can highlight individual inputs.
 * Mirrors the bill-form pattern — server-side defence in depth even though
 * the form does its own client-side checks.
 */
function validateGoal(
  values: GoalFormValues,
):
  | { ok: true; data: GoalInput }
  | { ok: false; errors: Partial<Record<keyof GoalFormValues, string>> } {
  const errors: Partial<Record<keyof GoalFormValues, string>> = {};

  if (!values.name) errors.name = "Name is required.";

  const amount = Number.parseFloat(values.targetAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.targetAmount = "Target amount must be a positive number.";
  }

  const input: GoalInput = {
    type: values.type,
    // `mode` is only meaningful for savings — the module forces 'balance'
    // for cap types but we pass it through verbatim so the validation round
    // trip preserves the radio selection.
    mode: values.type === "savings" ? values.mode : "balance",
    name: values.name,
    target_amount: Number.isFinite(amount) ? amount : 0,
  };

  if (values.type === "savings") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.targetDate)) {
      errors.targetDate = "Target date is required (YYYY-MM-DD).";
    } else {
      const parsed = new Date(values.targetDate + "T00:00:00Z");
      if (isNaN(parsed.getTime())) {
        errors.targetDate = "Target date is not a valid date.";
      } else {
        input.target_date = values.targetDate;
      }
    }
    if (!values.accountId) {
      errors.accountId = "Pick an account to track this goal against.";
    } else {
      input.account_id = values.accountId;
    }
  } else if (values.type === "category-cap") {
    if (!values.category) {
      errors.category = "Pick a category.";
    } else if (!CATEGORY_CAP_OPTIONS.includes(values.category)) {
      errors.category = "Unknown category.";
    } else {
      input.category = values.category;
    }
  } else if (values.type === "subscription-cap") {
    if (values.includedBillIds.length === 0) {
      errors.includedBillIds = "Select at least one subscription.";
    } else {
      input.included_bill_ids = values.includedBillIds;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: input };
}

function revalidateGoalViews(): void {
  revalidatePath("/goals");
  revalidatePath("/balances");
}

export async function createGoalAction(
  _prev: GoalFormState,
  formData: FormData,
): Promise<GoalFormState> {
  const values = goalValuesFromFormData(formData);
  const result = validateGoal(values);
  if (!result.ok) return { errors: result.errors, values };
  createGoalRow(result.data);
  revalidateGoalViews();
  redirect("/goals");
}

export async function updateGoalAction(
  id: number,
  _prev: GoalFormState,
  formData: FormData,
): Promise<GoalFormState> {
  const values = goalValuesFromFormData(formData);
  const result = validateGoal(values);
  if (!result.ok) return { errors: result.errors, values };
  updateGoalRow(id, result.data);
  revalidateGoalViews();
  redirect("/goals");
}

export async function deleteGoalAction(id: number): Promise<void> {
  deleteGoalRow(id);
  revalidateGoalViews();
  redirect("/goals");
}

export async function archiveGoalAction(id: number): Promise<void> {
  archiveGoalRow(id);
  revalidateGoalViews();
  redirect("/goals");
}


// ---------------------------------------------------------------------------
// Goal contributions — used by ledger-mode savings goals
// ---------------------------------------------------------------------------

export type AddContributionResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Log a contribution against a ledger-mode goal. Validates amount > 0 and
 * date in YYYY-MM-DD form before writing. Returns a discriminated union so
 * the inline form can render the error in-place without throwing through
 * Next's error boundary.
 */
export async function addGoalContribution(
  goalId: number,
  formData: FormData,
): Promise<AddContributionResult> {
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const dateRaw = String(formData.get("contributionDate") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "").trim();

  const amount = Number.parseFloat(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive number." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return { ok: false, error: "Date is required (YYYY-MM-DD)." };
  }
  const parsedDate = new Date(dateRaw + "T00:00:00Z");
  if (isNaN(parsedDate.getTime())) {
    return { ok: false, error: "Date is not valid." };
  }

  try {
    addContribution(goalId, amount, dateRaw, noteRaw || null);
    revalidateGoalViews();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function deleteGoalContribution(
  contributionId: number,
): Promise<void> {
  deleteContribution(contributionId);
  revalidateGoalViews();
}

// ---------------------------------------------------------------------------
// Category rules — CRUD + bulk recategorise
// ---------------------------------------------------------------------------

export type CategoryRuleFormValues = {
  pattern: string;
  /** Empty string when `setCategory` is false (UI hides the dropdown). */
  category: string;
  subcategory: string;
  note: string;
  /**
   * Empty string means "inherit from category" — the rule won't pin
   * flow_type, and the row's flow_type stays inferred from its category.
   */
  flowType: string;
  /** "1" when the rule sets category; "0" when it sets only flow_type. */
  setCategory: string;
};

export type CategoryRuleFormState = {
  errors?: Partial<Record<keyof CategoryRuleFormValues, string>>;
  values?: CategoryRuleFormValues;
};

function categoryRuleValuesFromFormData(
  formData: FormData,
): CategoryRuleFormValues {
  return {
    pattern: String(formData.get("pattern") ?? "").trim(),
    category: String(formData.get("category") ?? "").trim(),
    subcategory: String(formData.get("subcategory") ?? "").trim(),
    note: String(formData.get("note") ?? "").trim(),
    flowType: String(formData.get("flowType") ?? "").trim(),
    // The checkbox sends "1" when checked, nothing when unchecked. The
    // form also renders a hidden "0" companion so the absent case is
    // distinguishable from a stale browser default.
    setCategory: String(formData.get("setCategory") ?? "1").trim(),
  };
}

function validateCategoryRule(values: CategoryRuleFormValues):
  | {
      ok: true;
      data: {
        pattern: string;
        category: string;
        subcategory: string | null;
        note: string | null;
        flowType: string | null;
        setCategory: number;
      };
    }
  | { ok: false; errors: Partial<Record<keyof CategoryRuleFormValues, string>> } {
  const errors: Partial<Record<keyof CategoryRuleFormValues, string>> = {};
  if (!values.pattern) errors.pattern = "Pattern is required.";

  const setCategory = values.setCategory === "1" ? 1 : 0;

  // Category only validated when the rule actually sets it. When
  // setCategory=0, the form may submit an empty category — the rule
  // becomes flow-type-only.
  if (setCategory === 1) {
    if (!values.category) {
      errors.category = "Pick a category, or uncheck 'Set category'.";
    } else if (!VALID_CATEGORY_VALUES.has(values.category)) {
      errors.category = "Unknown category.";
    }
  }

  // Flow-type-only rules need a flow type. Category-only rules can leave
  // it blank.
  if (setCategory === 0 && !values.flowType) {
    errors.flowType = "Pick a flow type, or check 'Set category' to write a category.";
  }
  if (values.flowType && !VALID_FLOW_TYPES.has(values.flowType)) {
    errors.flowType = "Unknown flow type.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // The DB column is NOT NULL on `category`, so flow-type-only rules
  // park 'OTHER' as a benign placeholder. The categoriser ignores this
  // column when set_category=0.
  const persistedCategory =
    setCategory === 1 ? values.category : "OTHER";

  return {
    ok: true,
    data: {
      pattern: values.pattern,
      category: persistedCategory,
      subcategory: setCategory === 1 ? values.subcategory || null : null,
      note: values.note || null,
      flowType: values.flowType || null,
      setCategory,
    },
  };
}

/**
 * Touch every view that surfaces categorised data, so the bulk
 * re-categorise that follows each rule write is reflected in the UI on
 * the very next navigation.
 */
function revalidateCategoryViews(): void {
  revalidatePath("/");
  revalidatePath("/forecast");
  revalidatePath("/fortnight");
  revalidatePath("/retrospective");
  revalidatePath("/what-if");
  revalidatePath("/goals");
  revalidatePath("/settings/categories");
}

export async function addCategoryRule(
  _prev: CategoryRuleFormState,
  formData: FormData,
): Promise<CategoryRuleFormState> {
  const values = categoryRuleValuesFromFormData(formData);
  const result = validateCategoryRule(values);
  if (!result.ok) return { errors: result.errors, values };

  const db = getDb();
  db.prepare(
    `INSERT INTO category_overrides
       (match_pattern, category, subcategory, note, flow_type, set_category)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    result.data.pattern,
    result.data.category,
    result.data.subcategory,
    result.data.note,
    result.data.flowType,
    result.data.setCategory,
  );

  // Apply the rule to existing rows immediately so the user sees the
  // effect rather than having to wait for the next import. Cheap — single
  // SELECT + per-row UPDATE inside one transaction.
  recategoriseAllTransactions();
  revalidateCategoryViews();
  redirect("/settings/categories");
}

export async function updateCategoryRule(
  id: number,
  _prev: CategoryRuleFormState,
  formData: FormData,
): Promise<CategoryRuleFormState> {
  const values = categoryRuleValuesFromFormData(formData);
  const result = validateCategoryRule(values);
  if (!result.ok) return { errors: result.errors, values };

  const db = getDb();
  db.prepare(
    `UPDATE category_overrides
        SET match_pattern = ?,
            category = ?,
            subcategory = ?,
            note = ?,
            flow_type = ?,
            set_category = ?
      WHERE id = ?`,
  ).run(
    result.data.pattern,
    result.data.category,
    result.data.subcategory,
    result.data.note,
    result.data.flowType,
    result.data.setCategory,
    id,
  );

  recategoriseAllTransactions();
  revalidateCategoryViews();
  redirect("/settings/categories");
}

export async function deleteCategoryRule(id: number): Promise<void> {
  const db = getDb();
  db.prepare(`DELETE FROM category_overrides WHERE id = ?`).run(id);
  recategoriseAllTransactions();
  revalidateCategoryViews();
  redirect("/settings/categories");
}

export type RecategoriseResultPayload =
  | { ok: true; scanned: number; changed: number }
  | { ok: false; error: string };

/**
 * Re-run the categoriser over every row in `transactions`. Wraps the
 * underlying call in a try/catch so the UI button can render a meaningful
 * error inline rather than throwing through Next's error boundary.
 */
export async function recategoriseEverything(): Promise<RecategoriseResultPayload> {
  try {
    const { scanned, changed } = recategoriseAllTransactions();
    revalidateCategoryViews();
    return { ok: true, scanned, changed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Per-transaction manual override (the inspector page's edit affordance)
// ---------------------------------------------------------------------------

export type TransactionOverrideResult =
  | { ok: true }
  | { ok: false; error: string };

interface OverrideInput {
  /**
   * New category. Empty string / undefined = don't change category (the
   * manual_category flag won't flip for this call).
   */
  category?: string;
  subcategory?: string;
  /**
   * New flow type. Empty string / undefined = don't change flow_type.
   */
  flowType?: string;
}

/**
 * Pin a category and/or flow_type on a single transaction. Only the
 * fields the caller actually supplies are written, and only the
 * corresponding `manual_*` flag is flipped to 1. This means editing only
 * the flow_type doesn't accidentally lock the category from future rule
 * passes too.
 *
 * Validation is permissive on category (it may be a value not in the
 * dropdown for historical rows) but strict on flow_type.
 */
export async function setTransactionOverride(
  transactionId: string,
  input: OverrideInput,
): Promise<TransactionOverrideResult> {
  try {
    const db = getDb();
    const updates: string[] = [];
    const params: (string | number)[] = [];

    if (input.flowType !== undefined && input.flowType !== "") {
      if (!VALID_FLOW_TYPES.has(input.flowType)) {
        return { ok: false, error: `Unknown flow type: ${input.flowType}` };
      }
      updates.push("flow_type = ?", "manual_flow_type = 1");
      params.push(input.flowType);
    }
    if (input.category !== undefined && input.category !== "") {
      if (!VALID_CATEGORY_VALUES.has(input.category)) {
        return { ok: false, error: `Unknown category: ${input.category}` };
      }
      updates.push("category = ?", "manual_category = 1");
      params.push(input.category);
      if (input.subcategory !== undefined) {
        updates.push("subcategory = ?");
        params.push(input.subcategory);
      }
    }

    if (updates.length === 0) {
      return { ok: false, error: "No fields to update." };
    }

    params.push(transactionId);
    const sql = `UPDATE transactions SET ${updates.join(", ")} WHERE transaction_id = ?`;
    db.prepare(sql).run(...params);

    revalidateCategoryViews();
    revalidatePath("/settings/transactions");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Clear both manual override flags and re-run the categoriser on this
 * single row so the rule layer's output wins again.
 */
export async function clearTransactionOverride(
  transactionId: string,
): Promise<TransactionOverrideResult> {
  try {
    const db = getDb();
    db.prepare(
      `UPDATE transactions
          SET manual_category = 0, manual_flow_type = 0
        WHERE transaction_id = ?`,
    ).run(transactionId);
    recategoriseTransaction(transactionId);
    revalidateCategoryViews();
    revalidatePath("/settings/transactions");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
