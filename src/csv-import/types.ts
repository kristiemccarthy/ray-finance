// ---------------------------------------------------------------------------
// Shared types for the CSV importer.
//
// Used when Basiq isn't available for a bank, or for backfilling historical
// data the user has exported from internet banking. Each supported source
// (St George, Accesspay, etc.) provides a `Parser` that turns a file into a
// list of `ImportedRow` objects, then the importer maps those into Ray's
// existing `accounts` / `transactions` tables.
// ---------------------------------------------------------------------------

/**
 * Parser output — the intermediate shape we normalise every CSV format
 * down to before mapping into Ray's DB rows.
 *
 * **Sign convention:** `amount` is already in Plaid/Ray convention
 * (positive = money out, negative = money in). Each parser is responsible
 * for whatever flip or composition (e.g. separate Debit/Credit columns)
 * its source format requires, so downstream code never has to think about
 * provider-specific sign rules.
 */
export interface ImportedRow {
  /** Transaction date in ISO `YYYY-MM-DD` format. */
  date: string;
  /** Raw description as it appeared in the source file. */
  description: string;
  /**
   * Amount in Plaid convention: positive = out, negative = in.
   * Parsers must convert from their source's convention before populating.
   */
  amount: number;
  /** Running balance from the source row, or `null` if unavailable. */
  balance: number | null;
}

/**
 * Supported CSV source formats. Add a new value here when wiring up a new
 * bank's parser.
 */
export type ImportSource = "st-george" | "accesspay";

/**
 * Per-import configuration. Most of these fields are user-supplied (via
 * the CLI / UI) because CSVs don't carry account metadata themselves.
 */
export interface ImportConfig {
  /** Which parser to dispatch to. */
  source: ImportSource;
  /** Display name of the institution, e.g. `"St George"`. */
  bankName: string;
  /** User's nickname for the account, e.g. `"Joint Cheque"`. */
  accountName: string;
  /** Ray account type — one of `"depository" | "credit" | "loan" | "investment" | "other"`. */
  accountType: string;
  /** Finer-grained subtype, e.g. `"checking"`, `"savings"`, `"credit-card"`. */
  accountSubtype: string;
  /** ISO 4217 currency code. Defaults to `"AUD"` at the call site. */
  currency: string;
  /** Absolute path to the source file. */
  filePath: string;
}

/**
 * Outcome of a single import run, returned to the caller for logging /
 * UI feedback. `dateRange` is `null` when the file contained no rows.
 */
export interface ImportResult {
  /** Synthesised stable identifier used as `accounts.account_id`. */
  accountId: string;
  /** `true` if this run created the account row; `false` if it was updated. */
  accountAdded: boolean;
  /** Number of transactions inserted for the first time. */
  transactionsAdded: number;
  /** Number of pre-existing transactions that were updated. */
  transactionsUpdated: number;
  /** Date span covered by the imported rows, or `null` if none. */
  dateRange: { earliest: string; latest: string } | null;
}

/**
 * Bank-specific parser contract. Implementations live in sibling files
 * (e.g. `parsers/st-george.ts`) and are dispatched on `ImportConfig.source`.
 */
export interface Parser {
  parse(filePath: string): Promise<ImportedRow[]>;
}
