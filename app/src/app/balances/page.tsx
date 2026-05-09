import { getDb } from "@ray/db/connection";

export const dynamic = "force-dynamic";

interface AccountRow {
  account_id: string;
  name: string;
  subtype: string | null;
  current_balance: number | null;
  currency: string | null;
  bank_name: string;
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
  const total = accounts.reduce((sum, a) => sum + (a.current_balance ?? 0), 0);

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-12 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Balances
        </h1>

        <section className="mb-14 text-center">
          <div className="text-3xl font-semibold tabular-nums text-neutral-900">
            {moneyFormatter.format(total)}
          </div>
          <div className="mt-2 text-sm text-neutral-500">
            across {accounts.length}{" "}
            {accounts.length === 1 ? "account" : "accounts"}
          </div>
        </section>

        {accounts.length === 0 ? (
          <p className="text-center text-sm text-neutral-500">
            No accounts on file.
          </p>
        ) : (
          <ul className="space-y-3">
            {accounts.map((a) => (
              <AccountCard key={a.account_id} account={a} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function AccountCard({ account }: { account: AccountRow }) {
  const balance = account.current_balance ?? 0;
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
      <div className="shrink-0 text-xl font-semibold tabular-nums text-neutral-900">
        {moneyFormatterCents.format(balance)}
      </div>
    </li>
  );
}
