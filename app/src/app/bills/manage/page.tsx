import Link from "next/link";
import { getDb } from "@ray/db/connection";
import { deleteBill } from "@/app/actions";
import { DeleteBillButton } from "@/components/delete-bill-button";

export const dynamic = "force-dynamic";

interface BillRow {
  id: number;
  name: string;
  amount: number;
  day_of_month: number | null;
  frequency: string;
  next_due_date: string | null;
  type: string | null;
}

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "Australia/Sydney",
});

// Ordered for display: calendar-month cadences first (monthly → bi-monthly
// → quarterly → yearly), then interval cadences (fortnightly → weekly).
// Anything else falls to the end so we don't accidentally hide rows with
// unexpected frequency strings.
const FREQUENCY_ORDER: Record<string, number> = {
  monthly: 0,
  "bi-monthly": 1,
  quarterly: 2,
  yearly: 3,
  fortnightly: 4,
  weekly: 5,
};

function frequencyLabel(f: string): string {
  return f.charAt(0).toUpperCase() + f.slice(1);
}

function loadBills(): BillRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, name, amount, day_of_month, frequency, next_due_date, type
         FROM recurring_bills`,
    )
    .all() as BillRow[];
}

function scheduleLabel(bill: BillRow): string {
  if (bill.frequency === "monthly") {
    if (bill.day_of_month === null) return "Monthly";
    return `Monthly · day ${bill.day_of_month}`;
  }
  if (bill.next_due_date) {
    const d = new Date(bill.next_due_date + "T00:00:00Z");
    return `${frequencyLabel(bill.frequency)} · next ${dateFormatter.format(d)}`;
  }
  return frequencyLabel(bill.frequency);
}

export default function ManageBillsPage() {
  const rows = loadBills().sort((a, b) => {
    const fa = FREQUENCY_ORDER[a.frequency] ?? 99;
    const fb = FREQUENCY_ORDER[b.frequency] ?? 99;
    if (fa !== fb) return fa - fb;
    return a.name.localeCompare(b.name);
  });

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-12 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Manage Bills
        </h1>

        <div className="mb-6 flex items-center justify-between">
          <p className="text-sm text-neutral-500">
            {rows.length} manual {rows.length === 1 ? "bill" : "bills"}
          </p>
          <Link
            href="/bills/manage/new"
            className="rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-stone-50 hover:bg-neutral-900"
          >
            Add new bill
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-md border border-stone-200 bg-white p-8 text-center text-sm text-neutral-500">
            No manual bills yet. Add one to track recurring expenses outside of
            your bank's auto-detected stream list.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((bill) => (
              <BillRow key={bill.id} bill={bill} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function BillRow({ bill }: { bill: BillRow }) {
  return (
    <li className="rounded-md border border-stone-200 bg-white px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium text-neutral-900">
            {bill.name}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {scheduleLabel(bill)}
          </div>
        </div>
        <div className="shrink-0 text-base font-medium tabular-nums text-neutral-900">
          {moneyFormatter.format(bill.amount)}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-5 border-t border-stone-100 pt-3">
        <Link
          href={`/bills/manage/${bill.id}/edit`}
          className="text-sm text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
        >
          Edit
        </Link>
        <DeleteBillButton action={deleteBill.bind(null, bill.id)} />
      </div>
    </li>
  );
}
