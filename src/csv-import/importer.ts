// ---------------------------------------------------------------------------
// CSV import orchestrator.
//
// Drives the full pipeline for one import: dispatch to the right parser,
// map rows into Ray's DB shape, and upsert atomically. Mirrors the
// structure of `src/basiq/sync.ts` so anything reading from `accounts` or
// `transactions` sees consistent rows regardless of where they came from.
// ---------------------------------------------------------------------------

import { getDb } from "../db/connection.js";
import {
  deriveAccountId,
  mapAccountRowFromConfig,
  mapInstitutionRowFromConfig,
  mapTransactionRowFromImported,
} from "./mappers.js";
import { parseStGeorge } from "./parsers/st-george.js";
import type {
  ImportConfig,
  ImportedRow,
  ImportResult,
  Parser,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a CSV import end-to-end: parse the file, map every row, and write
 * institution + account + transactions to the DB in a single atomic
 * transaction. Idempotent — re-running with the same file is safe.
 */
export async function runImport(config: ImportConfig): Promise<ImportResult> {
  const parser = pickParser(config.source);
  const rows = await parser.parse(config.filePath);

  const accountId = deriveAccountId(config);
  const db = getDb();

  // Pre-flight checks so we can report adds vs updates without inferring
  // from `ON CONFLICT DO UPDATE`'s `changes` (which doesn't distinguish).
  const accountExists = !!db
    .prepare(`SELECT 1 FROM accounts WHERE account_id = ?`)
    .get(accountId);
  const accountAdded = !accountExists;

  const upsertInstitution = db.prepare(`
    INSERT INTO institutions (item_id, access_token, name, products, cursor, logo, primary_color)
    VALUES (@item_id, @access_token, @name, @products, @cursor, @logo, @primary_color)
    ON CONFLICT(item_id) DO UPDATE SET
      access_token=excluded.access_token,
      name=excluded.name,
      products=excluded.products,
      cursor=excluded.cursor,
      logo=excluded.logo,
      primary_color=excluded.primary_color
  `);

  const upsertAccount = db.prepare(`
    INSERT INTO accounts (account_id, item_id, name, official_name, type, subtype, mask, current_balance, available_balance, balance_limit, currency, updated_at)
    VALUES (@account_id, @item_id, @name, @official_name, @type, @subtype, @mask, @current_balance, @available_balance, @balance_limit, @currency, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      name=excluded.name, official_name=excluded.official_name,
      current_balance=excluded.current_balance, available_balance=excluded.available_balance,
      balance_limit=excluded.balance_limit, updated_at=datetime('now')
  `);

  // -------------------------------------------------------------------------
  // Empty file: still create / refresh the account so the user sees it in
  // Ray's CLI, then short-circuit before transaction work.
  // -------------------------------------------------------------------------
  if (rows.length === 0) {
    const writeShell = db.transaction(() => {
      upsertInstitution.run(mapInstitutionRowFromConfig(config));
      const accountRow = mapAccountRowFromConfig(config, null);
      const { updated_at: _ignored, ...rest } = accountRow;
      void _ignored;
      upsertAccount.run(rest);
    });
    writeShell();

    logSummary(config, accountAdded, 0, 0, null);
    return {
      accountId,
      accountAdded,
      transactionsAdded: 0,
      transactionsUpdated: 0,
      dateRange: null,
    };
  }

  // -------------------------------------------------------------------------
  // Compute snapshot fields the row writes depend on.
  // -------------------------------------------------------------------------
  const currentBalance = computeCurrentBalance(rows);
  const dateRange = computeDateRange(rows);
  const transactionRows = rows.map((row) =>
    mapTransactionRowFromImported(row, accountId, config.currency),
  );
  const transactionIds = transactionRows.map((r) => r.transaction_id);
  const existingTransactionIds = selectExistingTransactionIds(db, transactionIds);

  const upsertTransaction = db.prepare(`
    INSERT INTO transactions (transaction_id, account_id, amount, date, name, merchant_name, category, subcategory, pending, iso_currency_code, payment_channel, logo_url, website)
    VALUES (@transaction_id, @account_id, @amount, @date, @name, @merchant_name, @category, @subcategory, @pending, @iso_currency_code, @payment_channel, @logo_url, @website)
    ON CONFLICT(transaction_id) DO UPDATE SET
      amount=excluded.amount, date=excluded.date, name=excluded.name,
      merchant_name=excluded.merchant_name, category=excluded.category,
      subcategory=excluded.subcategory, pending=excluded.pending,
      payment_channel=excluded.payment_channel, logo_url=excluded.logo_url,
      website=excluded.website
  `);

  // -------------------------------------------------------------------------
  // Single atomic write: institution → account → all transactions.
  // -------------------------------------------------------------------------
  const writeAll = db.transaction(() => {
    upsertInstitution.run(mapInstitutionRowFromConfig(config));

    const accountRow = mapAccountRowFromConfig(config, currentBalance);
    // Prepared statement uses datetime('now') for updated_at, so the SQL
    // doesn't reference @updated_at — strip it from the named-param set.
    const { updated_at: _ignored, ...accountRest } = accountRow;
    void _ignored;
    upsertAccount.run(accountRest);

    for (const row of transactionRows) {
      // label/note are user-editable; the SQL doesn't reference them so
      // we drop them from the param set to keep names aligned.
      const { label: _l, note: _n, ...rest } = row;
      void _l;
      void _n;
      upsertTransaction.run(rest);
    }
  });
  writeAll();

  const transactionsAdded = transactionIds.filter(
    (id) => !existingTransactionIds.has(id),
  ).length;
  const transactionsUpdated = transactionIds.length - transactionsAdded;

  logSummary(config, accountAdded, transactionsAdded, transactionsUpdated, dateRange);

  return {
    accountId,
    accountAdded,
    transactionsAdded,
    transactionsUpdated,
    dateRange,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function pickParser(source: ImportConfig["source"]): Parser {
  switch (source) {
    case "st-george":
      return parseStGeorge;
    case "accesspay":
      throw new Error("AccessPay parser not implemented yet");
    default: {
      // Exhaustive check — if a new ImportSource is added, this surfaces it.
      const _exhaustive: never = source;
      throw new Error(`Unknown CSV source: ${_exhaustive as string}`);
    }
  }
}

/**
 * Take the balance from the chronologically latest row. When multiple
 * rows share the latest date, the last one in file order wins (CSV exports
 * are typically ordered chronologically, so this is the freshest snapshot).
 * Returns `null` when the latest row's balance is missing.
 */
function computeCurrentBalance(rows: ImportedRow[]): number | null {
  let latestDate = "";
  let balance: number | null = null;
  for (const row of rows) {
    if (row.date >= latestDate) {
      latestDate = row.date;
      balance = row.balance;
    }
  }
  return balance;
}

function computeDateRange(
  rows: ImportedRow[],
): { earliest: string; latest: string } {
  let earliest = rows[0].date;
  let latest = rows[0].date;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i].date;
    if (d < earliest) earliest = d;
    if (d > latest) latest = d;
  }
  return { earliest, latest };
}

/**
 * Pre-fetch the set of transaction IDs that already exist, so we can
 * report adds vs updates after the upsert. `ON CONFLICT DO UPDATE`
 * conflates the two in `changes`.
 */
function selectExistingTransactionIds(
  db: ReturnType<typeof getDb>,
  ids: string[],
): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT transaction_id AS id FROM transactions WHERE transaction_id IN (${placeholders})`,
    )
    .all(...ids) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

function logSummary(
  config: ImportConfig,
  accountAdded: boolean,
  added: number,
  updated: number,
  dateRange: { earliest: string; latest: string } | null,
): void {
  const accountAddedFlag = accountAdded ? 1 : 0;
  const accountUpdatedFlag = accountAdded ? 0 : 1;
  const range = dateRange
    ? `${dateRange.earliest}..${dateRange.latest}`
    : "(no rows)";
  console.log(
    `[csv-import] ${config.source}/${config.accountName}: accounts=+${accountAddedFlag}/~${accountUpdatedFlag} transactions=+${added}/~${updated} dateRange=${range}`,
  );
}
