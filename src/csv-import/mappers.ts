// ---------------------------------------------------------------------------
// Pure mapping functions: parsed CSV rows → Ray DB row shapes.
//
// We reuse the row interfaces from `src/basiq/mappers.ts` so that anything
// reading from the DB sees a consistent shape regardless of whether the
// data came from Basiq or a CSV import. All side-effect-free; database I/O
// lives in the importer orchestrator.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import {
  categoriseWithRules,
  DEFAULT_CATEGORY,
  inferFlowType,
  type CategoryOverride,
} from "./categoriser.js";
import type {
  AccountRow,
  InstitutionRow,
  TransactionRow,
} from "../basiq/mappers.js";
import type { ImportConfig, ImportedRow } from "./types.js";

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic account identifier of the form
 * `csv:<bank-slug>:<account-slug>`.
 *
 * The same `(bankName, accountName)` pair always produces the same ID, so
 * re-importing a CSV updates the existing account row instead of creating
 * a new one. Callers must keep these inputs stable; renaming the account
 * in the importer config rebases its identity.
 */
export function deriveAccountId(config: ImportConfig): string {
  const bank = slug(config.bankName);
  const account = slug(config.accountName);
  return `csv:${bank}:${account}`;
}

/**
 * Build a stable transaction identifier from the row's content. We hash
 * `accountId|date|amount|balance` so a row's identity is fixed by the
 * bank's own statement: the same row from the same statement always
 * hashes the same way, regardless of how its description is later
 * rewritten.
 *
 * Choice of `balance` over `description`: aliases mutate `description`
 * over time (a merchant rename in the alias map rewrites every prior
 * row's display name), which previously caused alias edits to orphan
 * every affected row — the new ID didn't match the old one and `ON
 * CONFLICT DO UPDATE` saw a new insert instead of an update. `balance`
 * is the bank's post-transaction running balance: stable per row across
 * re-imports, never touched by Ray.
 *
 * Known limitations:
 *  - **Null balance.** Some sources may omit the running balance. The
 *    `NULL` fallback in `balanceForHash` collapses two same-day,
 *    same-amount rows with no balance into a single ID. Both currently
 *    supported parsers (St George CSV, AccessPay PDF) always populate
 *    `balance`, so this is a theoretical risk only — flagged for the
 *    next source that might not.
 *  - **Retroactive balance correction.** If the bank reissues a
 *    statement with the running balance recomputed (e.g. after a
 *    back-dated chargeback), every subsequent row's hash changes and
 *    re-importing that CSV creates a duplicate set of rows. Rare in
 *    practice and accepted as the trade-off for alias-edit safety.
 *
 * Truncation to 32 hex chars (~128 bits) is plenty of entropy for a
 * single user's transaction history.
 */
export function deriveTransactionId(
  accountId: string,
  row: ImportedRow,
): string {
  const input = `${accountId}|${row.date}|${row.amount.toFixed(2)}|${balanceForHash(row.balance)}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/**
 * Format `balance` for inclusion in the transaction-id hash. `null` is
 * encoded as the literal `"NULL"` so the hash input remains a stable
 * string. See the collision note on `deriveTransactionId` — this is the
 * source of the null-balance limitation called out there.
 */
function balanceForHash(balance: number | null): string {
  if (balance === null) return "NULL";
  return balance.toFixed(2);
}

// ---------------------------------------------------------------------------
// Institution
// ---------------------------------------------------------------------------

/**
 * Build an `institutions` row for a CSV import. We treat every CSV import
 * as its own institution row keyed by `accountId`, since each CSV
 * represents exactly one account and there's no separate "bank-level"
 * connection to track (unlike Basiq).
 */
export function mapInstitutionRowFromConfig(
  config: ImportConfig,
): InstitutionRow {
  return {
    item_id: deriveAccountId(config),
    // Preserve the origin so we can tell at a glance that this row came
    // from a CSV — and which bank's CSV — without joining elsewhere.
    access_token: `csv:${slug(config.bankName)}`,
    name: config.bankName,
    // Only `transactions` is meaningful for CSV imports — there's no
    // balance API and no real-time refresh.
    products: JSON.stringify(["transactions"]),
    // CSV imports re-import the whole file every time; cursor-based
    // incremental sync doesn't apply.
    cursor: null,
    logo: null,
    primary_color: null,
  };
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * Build an `accounts` row for a CSV import. `currentBalance` is the
 * orchestrator's call — typically the `balance` of the most recent row in
 * the file, since CSVs are point-in-time snapshots. Pass `null` if the
 * file didn't carry a balance column or all values were missing.
 */
export function mapAccountRowFromConfig(
  config: ImportConfig,
  currentBalance: number | null,
): AccountRow {
  const accountId = deriveAccountId(config);
  return {
    account_id: accountId,
    // One-to-one — the institution row IS the account row for CSVs.
    item_id: accountId,
    name: config.accountName,
    official_name: null,
    type: config.accountType,
    subtype: config.accountSubtype,
    mask: null,
    current_balance: currentBalance,
    available_balance: currentBalance,
    balance_limit: null,
    currency: config.currency,
    hidden: 0,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/**
 * Build a `transactions` row from a parsed CSV row.
 *
 * Sign: `row.amount` is already in Plaid convention (positive = money
 * out) — the parser handles any source-specific flip, so we copy through.
 *
 * Category: derived from the description via the AU rule table. If no
 * rule matches we fall back to `DEFAULT_CATEGORY`. The transfer-direction
 * flip mirrors the Basiq mapper: a `TRANSFER_OUT` default on a money-in
 * row (negative amount in Plaid convention) flips to `TRANSFER_IN`.
 */
export function mapTransactionRowFromImported(
  row: ImportedRow,
  accountId: string,
  currency: string,
  /**
   * User-defined override rules. The caller (`importer.ts`) loads these
   * once per import and passes them through so the per-row hot path
   * doesn't re-query.
   */
  rules: CategoryOverride[] = [],
): TransactionRow {
  // Pass both the alias-applied description (post `DESCRIPTION_ALIASES`
  // in the parser) and the raw bank descriptor through to the categoriser
  // so override rules can match against either form — see the comment
  // block on `categoriseWithRules` for why.
  //
  // The categoriser now also handles the sign-flip internally (TRANSFER_OUT
  // with amount < 0 → TRANSFER_IN), so we don't need to repeat the
  // post-process flip the original mapper had. flowType comes back
  // already inferred from the final category.
  const matched = categoriseWithRules(
    row.description,
    row.raw_description,
    rules,
    row.amount,
  );
  const category = matched?.category ?? DEFAULT_CATEGORY.category;
  const subcategory = matched?.subcategory ?? DEFAULT_CATEGORY.subcategory;
  const flowType =
    matched?.flowType ?? inferFlowType(category, row.amount);

  return {
    transaction_id: deriveTransactionId(accountId, row),
    account_id: accountId,
    amount: row.amount,
    date: row.date,
    name: row.description,
    // Persist the pre-alias descriptor so we can re-derive the display
    // name from a future alias map without touching transaction identity.
    raw_name: row.raw_description,
    merchant_name: null,
    category,
    subcategory,
    pending: 0,
    iso_currency_code: currency,
    payment_channel: "other",
    logo_url: null,
    website: null,
    label: null,
    note: null,
    flow_type: flowType,
    manual_category: 0,
    manual_flow_type: 0,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lowercase, collapse non-alphanumeric runs to single hyphens, trim
 * leading/trailing hyphens. Used for both bank and account name slugging.
 */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
