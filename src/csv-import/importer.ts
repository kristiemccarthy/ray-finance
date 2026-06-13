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
import { loadCategoryOverrides } from "./categoriser.js";
import { parseAccessPay } from "./parsers/accesspay.js";
import { parseStGeorge } from "./parsers/st-george.js";
import {
  detectRecurring,
  type RecurringDetectionResult,
} from "./recurring-detector.js";
import type {
  ImportConfig,
  ImportedRow,
  ImportResult,
  IntraDayOrder,
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
      type=excluded.type,
      subtype=excluded.subtype,
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
  const currentBalance = computeCurrentBalance(rows, config.intraDayOrder);
  const dateRange = computeDateRange(rows);
  // Load category-override rules once per import so the per-row hot path
  // doesn't re-query.
  const categoryRules = loadCategoryOverrides();
  // Assign each row a 1-based ordinal: the count of earlier rows in this
  // file sharing the same (date, amount, raw_description). Parsers preserve
  // source file order, and a given day's rows are fully present in any
  // statement covering that day, so the Nth occurrence of a key is stable
  // across re-imports and overlapping exports. This is what feeds
  // `deriveTransactionId` in place of the (drift-prone) running balance.
  const ordinalCounts = new Map<string, number>();
  const transactionRows = rows.map((row) => {
    const key = `${row.date}|${row.amount.toFixed(2)}|${row.raw_description}`;
    const ordinal = (ordinalCounts.get(key) ?? 0) + 1;
    ordinalCounts.set(key, ordinal);
    return mapTransactionRowFromImported(
      row,
      accountId,
      config.currency,
      categoryRules,
      ordinal,
    );
  });
  const transactionIds = transactionRows.map((r) => r.transaction_id);
  const existingTransactionIds = selectExistingTransactionIds(db, transactionIds);

  // UPSERT preservation logic (read carefully — there are three layers
  // of "don't clobber" guards stacked here):
  //
  //   - category / subcategory: pinned when the user has manually
  //     overridden them (manual_category=1) OR when PayPal enrichment
  //     resolved a real merchant name (enriched_name set, the row's
  //     category was last computed from that name and the bank
  //     descriptor doesn't know who the merchant is).
  //   - flow_type: pinned when manual_flow_type=1.
  //   - manual_category / manual_flow_type: not in UPDATE SET, so they
  //     survive re-imports verbatim.
  //
  // Rows without overrides fall through to the freshly-derived CSV values
  // as before. New rows (INSERT path) take all values from the importer
  // directly.
  //
  // NOTE: keep SQL comments inside this template literal as /* ... */ form
  // only. A `-- comment` here is parsed by TypeScript as the `--` decrement
  // operator before the runtime ever sees the string, which breaks compile.
  const upsertTransaction = db.prepare(`
    INSERT INTO transactions (transaction_id, account_id, amount, date, name, raw_name, merchant_name, category, subcategory, pending, iso_currency_code, payment_channel, logo_url, website, flow_type, manual_category, manual_flow_type)
    VALUES (@transaction_id, @account_id, @amount, @date, @name, @raw_name, @merchant_name, @category, @subcategory, @pending, @iso_currency_code, @payment_channel, @logo_url, @website, @flow_type, @manual_category, @manual_flow_type)
    ON CONFLICT(transaction_id) DO UPDATE SET
      amount=excluded.amount, date=excluded.date, name=excluded.name,
      raw_name=excluded.raw_name,
      merchant_name=excluded.merchant_name,
      category = CASE
        WHEN transactions.manual_category = 1 THEN transactions.category
        WHEN transactions.enriched_name IS NULL THEN excluded.category
        ELSE transactions.category
      END,
      subcategory = CASE
        WHEN transactions.manual_category = 1 THEN transactions.subcategory
        WHEN transactions.enriched_name IS NULL THEN excluded.subcategory
        ELSE transactions.subcategory
      END,
      flow_type = CASE
        WHEN transactions.manual_flow_type = 1 THEN transactions.flow_type
        ELSE excluded.flow_type
      END,
      pending=excluded.pending,
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

  // Re-run recurring detection across the whole `transactions` table now
  // that the new rows have landed. Logged but not returned, so the public
  // ImportResult shape stays stable.
  const recurringResult = detectRecurring();
  logRecurring(recurringResult);

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
      return parseAccessPay;
    default: {
      // Exhaustive check — if a new ImportSource is added, this surfaces it.
      const _exhaustive: never = source;
      throw new Error(`Unknown CSV source: ${_exhaustive as string}`);
    }
  }
}

/**
 * Pick the balance from the chronologically-latest row in the import
 * batch. Same-date ties are resolved using the source's `intraDayOrder`
 * convention:
 *   - `newest-first`: the first row at the latest date is the chronological
 *     winner (St George CSV exports newest-first within each date).
 *   - `oldest-first`: the last row at the latest date is the chronological
 *     winner (AccessPay PDF prints oldest-first, with the day's closing
 *     balance at the bottom).
 * Returns `null` when the chosen row's balance is missing.
 */
function computeCurrentBalance(
  rows: ImportedRow[],
  intraDayOrder: IntraDayOrder,
): number | null {
  let latestDate = "";
  let balance: number | null = null;
  for (const row of rows) {
    const shouldUpdate =
      intraDayOrder === "newest-first"
        ? row.date > latestDate   // first row at a new latest date wins; later same-date rows ignored
        : row.date >= latestDate; // last row at the latest date wins; keep overwriting on tie
    if (shouldUpdate) {
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

function logRecurring(result: RecurringDetectionResult): void {
  const breakdown = Object.entries(result.byFrequency)
    .sort((a, b) => b[1] - a[1])
    .map(([freq, n]) => `${n} ${freq.toLowerCase()}`)
    .join(", ");
  const tail = breakdown ? ` (${breakdown})` : "";
  console.log(
    `[recurring] detected ${result.streamsDetected} streams${tail}`,
  );
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
