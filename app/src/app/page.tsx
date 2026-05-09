import { Calendar } from "lucide-react";
import { getDb } from "@ray/db/connection";
import { getUpcomingBills, type UpcomingBill } from "@ray/db/bills";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

function daysUntil(date: Date): number {
  const today = new Date();
  const a = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const b = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

function urgencyClass(days: number): string {
  if (days <= 3) return "bg-red-500";
  if (days <= 7) return "bg-amber-500";
  return "bg-stone-300";
}

export default function Home() {
  const db = getDb();
  const bills = getUpcomingBills(db, 14);
  const total = bills.reduce((sum, b) => sum + b.amount, 0);

  return (
    <main className="min-h-screen bg-stone-50 text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-12 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Upcoming bills
        </h1>

        <section className="mb-14 text-center">
          <div className="text-3xl font-semibold tabular-nums text-neutral-900">
            {moneyFormatter.format(total)}
          </div>
          <div className="mt-2 text-sm text-neutral-500">
            due in the next 14 days
          </div>
        </section>

        {bills.length === 0 ? (
          <p className="text-center text-sm text-neutral-500">
            Nothing due in the next 14 days.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-md border border-stone-200 bg-white">
            {bills.map((bill, i) => (
              <BillRow
                key={i}
                bill={bill}
                isLast={i === bills.length - 1}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function BillRow({ bill, isLast }: { bill: UpcomingBill; isLast: boolean }) {
  const days = daysUntil(bill.date);
  const sourceLabel =
    bill.source === "recurring"
      ? "[recurring]"
      : bill.source === "manual"
        ? "[manual]"
        : "[card]";

  return (
    <li
      className={`flex items-center gap-4 px-5 py-5 ${
        isLast ? "" : "border-b border-stone-100"
      }`}
    >
      <span
        aria-hidden
        className={`-mx-5 -my-5 mr-1 w-1 self-stretch ${urgencyClass(days)}`}
      />

      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <div className="flex shrink-0 items-center gap-1.5 text-sm tabular-nums text-neutral-500">
          <Calendar className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{dateFormatter.format(bill.date)}</span>
        </div>

        <div className="min-w-0 flex-1 truncate">
          <span className="text-base font-medium text-neutral-900">
            {bill.name}
          </span>
          <span className="ml-2 text-xs text-neutral-400">{sourceLabel}</span>
        </div>
      </div>

      <div className="shrink-0 text-base font-medium tabular-nums text-neutral-900">
        {moneyFormatter.format(bill.amount)}
      </div>
    </li>
  );
}
