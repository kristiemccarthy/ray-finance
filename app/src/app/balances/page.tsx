import { getDb } from "@ray/db/connection";
import { getPendingSummary } from "@ray/pending";

export const dynamic = "force-dynamic";

// Pending screenshots today are of the St George Personal (operating) account
// only, so every row in `pending_transactions` is treated as Personal pending
// and subtracted from that account's Available balance. Other accounts have no
// pending, so their Available equals their Balance.
//
// Future schema upgrade: when `pending_transactions` gains an `account_id`
// column, replace this constant + the whole-table `getPendingSummary()` call
// with a per-account pending lookup keyed on that column. The UI below needs
// no change — it already renders Available per card.
const PENDING_ACCOUNT_ID = "csv:st-george:personal";

interface AccountRow {
  account_id: string;
  name: string;
  subtype: string | null;
  current_balance: number | null;
  currency: string | null;
  bank_name: string;
}

interface AccountView extends AccountRow {
  balance: number;
  available: number;
  /** Whole-table pending applied to this account (0 for non-pending accounts). */
  pendingTotal: number;
  pendingCount: number;
}

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const moneyFormatterCents = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

function purposeLabel(subtype: string | null): string {
  switch (subtype) {
    case "checking":
      return "Operating";
    case "savings":
      return "Savings";
    case "prepaid":
      return "Salary packaged";
    default:
      return subtype ?? "—";
  }
}

function loadAccounts(): AccountRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT a.account_id,
              a.name,
              a.subtype,
              a.current_balance,
              a.currency,
              i.name AS bank_name
         FROM accounts a
         JOIN institutions i ON i.item_id = a.item_id
        WHERE a.hidden = 0
        ORDER BY a.current_balance DESC NULLS LAST`,
    )
    .all() as AccountRow[];
}

export default function BalancesPage() {
  const accounts = loadAccounts();
  // Whole-table pending — all of it belongs to PENDING_ACCOUNT_ID (see note).
  // Signed sum, so pending refunds (negative) correctly raise Available.
  const pending = getPendingSummary();

  const views: AccountView[] = accounts.map((a) => {
    const balance = a.current_balance ?? 0;
    const isPendingAccount = a.account_id === PENDING_ACCOUNT_ID;
    return {
      ...a,
      balance,
      available: isPendingAccount ? balance - pending.total : balance,
      pendingTotal: isPendingAccount ? pending.total : 0,
      pendingCount: isPendingAccount ? pending.count : 0,
    };
  });

  const totalBalance = views.reduce((sum, v) => sum + v.balance, 0);
  const totalAvailable = views.reduce((sum, v) => sum + v.available, 0);
  const showHeaderAvailable = pending.total > 0;

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-12 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Balances
        </h1>

        <section className="mb-14 text-center">
          <div className="text-3xl font-semibold tabular-nums text-neutral-900">
            {moneyFormatter.format(totalBalance)}
          </div>
          <div className="mt-2 text-sm text-neutral-500">
            across {accounts.length}{" "}
            {accounts.length === 1 ? "account" : "accounts"}
          </div>
          {showHeaderAvailable && (
            <div className="mt-1 text-sm text-neutral-500 tabular-nums">
              {moneyFormatter.format(totalAvailable)} available
            </div>
          )}
        </section>

        {accounts.length === 0 ? (
          <p className="text-center text-sm text-neutral-500">
            No accounts on file.
          </p>
        ) : (
          <ul className="space-y-3">
            {views.map((v) => (
              <AccountCard key={v.account_id} account={v} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function AccountCard({ account }: { account: AccountView }) {
  // Available is only meaningful to show when it diverges from the settled
  // Balance — i.e. when this account has outstanding pending. Equal accounts
  // render a single number, matching how the bank presents them.
  const showAvailable = account.available !== account.balance;
  return (
    <li className="flex items-center justify-between gap-4 rounded-md border border-stone-200 bg-white px-5 py-5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium text-neutral-900">
          {account.bank_name}
          <span className="text-neutral-400"> — </span>
          {account.name}
        </div>
        <div className="mt-1 text-xs tracking-wide text-neutral-500 uppercase">
          {purposeLabel(account.subtype)}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xl font-semibold tabular-nums text-neutral-900">
          {moneyFormatterCents.format(account.balance)}
        </div>
        {showAvailable && (
          <>
            <div className="mt-1 text-sm text-neutral-500 tabular-nums">
              {moneyFormatterCents.format(account.available)} available
            </div>
            <div className="mt-0.5 text-xs text-neutral-400 tabular-nums">
              {moneyFormatterCents.format(account.pendingTotal)} pending across{" "}
              {account.pendingCount}{" "}
              {account.pendingCount === 1 ? "transaction" : "transactions"}
            </div>
          </>
        )}
      </div>
    </li>
  );
}
