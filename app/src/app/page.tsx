import Link from "next/link";
import { Calendar } from "lucide-react";
import { getDb } from "@ray/db/connection";
import { getUpcomingBills, type UpcomingBill } from "@ray/db/bills";
import { markBillPaid } from "./actions";
import { MarkPaidButton } from "@/components/mark-paid-button";

export const dynamic = "force-dynamic";

// Lock the timezone explicitly: server SSR (often UTC) and client hydration
// (Sydney) would otherwise format the same Date differently, which is itself
// a hydration-mismatch source independent of `new Date()`.
const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "Australia/Sydney",
});

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

/** UTC midnight of the given instant. Pure — never reads the clock. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Whole days between two UTC-midnight Dates. Pure — `today` is supplied by the caller. */
function daysUntil(date: Date, today: Date): number {
  return Math.round((date.getTime() - today.getTime()) / 86_400_000);
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
  // Compute "today" once per request, then thread it down. Calling `new Date()`
  // anywhere below this point would risk server/client divergence.
  const today = startOfUtcDay(new Date());

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
                today={today}
              />
            ))}
          </ul>
        )}

        <p className="mt-10 text-center text-xs text-neutral-400">
          <Link
            href="/bills/manage"
            className="underline-offset-2 hover:text-neutral-700 hover:underline"
          >
            Manage bills
          </Link>
        </p>
      </div>
    </main>
  );
}

function BillRow({
  bill,
  isLast,
  today,
}: {
  bill: UpcomingBill;
  isLast: boolean;
  today: Date;
}) {
  const days = daysUntil(bill.date, today);
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

      {bill.source === "manual" && bill.manualBillId !== undefined && (
        <MarkPaidButton action={markBillPaid.bind(null, bill.manualBillId)} />
      )}

      <div className="shrink-0 text-base font-medium tabular-nums text-neutral-900">
        {moneyFormatter.format(bill.amount)}
      </div>
    </li>
  );
}
