import Link from "next/link";
import { getDb } from "@ray/db/connection";
import {
  CATEGORY_OPTIONS,
  FLOW_TYPE_OPTIONS,
} from "@/app/settings/categories/form-values";
import {
  TransactionRowEditor,
  type TransactionAccount,
  type TransactionRowData,
} from "@/components/transaction-row-editor";
import {
  setTransactionOverride,
  clearTransactionOverride,
} from "@/app/actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const DEFAULT_LOOKBACK_DAYS = 90;

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

const shortDateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

interface PageProps {
  searchParams: Promise<{
    from?: string;
    to?: string;
    account?: string;
    category?: string;
    flow?: string;
    q?: string;
    min?: string;
    max?: string;
    page?: string;
  }>;
}

interface Filters {
  from: string;
  to: string;
  account: string;
  category: string;
  flow: string;
  q: string;
  min: string;
  max: string;
  page: number;
}

function parseFilters(sp: Awaited<PageProps["searchParams"]>): Filters {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const pageNum = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  return {
    from: ymdOrEmpty(sp.from) || defaultFrom,
    to: ymdOrEmpty(sp.to) || defaultTo,
    account: (sp.account ?? "").trim(),
    category: (sp.category ?? "").trim(),
    flow: (sp.flow ?? "").trim(),
    q: (sp.q ?? "").trim(),
    min: (sp.min ?? "").trim(),
    max: (sp.max ?? "").trim(),
    page: pageNum,
  };
}

function ymdOrEmpty(s: string | undefined): string {
  if (!s) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function buildQuery(f: Filters, page = 1): string {
  const sp = new URLSearchParams();
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  if (f.account) sp.set("account", f.account);
  if (f.category) sp.set("category", f.category);
  if (f.flow) sp.set("flow", f.flow);
  if (f.q) sp.set("q", f.q);
  if (f.min) sp.set("min", f.min);
  if (f.max) sp.set("max", f.max);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

function loadAccounts(): TransactionAccount[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT account_id, name
         FROM accounts
        WHERE hidden = 0
        ORDER BY name`,
    )
    .all() as TransactionAccount[];
}

interface QueryResult {
  rows: TransactionRowData[];
  total: number;
}

function loadTransactions(f: Filters): QueryResult {
  const db = getDb();
  const where: string[] = [
    "t.date BETWEEN ? AND ?",
    "t.pending = 0",
  ];
  const params: (string | number)[] = [f.from, f.to];

  if (f.account) {
    where.push("t.account_id = ?");
    params.push(f.account);
  }
  if (f.category) {
    where.push("t.category = ?");
    params.push(f.category);
  }
  if (f.flow) {
    where.push("t.flow_type = ?");
    params.push(f.flow);
  }
  if (f.q) {
    where.push(
      "(UPPER(t.name) LIKE ? OR UPPER(t.raw_name) LIKE ? OR UPPER(COALESCE(t.enriched_name, '')) LIKE ?)",
    );
    const like = `%${f.q.toUpperCase()}%`;
    params.push(like, like, like);
  }
  if (f.min) {
    const n = Number.parseFloat(f.min);
    if (Number.isFinite(n)) {
      where.push("ABS(t.amount) >= ?");
      params.push(n);
    }
  }
  if (f.max) {
    const n = Number.parseFloat(f.max);
    if (Number.isFinite(n)) {
      where.push("ABS(t.amount) <= ?");
      params.push(n);
    }
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM transactions t ${whereClause}`)
    .get(...params) as { total: number };

  const offset = (f.page - 1) * PAGE_SIZE;
  const rows = db
    .prepare(
      `SELECT t.transaction_id,
              t.date,
              COALESCE(t.enriched_name, t.name) AS display_name,
              t.raw_name,
              t.amount,
              t.category,
              t.subcategory,
              t.flow_type,
              t.manual_category,
              t.manual_flow_type,
              t.account_id
         FROM transactions t
       ${whereClause}
        ORDER BY t.date DESC, t.transaction_id DESC
        LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    )
    .all(...params) as TransactionRowData[];

  return { rows, total: totalRow.total };
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const accounts = loadAccounts();
  const { rows, total } = loadTransactions(filters);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <div className="mb-8 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Transactions
            </h1>
            <p className="mt-1 text-xs text-neutral-500">
              <Link
                href="/settings"
                className="underline-offset-2 hover:text-neutral-800 hover:underline"
              >
                ← Back to settings
              </Link>
            </p>
          </div>
          <div className="text-xs text-neutral-500 tabular-nums">
            {total.toLocaleString()} {total === 1 ? "result" : "results"}
          </div>
        </div>

        <FilterForm filters={filters} accounts={accounts} />

        {rows.length === 0 ? (
          <p className="mt-10 text-center text-sm text-neutral-500">
            No transactions match these filters.
          </p>
        ) : (
          <>
            <ul className="mt-8 overflow-hidden rounded-md border border-stone-200 bg-white">
              {rows.map((row) => (
                <TransactionRowEditor
                  key={row.transaction_id}
                  row={row}
                  setOverrideAction={setTransactionOverride}
                  clearOverrideAction={clearTransactionOverride}
                />
              ))}
            </ul>
            <Pagination filters={filters} pageCount={pageCount} />
          </>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Filter form — pure GET form, native browser submit.
// ---------------------------------------------------------------------------

function FilterForm({
  filters,
  accounts,
}: {
  filters: Filters;
  accounts: TransactionAccount[];
}) {
  return (
    <form
      method="GET"
      className="space-y-3 rounded-md border border-stone-200 bg-white p-4 text-sm"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">From</span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">To</span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">Account</span>
          <select
            name="account"
            defaultValue={filters.account}
            className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          >
            <option value="">(any)</option>
            {accounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">Flow type</span>
          <select
            name="flow"
            defaultValue={filters.flow}
            className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          >
            <option value="">(any)</option>
            {FLOW_TYPE_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-xs font-medium text-neutral-500">Category</span>
          <select
            name="category"
            defaultValue={filters.category}
            className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          >
            <option value="">(any)</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">Min amount</span>
          <input
            type="number"
            name="min"
            inputMode="decimal"
            step="0.01"
            defaultValue={filters.min}
            placeholder="e.g. 100"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">Max amount</span>
          <input
            type="number"
            name="max"
            inputMode="decimal"
            step="0.01"
            defaultValue={filters.max}
            placeholder="e.g. 10000"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block sm:col-span-4">
          <span className="block text-xs font-medium text-neutral-500">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Description, raw descriptor, or enriched merchant name"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
        </label>
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        <Link
          href="/settings/transactions"
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          Reset
        </Link>
        <button
          type="submit"
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs font-medium text-stone-50 hover:bg-neutral-900"
        >
          Apply filters
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function Pagination({
  filters,
  pageCount,
}: {
  filters: Filters;
  pageCount: number;
}) {
  if (pageCount <= 1) return null;
  const prev = Math.max(1, filters.page - 1);
  const next = Math.min(pageCount, filters.page + 1);
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-neutral-500">
      <Link
        href={`/settings/transactions${buildQuery(filters, prev)}`}
        className={filters.page === 1 ? "pointer-events-none opacity-40" : "hover:text-neutral-900"}
        aria-disabled={filters.page === 1}
      >
        ← Previous
      </Link>
      <span className="tabular-nums">
        Page {filters.page} of {pageCount}
      </span>
      <Link
        href={`/settings/transactions${buildQuery(filters, next)}`}
        className={filters.page === pageCount ? "pointer-events-none opacity-40" : "hover:text-neutral-900"}
        aria-disabled={filters.page === pageCount}
      >
        Next →
      </Link>
    </div>
  );
}

// `moneyFormatter` and `shortDateFormatter` are intentionally exported via
// transaction-row-editor's expected shape — keep them in this module's
// scope only. The editor formats its own values to avoid a cross-import.
void moneyFormatter;
void shortDateFormatter;
