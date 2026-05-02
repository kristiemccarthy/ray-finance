// ---------------------------------------------------------------------------
// Basiq sync orchestrator.
//
// Pulls accounts and transactions for a single Basiq connection and writes
// them into Ray's SQLite database, matching the row shapes the Plaid sync
// already produces. All Basiq → DB shape translation lives in `mappers.ts`;
// this file is the I/O boundary.
//
// Schema notes:
//   - `institutions.item_id` stores the Basiq connectionId (one row per
//     connection, mirroring how Plaid stored one row per item).
//   - `institutions.cursor` is repurposed as a `lastSyncDate` ISO string
//     for driving incremental transaction fetches.
//   - Transaction sign is flipped at the mapper layer (Basiq → Plaid
//     convention). See `mapTransactionRow` for the worked example.
// ---------------------------------------------------------------------------

import { getDb } from "../db/connection.js";
import type { BasiqClient } from "./client.js";
import {
  mapAccountRow,
  mapInstitutionRow,
  mapTransactionRow,
} from "./mappers.js";
import type {
  BasiqAccount,
  BasiqConnection,
  BasiqInstitution,
  BasiqListResponse,
  BasiqTransaction,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyncResult {
  /** Basiq institution this connection targets. */
  institutionId: string;
  /** Number of accounts inserted for the first time. */
  accountsAdded: number;
  /** Number of pre-existing accounts that were updated. */
  accountsUpdated: number;
  /** Number of transactions inserted for the first time. */
  transactionsAdded: number;
  /** Number of pre-existing transactions that were updated. */
  transactionsUpdated: number;
  /** ISO timestamp written into the institution's cursor for the next run. */
  lastSyncDate: string;
}

/**
 * Sync everything we know how to sync for a single Basiq connection:
 * institution metadata, accounts, and transactions. Subsequent calls only
 * fetch transactions newer than the stored cursor.
 */
export async function syncConnection(
  client: BasiqClient,
  userId: string,
  connectionId: string,
): Promise<SyncResult> {
  console.log(`[basiq] syncConnection start: connectionId=${connectionId}`);

  const connection = await client.get<BasiqConnection>(
    `/users/${userId}/connections/${connectionId}`,
  );
  const institution = await client.get<BasiqInstitution>(
    `/institutions/${connection.institution.id}`,
  );

  const db = getDb();

  // Load any existing cursor (lastSyncDate) so we can do incremental
  // transaction fetches on subsequent runs.
  const existing = db
    .prepare(`SELECT cursor FROM institutions WHERE item_id = ?`)
    .get(connectionId) as { cursor: string | null } | undefined;
  const cursor = existing?.cursor ?? null;

  // -------------------------------------------------------------------------
  // Fetch accounts (filtered to this connection in JS — the endpoint
  // returns every account across every connection for the user).
  // -------------------------------------------------------------------------
  const accountsResp = await client.get<BasiqListResponse<BasiqAccount>>(
    `/users/${userId}/accounts`,
  );
  const accounts = accountsResp.data.filter(
    (a) => a.connection === connectionId,
  );

  // -------------------------------------------------------------------------
  // Fetch transactions, paginated. Filter for this connection plus any
  // incremental cursor.
  // -------------------------------------------------------------------------
  const transactions = await fetchAllTransactions(
    client,
    userId,
    connectionId,
    cursor,
  );

  // -------------------------------------------------------------------------
  // Determine inserts-vs-updates BEFORE writing, by checking which
  // primary keys already exist. ON CONFLICT DO UPDATE conflates the two.
  // -------------------------------------------------------------------------
  const existingAccountIds = selectExistingIds(
    db,
    "accounts",
    "account_id",
    accounts.map((a) => a.id),
  );
  const existingTransactionIds = selectExistingIds(
    db,
    "transactions",
    "transaction_id",
    transactions.map((t) => t.id),
  );

  // -------------------------------------------------------------------------
  // Compute the new lastSyncDate before opening the write transaction so
  // it can be persisted alongside everything else.
  // -------------------------------------------------------------------------
  const lastSyncDate = computeLastSyncDate(transactions);

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
  // Single atomic write transaction for institution + accounts + txs.
  // -------------------------------------------------------------------------
  const institutionRow = mapInstitutionRow(connection, institution);
  // Carry the freshly computed cursor so it lands in the same write.
  institutionRow.cursor = lastSyncDate;

  const writeAll = db.transaction(() => {
    upsertInstitution.run(institutionRow);

    for (const account of accounts) {
      const row = mapAccountRow(account, connectionId);
      // The prepared statement uses datetime('now') for updated_at; strip
      // the ISO value the mapper produced so the DB-side default wins and
      // the named param set matches the SQL exactly.
      const { updated_at: _ignored, ...rest } = row;
      void _ignored;
      upsertAccount.run(rest);
    }

    for (const transaction of transactions) {
      const row = mapTransactionRow(transaction);
      // Same: drop columns the SQL doesn't reference (label, note are
      // user-editable and not provider-overwritten).
      const { label: _l, note: _n, ...rest } = row;
      void _l;
      void _n;
      upsertTransaction.run(rest);
    }
  });
  writeAll();

  const accountsAdded = accounts.filter(
    (a) => !existingAccountIds.has(a.id),
  ).length;
  const accountsUpdated = accounts.length - accountsAdded;
  const transactionsAdded = transactions.filter(
    (t) => !existingTransactionIds.has(t.id),
  ).length;
  const transactionsUpdated = transactions.length - transactionsAdded;

  console.log(
    `[basiq] syncConnection done: connectionId=${connectionId} accounts=+${accountsAdded}/~${accountsUpdated} transactions=+${transactionsAdded}/~${transactionsUpdated} lastSyncDate=${lastSyncDate}`,
  );

  return {
    institutionId: institution.id,
    accountsAdded,
    accountsUpdated,
    transactionsAdded,
    transactionsUpdated,
    lastSyncDate,
  };
}

// ---------------------------------------------------------------------------
// Transaction pagination
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 500;

/**
 * Fetch every transaction for `connectionId`, optionally restricted to
 * those posted strictly after `cursor`. Walks `links.next` until exhausted.
 */
async function fetchAllTransactions(
  client: BasiqClient,
  userId: string,
  connectionId: string,
  cursor: string | null,
): Promise<BasiqTransaction[]> {
  const all: BasiqTransaction[] = [];

  // Multiple Basiq filter clauses are comma-separated. Always scope by
  // connection so we don't double-count when a user has multiple banks.
  const filterParts = [`connection.id.eq('${connectionId}')`];
  if (cursor) {
    filterParts.push(`transaction.postDate.gt('${cursor}')`);
  }
  const filter = filterParts.join(",");

  const firstPage = await client.get<BasiqListResponse<BasiqTransaction>>(
    `/users/${userId}/transactions`,
    { filter, limit: String(PAGE_LIMIT) },
  );
  all.push(...firstPage.data);

  let nextUrl = firstPage.links?.next;
  while (nextUrl) {
    const nextPath = pathFromUrl(nextUrl);
    const page = await client.get<BasiqListResponse<BasiqTransaction>>(nextPath);
    all.push(...page.data);
    nextUrl = page.links?.next;
  }

  return all;
}

/**
 * Extract `pathname + search` from a fully-qualified URL so it can be
 * passed back to `BasiqClient.get`, which expects a path-relative input.
 */
function pathFromUrl(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the lastSyncDate to persist. Use the maximum `postDate` across
 * the freshly-fetched transactions; if none were returned, fall back to
 * "now" so the next run still has a sensible lower bound.
 */
function computeLastSyncDate(transactions: BasiqTransaction[]): string {
  if (transactions.length === 0) {
    return new Date().toISOString();
  }
  let max = transactions[0].postDate;
  for (let i = 1; i < transactions.length; i++) {
    if (transactions[i].postDate > max) {
      max = transactions[i].postDate;
    }
  }
  return max;
}

/**
 * Return the set of `idColumn` values from `table` that match any of `ids`.
 * Used to distinguish inserts from updates before running ON CONFLICT
 * DO UPDATE statements.
 *
 * Note: parameterised IN-clauses can't take an array directly in libsql,
 * so we expand to `IN (?, ?, ...)`. `table` and `idColumn` are caller-
 * controlled string literals (not user input).
 */
function selectExistingIds(
  db: ReturnType<typeof getDb>,
  table: string,
  idColumn: string,
  ids: string[],
): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} IN (${placeholders})`,
    )
    .all(...ids) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
