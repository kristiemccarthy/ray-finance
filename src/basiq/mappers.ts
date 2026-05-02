// ---------------------------------------------------------------------------
// Pure mapping functions: Basiq API shapes → Ray DB row shapes.
//
// Every function here is side-effect-free. They take a Basiq response object
// (and sometimes a connectionId for back-references) and return a row that
// matches the columns Ray's SQLite schema expects. Database I/O lives in the
// sync layer, not here.
// ---------------------------------------------------------------------------

import {
  categoriseFromDescription,
  DEFAULT_CATEGORY,
  mapBasiqCategory,
  type PlaidCategory,
} from "./categories.js";
import type {
  BasiqAccount,
  BasiqAccountType,
  BasiqConnection,
  BasiqInstitution,
  BasiqTransaction,
  BasiqTransactionClass,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row shapes — match the SQLite schema columns we write into.
// ---------------------------------------------------------------------------

/**
 * Row shape for the `institutions` table.
 *
 * Notable Basiq-specific repurposing:
 * - `item_id` stores the Basiq `connectionId` (Plaid's per-item handle is
 *   the closest analogue to a Basiq connection).
 * - `access_token` ALSO stores the connectionId. Basiq doesn't issue a
 *   per-connection token — auth is handled centrally via the API key — but
 *   the column is `NOT NULL` in the existing schema. We store the
 *   connectionId here so callers that read from this column still get a
 *   useful identifier rather than an empty string. See note in
 *   `mapInstitutionRow`.
 * - `cursor` is repurposed: Plaid stored an opaque `transactionsSync`
 *   cursor here; we store an ISO `lastSyncDate` to drive Basiq's
 *   `filter=postDate.gt(...)` query.
 */
export interface InstitutionRow {
  item_id: string;
  access_token: string;
  name: string;
  products: string;
  cursor: string | null;
  logo: string | null;
  primary_color: string | null;
}

/** Row shape for the `accounts` table. */
export interface AccountRow {
  account_id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string;
  mask: string | null;
  current_balance: number | null;
  available_balance: number | null;
  balance_limit: number | null;
  currency: string;
  hidden: number;
  updated_at: string;
}

/** Row shape for the `transactions` table. */
export interface TransactionRow {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string | null;
  subcategory: string | null;
  pending: number;
  iso_currency_code: string;
  payment_channel: string | null;
  logo_url: string | null;
  website: string | null;
  label: string | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Institution
// ---------------------------------------------------------------------------

/**
 * Build an `institutions` row from a Basiq connection + the institution it
 * targets. `products` is hard-coded for now — Basiq doesn't expose a
 * Plaid-style products list per institution at this layer; we just record
 * what Ray actually consumes.
 */
export function mapInstitutionRow(
  connection: BasiqConnection,
  institution: BasiqInstitution,
): InstitutionRow {
  // `access_token` stores the connectionId rather than a separate token.
  // Basiq's auth is centralised on the API key, so there's no per-connection
  // secret to put here — and the column is NOT NULL. Storing the
  // connectionId keeps the column meaningful and avoids a schema migration.
  const accessToken = connection.id;

  // `cursor` will be populated later as an ISO `lastSyncDate` string used
  // to drive incremental transaction fetches via Basiq's
  // `filter=postDate.gt(...)` query. On initial creation it's null.
  const cursor = null;

  const name = institution.name || institution.shortName || "";

  return {
    item_id: connection.id,
    access_token: accessToken,
    name,
    products: JSON.stringify(["transactions", "accounts"]),
    cursor,
    logo: institution.logo?.links?.square ?? null,
    primary_color: null,
  };
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * Build an `accounts` row from a Basiq account, scoped to the connectionId
 * that owns it. Type/subtype are normalised to Ray's existing vocabulary
 * (`depository` / `credit` / `loan` / `investment` / `other`).
 */
export function mapAccountRow(
  account: BasiqAccount,
  connectionId: string,
): AccountRow {
  const basiqType = account.class?.type;

  return {
    account_id: account.id,
    item_id: connectionId,
    name: account.name || account.displayName || "",
    official_name: account.class?.product ?? null,
    type: deriveAccountType(basiqType),
    subtype: basiqType ?? "other",
    mask: deriveMask(account.accountNo),
    current_balance: parseFloatOrNull(account.balance),
    available_balance: parseFloatOrNull(account.availableFunds),
    balance_limit: parseFloatOrNull(account.creditLimit),
    currency: account.currency,
    hidden: 0,
    updated_at: new Date().toISOString(),
  };
}

function deriveAccountType(basiqType: BasiqAccountType | undefined): string {
  switch (basiqType) {
    case "transaction":
    case "savings":
      return "depository";
    case "credit-card":
      return "credit";
    case "mortgage":
    case "loan":
      return "loan";
    case "investment":
    case "term-deposit":
      return "investment";
    default:
      return "other";
  }
}

function deriveMask(accountNo: string | undefined | null): string | null {
  if (!accountNo) return null;
  if (accountNo.length <= 4) return accountNo;
  return accountNo.slice(-4);
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/**
 * Build a `transactions` row from a Basiq transaction.
 *
 * SIGN FLIP — critical:
 *   Basiq uses accounting sign: positive amount = credit (money in),
 *   negative = debit (money out).
 *   Plaid (and therefore Ray) uses the opposite: positive = money out,
 *   negative = money in.
 *
 * Worked example:
 *   - Basiq `amount: "-42.50"` (debit, money out) → Ray `amount: 42.50`.
 *   - Basiq `amount:  "1500"`  (credit, money in) → Ray `amount: -1500`.
 *
 * Get this wrong and every scoring/budget calculation inverts silently, so
 * the negate is concentrated here at the boundary.
 *
 * Category resolution — three-stage fallback:
 *   1. If Basiq supplied an `enrich.category`, translate it via
 *      `mapBasiqCategory`.
 *   2. Otherwise (sandbox or any other case where enrichment is empty),
 *      try to categorise from `description` via `categoriseFromDescription`.
 *   3. If neither yields anything, use `DEFAULT_CATEGORY`.
 *
 * Transfer direction:
 *   The category resolution may produce `TRANSFER_OUT` as a default for
 *   transfer-shaped transactions, because direction can't be determined
 *   from the category string alone. We resolve it here using
 *   `transaction.direction`: a `credit` (money in) flips to `TRANSFER_IN`.
 *   This applies regardless of which resolution stage produced the
 *   category.
 */
export function mapTransactionRow(transaction: BasiqTransaction): TransactionRow {
  const rayAmount = -parseFloat(transaction.amount);

  const mapped = resolveCategory(transaction);
  let category = mapped.category;
  if (category === "TRANSFER_OUT" && transaction.direction === "credit") {
    category = "TRANSFER_IN";
  }

  return {
    transaction_id: transaction.id,
    account_id: transaction.account,
    amount: rayAmount,
    date: toDateOnly(transaction.postDate),
    name: transaction.description,
    merchant_name: transaction.enrich?.merchant?.businessName ?? null,
    category,
    subcategory: mapped.subcategory,
    pending: transaction.status === "pending" ? 1 : 0,
    iso_currency_code: transaction.currency,
    payment_channel: derivePaymentChannel(transaction.class),
    logo_url: transaction.enrich?.merchant?.logoUrl ?? null,
    website: transaction.enrich?.merchant?.website ?? null,
    label: null,
    note: null,
  };
}

/**
 * Three-stage category resolution. See `mapTransactionRow`'s JSDoc for
 * the full explanation. Kept as a dedicated helper so the transfer-flip
 * logic in `mapTransactionRow` stays focused on direction handling rather
 * than source selection.
 */
function resolveCategory(transaction: BasiqTransaction): PlaidCategory {
  // Stage 1: trust Basiq's enrichment when it produced a real mapping.
  // `mapBasiqCategory` returns the singleton `DEFAULT_CATEGORY` reference
  // on miss (null/empty input or unknown category string), so reference
  // equality is enough to detect "Basiq told us nothing useful."
  const fromBasiq = mapBasiqCategory(transaction.enrich?.category);
  if (fromBasiq !== DEFAULT_CATEGORY) {
    return fromBasiq;
  }

  // Stage 2: description-based fallback for sandbox / unenriched data.
  const fromDescription = categoriseFromDescription(transaction.description);
  if (fromDescription !== null) {
    return fromDescription;
  }

  // Stage 3: nothing matched.
  return DEFAULT_CATEGORY;
}

/**
 * Rough mapping from Basiq's transaction class to Ray's `payment_channel`.
 * Basiq doesn't have a direct equivalent of Plaid's payment_channel; this
 * is a best-effort categorisation that we should revisit once we've seen
 * how real sandbox/production data distributes across these classes.
 */
function derivePaymentChannel(
  txClass: BasiqTransactionClass | undefined,
): string {
  switch (txClass) {
    case "transfer":
    case "loan-repayment":
      return "other";
    case "cash-withdrawal":
      return "in store";
    default:
      return "online";
  }
}

/**
 * Truncate an ISO 8601 / RFC 3339 timestamp to a `YYYY-MM-DD` date string.
 * Tolerates inputs that are already date-only by slicing the first 10 chars.
 */
function toDateOnly(timestamp: string): string {
  return timestamp.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Basiq string-encoded decimal (e.g. `"42.50"`) into a number, or
 * return `null` for `null`/`undefined`/empty/non-numeric inputs. Basiq uses
 * strings for monetary precision; Ray's schema stores `REAL` columns.
 */
export function parseFloatOrNull(
  value: string | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}
