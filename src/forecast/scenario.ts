// ---------------------------------------------------------------------------
// What-if scenario engine.
//
// Transforms a snapshot of forecast source rows by applying a `Scenario`:
//   - drop any rows the user has toggled off
//   - override the `last_amount` (recurring) or `amount` (manual) for rows
//     the user has edited
//   - append synthesised manual-bill rows for hypothetical additions
//
// Pure: takes inputs, returns outputs, never touches the DB. The caller
// loads sources via `loadForecastSources`, runs them through `applyScenario`,
// then feeds the result to `forecastBalance({ sources: ... })`.
// ---------------------------------------------------------------------------

import type {
  ForecastSources,
  ManualBillRow,
  RecurringRow,
} from "../csv-import/balance-forecast.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HypotheticalFrequency =
  | "monthly"
  | "fortnightly"
  | "weekly"
  | "bi-monthly"
  | "quarterly"
  | "yearly";

export interface HypotheticalBill {
  /** Client-generated identifier — stable across re-renders, never persisted. */
  tempId: string;
  name: string;
  amount: number;
  frequency: HypotheticalFrequency;
  /** Required for monthly cadence. */
  dayOfMonth?: number;
  /** Required for any non-monthly cadence. YYYY-MM-DD. */
  nextDueDate?: string;
}

export interface Scenario {
  disabledManualBillIds: number[];
  /** Plaid `stream_id` values toggled off — covers both inflows and outflows. */
  disabledStreamKeys: string[];
  /**
   * New amounts keyed by display key — `"manual:<id>"` or `"stream:<stream_id>"`.
   * Values must be positive; sign is implied by the row's stream type.
   */
  amountOverrides: Record<string, number>;
  hypotheticalBills: HypotheticalBill[];
}

export const EMPTY_SCENARIO: Scenario = {
  disabledManualBillIds: [],
  disabledStreamKeys: [],
  amountOverrides: {},
  hypotheticalBills: [],
};

// ---------------------------------------------------------------------------
// Key helpers — kept here so client and server agree on the spelling
// ---------------------------------------------------------------------------

export function manualKey(id: number): string {
  return `manual:${id}`;
}

export function streamKey(streamId: string): string {
  return `stream:${streamId}`;
}

// ---------------------------------------------------------------------------
// Scenario application
// ---------------------------------------------------------------------------

/**
 * Returns a new `ForecastSources` with the scenario applied. Inputs are not
 * mutated — rows are filtered or rewritten into fresh arrays so the same
 * source snapshot can be re-used for the baseline forecast alongside.
 *
 * Hypothetical bills with insufficient data for their cadence (e.g. monthly
 * but no `dayOfMonth`) are silently skipped — the page should validate
 * client-side before sending, but this is the last line of defence.
 */
export function applyScenario(
  sources: ForecastSources,
  scenario: Scenario,
): ForecastSources {
  const disabledStreams = new Set(scenario.disabledStreamKeys);
  const disabledManual = new Set(scenario.disabledManualBillIds);

  const transformedInflows = sources.inflowRows
    .filter((r) => !disabledStreams.has(r.stream_id))
    .map((r) => overrideRecurring(r, scenario));

  const transformedOutflows = sources.outflowRows
    .filter((r) => !disabledStreams.has(r.stream_id))
    .map((r) => overrideRecurring(r, scenario));

  const transformedManual = sources.manualRows
    .filter((r) => !disabledManual.has(r.id))
    .map((r) => overrideManual(r, scenario));

  // Hypotheticals get synthetic negative IDs so they can't collide with any
  // real `recurring_bills.id` (those are AUTOINCREMENT, so always > 0).
  // Negative IDs also make them easy to spot in debugging.
  const hypotheticals: ManualBillRow[] = [];
  scenario.hypotheticalBills.forEach((h, idx) => {
    const row = hypotheticalToRow(h, -(idx + 1));
    if (row) hypotheticals.push(row);
  });

  return {
    inflowRows: transformedInflows,
    outflowRows: transformedOutflows,
    manualRows: [...transformedManual, ...hypotheticals],
  };
}

function overrideRecurring(row: RecurringRow, scenario: Scenario): RecurringRow {
  const override = scenario.amountOverrides[streamKey(row.stream_id)];
  if (override === undefined) return row;
  // `forecastBalance` reads `last_amount ?? avg_amount`. Setting `last_amount`
  // is enough; leaving `avg_amount` intact preserves any debug context.
  return { ...row, last_amount: override };
}

function overrideManual(row: ManualBillRow, scenario: Scenario): ManualBillRow {
  const override = scenario.amountOverrides[manualKey(row.id)];
  if (override === undefined) return row;
  return { ...row, amount: override };
}

function hypotheticalToRow(
  h: HypotheticalBill,
  syntheticId: number,
): ManualBillRow | null {
  if (h.frequency === "monthly") {
    if (h.dayOfMonth === undefined) return null;
    return {
      id: syntheticId,
      name: h.name,
      amount: h.amount,
      day_of_month: h.dayOfMonth,
      frequency: "monthly",
      next_due_date: null,
      last_paid_date: null,
    };
  }
  if (!h.nextDueDate) return null;
  return {
    id: syntheticId,
    name: h.name,
    amount: h.amount,
    day_of_month: null,
    frequency: h.frequency,
    next_due_date: h.nextDueDate,
    last_paid_date: null,
  };
}

// ---------------------------------------------------------------------------
// Scenario validation
// ---------------------------------------------------------------------------

/**
 * Best-effort guard against client-side payload tampering. Returns the same
 * scenario shape with anything obviously malformed dropped. Treats unknown
 * fields permissively — added fields silently shrink to the known shape.
 */
export function sanitiseScenario(input: unknown): Scenario {
  if (typeof input !== "object" || input === null) return EMPTY_SCENARIO;
  const s = input as Record<string, unknown>;

  const disabledManualBillIds = Array.isArray(s.disabledManualBillIds)
    ? s.disabledManualBillIds.filter((x): x is number => typeof x === "number")
    : [];

  const disabledStreamKeys = Array.isArray(s.disabledStreamKeys)
    ? s.disabledStreamKeys.filter((x): x is string => typeof x === "string")
    : [];

  const amountOverrides: Record<string, number> = {};
  if (typeof s.amountOverrides === "object" && s.amountOverrides !== null) {
    for (const [k, v] of Object.entries(s.amountOverrides as object)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        amountOverrides[k] = v;
      }
    }
  }

  const hypotheticalBills: HypotheticalBill[] = [];
  if (Array.isArray(s.hypotheticalBills)) {
    for (const raw of s.hypotheticalBills) {
      const cleaned = sanitiseHypothetical(raw);
      if (cleaned) hypotheticalBills.push(cleaned);
    }
  }

  return {
    disabledManualBillIds,
    disabledStreamKeys,
    amountOverrides,
    hypotheticalBills,
  };
}

function sanitiseHypothetical(input: unknown): HypotheticalBill | null {
  if (typeof input !== "object" || input === null) return null;
  const h = input as Record<string, unknown>;
  if (
    typeof h.tempId !== "string" ||
    typeof h.name !== "string" ||
    h.name.trim() === "" ||
    typeof h.amount !== "number" ||
    !Number.isFinite(h.amount) ||
    h.amount <= 0
  ) {
    return null;
  }
  const freq = h.frequency;
  if (
    freq !== "monthly" &&
    freq !== "fortnightly" &&
    freq !== "weekly" &&
    freq !== "bi-monthly" &&
    freq !== "quarterly" &&
    freq !== "yearly"
  ) {
    return null;
  }
  return {
    tempId: h.tempId,
    name: h.name.trim(),
    amount: h.amount,
    frequency: freq,
    dayOfMonth: typeof h.dayOfMonth === "number" ? h.dayOfMonth : undefined,
    nextDueDate: typeof h.nextDueDate === "string" ? h.nextDueDate : undefined,
  };
}
