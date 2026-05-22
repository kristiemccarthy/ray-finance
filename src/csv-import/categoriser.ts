// ---------------------------------------------------------------------------
// Rule-aware categoriser.
//
// Layered over the existing PFC-rule categoriser in `src/basiq/categories.ts`:
//   1. Run the PFC-rule categoriser against the merchant name. This is the
//      baseline — covers most named merchants the bank descriptor encodes.
//   2. Walk the user's `category_overrides` rules; if any pattern is a
//      case-insensitive substring of the name, the override WINS — its
//      category/subcategory replace the PFC result.
//
// Why overrides win: PFC rules are inherited from a generic table and
// often miscategorise local/Australian merchants (e.g. "MOVE360" is
// Laura's psychiatrist but reads as generic services to the PFC
// categoriser). Overrides are the user's explicit "I know what this is"
// signal and should always beat heuristics.
//
// Rules are loaded once and passed through. Per-row DB queries would
// dominate the import-loop budget — at a few hundred transactions, that's
// fine, but at tens of thousands it isn't. One up-front SELECT, then a
// linear scan per row.
// ---------------------------------------------------------------------------

import type Database from "libsql";
import { getDb } from "../db/connection.js";
import {
  categoriseFromDescription,
  type PlaidCategory,
} from "../basiq/categories.js";

/**
 * Six-bucket cashflow taxonomy layered over the PFC category system.
 *
 * The retrospective uses these to split income from spending while
 * keeping internal transfers, family help, and refunds visible but
 * separately accounted. A row's flow_type is normally derived from its
 * category, but rules and manual overrides can pin it independently —
 * useful for descriptors like "Internet Deposit From 0000…" that have
 * the wrong category but a clear cashflow meaning.
 */
export type FlowType =
  | "EARNED_INCOME"
  | "INTERNAL_TRANSFER"
  | "EXTERNAL_GIFT"
  | "REIMBURSEMENT"
  | "SPENDING"
  | "REPAYMENT";

export interface CategoryOverride {
  id: number;
  pattern: string;
  category: string;
  subcategory: string | null;
  note: string | null;
  /** When non-null, the rule also pins flow_type. */
  flowType: FlowType | null;
  /**
   * When false, the rule only sets `flow_type` — category and subcategory
   * pass through to the PFC layer's output. Default true (existing rules
   * behave exactly as before).
   */
  setCategory: boolean;
  /** Uppercase form of pattern, cached so the per-row hot path skips it. */
  patternUpper: string;
}

/**
 * Default flow_type from category. Amount is taken for future refinement
 * (e.g. negative SPENDING rows are arguably REIMBURSEMENT), but currently
 * only the category is consulted — refunds default to SPENDING and the
 * user refines via rules or the inspector.
 */
export function inferFlowType(
  category: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _amount: number,
): FlowType {
  if (!category) return "SPENDING";
  if (category === "INCOME") return "EARNED_INCOME";
  if (category === "TRANSFER_IN" || category === "TRANSFER_OUT") return "INTERNAL_TRANSFER";
  if (category === "LOAN_PAYMENTS") return "REPAYMENT";
  return "SPENDING";
}

export interface CategorisedRow {
  category: string;
  subcategory: string;
  flowType: FlowType;
}

/**
 * Pull every category-override rule from the DB. Cheap query — there'll
 * never be thousands of these — but callers should still call this once
 * per import / re-categorisation pass rather than per row.
 *
 * Accepts an optional `db` so callers running inside `migrate()` (e.g. the
 * pet-care seed) can pass their own connection and avoid re-entering
 * `getDb()` during DB initialisation.
 */
export function loadCategoryOverrides(
  dbOverride?: Database.Database,
): CategoryOverride[] {
  const db = dbOverride ?? getDb();
  const rows = db
    .prepare(
      `SELECT id, match_pattern, category, subcategory, note,
              flow_type, set_category
         FROM category_overrides
        ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    match_pattern: string;
    category: string;
    subcategory: string | null;
    note: string | null;
    flow_type: string | null;
    set_category: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    pattern: r.match_pattern,
    category: r.category,
    subcategory: r.subcategory,
    note: r.note,
    flowType: (r.flow_type as FlowType | null) ?? null,
    setCategory: r.set_category !== 0,
    patternUpper: r.match_pattern.toUpperCase(),
  }));
}

/**
 * Layered categorisation: PFC rules give the baseline, override rules win
 * if any pattern is a case-insensitive substring of either the
 * alias-applied name OR the bank's original raw descriptor.
 *
 * Why both fields:
 *   - The PFC categoriser was tuned for the alias-applied name (e.g.
 *     "Disney+" instead of "Visa Purchase 14May Amznprime…"), so the
 *     baseline still reads `name`.
 *   - Override rules are user-authored, often against the raw bank
 *     descriptor the user actually sees in their statement. If the alias
 *     pass has rewritten the merchant to a shorter display name, the
 *     user's pattern (e.g. "PET INSURANCE CHATSWOOD") could otherwise
 *     never match. Testing `raw_name` too closes that gap.
 *
 * Returns `null` only when both layers miss — callers typically fall back
 * to `DEFAULT_CATEGORY` in that case.
 *
 * `rules` is taken by value so the caller can build it once and re-use
 * across many rows. An empty array bypasses the override layer entirely,
 * which is equivalent to calling `categoriseFromDescription` directly.
 */
/**
 * Layered categorisation, now flow-type aware.
 *
 * Returns:
 *   - `category` / `subcategory`: baseline PFC result, overridden by the
 *     first matching rule whose `setCategory` is true.
 *   - `flowType`: inferred from the final category by default, overridden
 *     by the first matching rule whose `flowType` is non-null. Note this
 *     can come from a different matching rule than the category — a rule
 *     can pin one without touching the other (`setCategory=false`).
 *
 * Returns `null` only when the baseline categoriser misses AND no rule
 * applied — same as before. Amount is consulted for the flow-type sign
 * flip on TRANSFER_OUT-with-negative-amount (mirrors the import-time
 * mapper's behaviour so the recategoriser can't regress it).
 */
export function categoriseWithRules(
  name: string | null | undefined,
  rawName: string | null | undefined,
  rules: CategoryOverride[],
  amount: number = 0,
): CategorisedRow | null {
  const baseline = categoriseFromDescription(name);

  // Start with the PFC layer's answer. Either part of this can be
  // overridden by a matching rule below.
  let category = baseline?.category ?? null;
  let subcategory = baseline?.subcategory ?? "";

  // Sign-flip: a TRANSFER_OUT row with a negative amount is actually money
  // arriving from another account. The CSV mapper does this at import
  // time; replicating it here means the recategoriser can't undo the flip.
  if (category === "TRANSFER_OUT" && amount < 0) {
    category = "TRANSFER_IN";
  }

  // Walk rules in id order. Two distinct overrides can apply: the first
  // category-setting rule wins the category slot, the first flow-type-
  // setting rule wins the flow-type slot. Order = creation order, so users
  // can layer specific rules on top of broad ones.
  let categorySet = false;
  let ruleFlowType: FlowType | null = null;

  const upperName = (name ?? "").toUpperCase();
  const upperRaw = (rawName ?? "").toUpperCase();
  if (upperName || upperRaw) {
    for (const rule of rules) {
      const matches =
        upperName.includes(rule.patternUpper) ||
        upperRaw.includes(rule.patternUpper);
      if (!matches) continue;

      if (rule.setCategory && !categorySet) {
        category = rule.category;
        subcategory = rule.subcategory ?? "";
        categorySet = true;
      }
      if (rule.flowType !== null && ruleFlowType === null) {
        ruleFlowType = rule.flowType;
      }
      // Short-circuit once both slots are filled. Saves work on long rule
      // lists, but only matters when the user has dozens of rules — the
      // categoriser is otherwise cheap.
      if (categorySet && ruleFlowType !== null) break;
    }
  }

  if (category === null) {
    // PFC miss AND no rule applied — caller decides what to do (typically
    // falls back to DEFAULT_CATEGORY).
    return null;
  }

  const flowType = ruleFlowType ?? inferFlowType(category, amount);
  return { category, subcategory, flowType };
}

// Re-export so consumers can pull one categoriser surface instead of
// reaching across the basiq boundary for the type.
export type { PlaidCategory } from "../basiq/categories.js";
export { DEFAULT_CATEGORY } from "../basiq/categories.js";
