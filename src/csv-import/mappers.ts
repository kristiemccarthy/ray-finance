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
 * `accountId|date|amount|ordinal|raw_description` so a row's identity is
 * fixed by fields that survive re-imports without drifting.
 *
 * Why these fields:
 *  - **`raw_description`** (not `description`): aliases mutate
 *    `description`/`name` over time — a merchant rename in the alias map
 *    rewrites every prior row's display name. Hashing the raw, pre-alias
 *    bank descriptor keeps a row's identity stable across alias edits.
 *  - **`ordinal`**: the 1-based count of earlier rows in the same file
 *    sharing this `(date, amount, raw_description)`. This is what lets two
 *    genuine same-day, same-amount, same-merchant purchases stay distinct
 *    (ordinal 1 and 2) while remaining reproducible on re-import.
 *
 * Why NOT `balance`: the bank's running balance is recomputed whenever a
 * statement is reissued (pending items settling, back-dated corrections),
 * so it drifted between exports and re-imports minted duplicate rows. The
 * `(date, amount, raw_description)` ordinal replaces it: a given day's
 * rows are fully present in any statement covering that day, so the Nth
 * occurrence of a key on a day is identical across overlapping exports.
 *
 * Field ordering keeps the single free-text field (`raw_description`)
 * trailing, so a stray `|` inside a descriptor can't create field
 * ambiguity — there are no further fields to confuse it with.
 *
 * Truncation to 32 hex chars (~128 bits) is plenty of entropy for a
 * single user's transaction history.
 */
export function deriveTransactionId(
  accountId: string,
  row: ImportedRow,
  ordinal: number,
): string {
  const input = [
    accountId,
    row.date,
    row.amount.toFixed(2),
    ordinal,
    row.raw_description,
  ].join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
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
  /**
   * 1-based count of earlier rows in the same file sharing this row's
   * `(date, amount, raw_description)`. Feeds `deriveTransactionId` so
   * genuine same-day repeat purchases get distinct, re-import-stable IDs.
   * Defaults to 1 — a lone occurrence — so existing direct callers and
   * tests that don't care about repeats keep working.
   */
  ordinal: number = 1,
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
    transaction_id: deriveTransactionId(accountId, row, ordinal),
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
