// ---------------------------------------------------------------------------
// Bulk + per-row re-categorisation pass.
//
// Walks every row in `transactions`, runs the rule-aware categoriser, and
// updates rows whose category / subcategory / flow_type would change under
// the current rule set. Used in three places:
//
//   1. After any mutation to `category_overrides` (add/edit/delete) — keeps
//      historical rows in sync with the user's latest intent.
//   2. From the Settings → "Recategorise everything" button — explicit
//      manual re-pass.
//   3. From the transaction inspector's "Reset to automatic" affordance —
//      a single-row variant via `recategoriseTransaction`.
//
// Behaviour:
//   - Reads `COALESCE(enriched_name, name)` AND `raw_name` so PayPal-
//     enriched rows pick up rules against their real merchant name AND
//     user-authored patterns can target the bank's original descriptor.
//   - Respects `manual_category` and `manual_flow_type`: rows where the
//     user has pinned a value are left alone for that field.
//   - Leaves rows alone where the categoriser returns `null` (nothing
//     matched). Blanking to DEFAULT_CATEGORY would be lossy.
//   - Wrapped in a single DB transaction so a partial failure doesn't
//     leave the table half-updated.
// ---------------------------------------------------------------------------

import type Database from "libsql";
import { getDb } from "../db/connection.js";
import {
  categoriseWithRules,
  inferFlowType,
  loadCategoryOverrides,
  type CategoryOverride,
  type FlowType,
} from "./categoriser.js";

export interface RecategoriseResult {
  /** Rows examined. */
  scanned: number;
  /** Rows whose category or subcategory changed. */
  categoriesChanged: number;
  /** Rows whose flow_type changed. */
  flowTypesChanged: number;
  /**
   * Rows where at least one of category/subcategory/flow_type changed.
   * Always ≤ categoriesChanged + flowTypesChanged (a single row can
   * contribute to both counts but only once here).
   */
  changed: number;
}

interface TransactionRow {
  transaction_id: string;
  name: string;
  raw_name: string | null;
  amount: number;
  category: string | null;
  subcategory: string | null;
  flow_type: string | null;
  manual_category: number;
  manual_flow_type: number;
}

/**
 * Bulk pass over every row in `transactions`. Optional `db` lets callers
 * inside `migrate()` thread their own connection through without
 * recursing back into `getDb()`.
 */
export function recategoriseAllTransactions(
  dbOverride?: Database.Database,
): RecategoriseResult {
  const db = dbOverride ?? getDb();
  const rules = loadCategoryOverrides(db);

  const rows = db
    .prepare(
      `SELECT transaction_id,
              COALESCE(enriched_name, name) AS name,
              raw_name,
              amount,
              category,
              subcategory,
              flow_type,
              manual_category,
              manual_flow_type
         FROM transactions`,
    )
    .all() as TransactionRow[];

  const update = db.prepare(
    `UPDATE transactions
        SET category = ?, subcategory = ?, flow_type = ?
      WHERE transaction_id = ?`,
  );

  let categoriesChanged = 0;
  let flowTypesChanged = 0;
  let changed = 0;

  const write = db.transaction(() => {
    for (const r of rows) {
      const next = nextValuesFor(r, rules);
      if (!next) continue;
      const catChanged =
        next.category !== r.category ||
        (next.subcategory ?? null) !== (r.subcategory ?? null);
      const flowChanged = next.flowType !== r.flow_type;
      if (!catChanged && !flowChanged) continue;
      update.run(
        next.category,
        next.subcategory ?? null,
        next.flowType,
        r.transaction_id,
      );
      if (catChanged) categoriesChanged++;
      if (flowChanged) flowTypesChanged++;
      changed++;
    }
  });
  write();

  return { scanned: rows.length, categoriesChanged, flowTypesChanged, changed };
}

/**
 * Single-row variant for the inspector's "Reset to automatic" button.
 * Called after the manual flags have been cleared so the same logic
 * (rules → inference) gets to write the row's fields without being
 * blocked by `manual_*` guards.
 */
export function recategoriseTransaction(
  transactionId: string,
  dbOverride?: Database.Database,
): boolean {
  const db = dbOverride ?? getDb();
  const rules = loadCategoryOverrides(db);

  const row = db
    .prepare(
      `SELECT transaction_id,
              COALESCE(enriched_name, name) AS name,
              raw_name,
              amount,
              category,
              subcategory,
              flow_type,
              manual_category,
              manual_flow_type
         FROM transactions
        WHERE transaction_id = ?`,
    )
    .get(transactionId) as TransactionRow | undefined;
  if (!row) return false;

  const next = nextValuesFor(row, rules);
  if (!next) return false;
  db.prepare(
    `UPDATE transactions
        SET category = ?, subcategory = ?, flow_type = ?
      WHERE transaction_id = ?`,
  ).run(
    next.category,
    next.subcategory ?? null,
    next.flowType,
    transactionId,
  );
  return true;
}

/**
 * Compute the row's target category/subcategory/flow_type, honouring the
 * manual override flags. Returns null when nothing changes — saves one
 * UPDATE per untouched row.
 *
 * The two manual flags are independent: a user can pin flow_type without
 * pinning category, and vice versa. Pinned fields fall back to the row's
 * current stored value; un-pinned fields take the categoriser's output.
 */
function nextValuesFor(
  row: TransactionRow,
  rules: CategoryOverride[],
): { category: string; subcategory: string; flowType: FlowType } | null {
  const matched = categoriseWithRules(row.name, row.raw_name, rules, row.amount);
  // Fall back to inferring flow_type from the existing category if the
  // categoriser punted entirely — keeps manual-only rows (no match in
  // either layer) coherent.
  const inferredFallback: FlowType = inferFlowType(row.category, row.amount);

  // Field-by-field: stored value if manual flag set, otherwise the
  // categoriser's output (or fallback for misses).
  const category = row.manual_category
    ? row.category ?? matched?.category ?? "OTHER"
    : matched?.category ?? row.category ?? "OTHER";

  const subcategory = row.manual_category
    ? row.subcategory ?? matched?.subcategory ?? ""
    : matched?.subcategory ?? row.subcategory ?? "";

  const flowType = row.manual_flow_type
    ? ((row.flow_type as FlowType | null) ?? matched?.flowType ?? inferredFallback)
    : matched?.flowType ?? inferredFallback;

  return { category, subcategory, flowType };
}
