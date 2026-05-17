import Link from "next/link";
import {
  getRetrospective,
  RETROSPECTIVE_CATEGORY_ORDER,
  type PeriodTotals,
  type RetrospectiveCategoryKey,
  type RetrospectiveView,
} from "@ray/retrospective";

export const dynamic = "force-dynamic";

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const CATEGORY_LABELS: Record<RetrospectiveCategoryKey, string> = {
  FOOD_AND_DRINK: "Food & Drink",
  MEDICAL: "Medical",
  GENERAL_MERCHANDISE: "Shopping",
  ENTERTAINMENT: "Entertainment",
  BILLS: "Bills",
  OTHER: "Other",
};

interface PageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function RetrospectivePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const view: RetrospectiveView = sp.view === "cycles" ? "cycles" : "calendar";
  const data = getRetrospective(view);

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Retrospective
        </h1>

        <ViewToggle view={view} />

        {data.notEnoughHistory || !data.recent || !data.comparison ? (
          <p className="mt-16 text-center text-sm text-neutral-500">
            Not enough history yet — we need at least two completed{" "}
            {view === "calendar" ? "calendar months" : "pay cycles"} of data
            before there's anything to compare.
          </p>
        ) : (
          <>
            <Hero recent={data.recent} comparison={data.comparison} />
            <CategoryList
              recent={data.recent}
              comparison={data.comparison}
            />
            <TopTransactions
              recent={data.recent}
              comparison={data.comparison}
            />
          </>
        )}
      </div>
    </main>
  );
}

function ViewToggle({ view }: { view: RetrospectiveView }) {
  const baseClass =
    "rounded-full border px-4 py-1.5 text-xs font-medium tracking-wide uppercase transition";
  const activeClass = "border-neutral-800 bg-neutral-800 text-white";
  const inactiveClass =
    "border-stone-300 bg-white text-neutral-600 hover:border-neutral-400 hover:text-neutral-800";

  return (
    <div className="mt-6 flex justify-center gap-2">
      <Link
        href="/retrospective?view=calendar"
        className={`${baseClass} ${view === "calendar" ? activeClass : inactiveClass}`}
      >
        Calendar months
      </Link>
      <Link
        href="/retrospective?view=cycles"
        className={`${baseClass} ${view === "cycles" ? activeClass : inactiveClass}`}
      >
        Pay cycles
      </Link>
    </div>
  );
}

function netColourClass(net: number): string {
  if (net > 0) return "text-emerald-600";
  if (net < 0) return "text-red-600";
  return "text-neutral-800";
}

function PeriodBlock({ p }: { p: PeriodTotals }) {
  return (
    <div className="flex-1 rounded-md border border-stone-200 bg-white px-5 py-5">
      <div className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {p.window.label}
      </div>
      <div
        className={`mt-3 text-3xl font-semibold tabular-nums ${netColourClass(p.net)}`}
      >
        {moneyFormatter.format(p.net)} net
      </div>
      <div className="mt-2 text-xs text-neutral-500 tabular-nums">
        {moneyFormatter.format(p.incomeTotal)} in /{" "}
        {moneyFormatter.format(p.outflowTotal)} out
      </div>
    </div>
  );
}

function Hero({
  recent,
  comparison,
}: {
  recent: PeriodTotals;
  comparison: PeriodTotals;
}) {
  return (
    <section className="mt-10 flex flex-col gap-4 sm:flex-row">
      <PeriodBlock p={recent} />
      <PeriodBlock p={comparison} />
    </section>
  );
}

interface CategoryRow {
  key: RetrospectiveCategoryKey;
  label: string;
  recent: number;
  prior: number;
  /**
   * "new" when prior was $0 and recent > $0, otherwise the percentage delta
   * relative to `prior`. `null` means both periods were $0 (skip the row).
   */
  delta:
    | { kind: "new" }
    | { kind: "pct"; pct: number }
    | null;
}

/**
 * +X% / -X% / new-spending for one category. Both-zero returns null so
 * the page can skip the row entirely.
 */
function computeDelta(recent: number, prior: number): CategoryRow["delta"] {
  if (recent === 0 && prior === 0) return null;
  if (prior === 0) return { kind: "new" };
  const pct = ((recent - prior) / prior) * 100;
  return { kind: "pct", pct };
}

function CategoryList({
  recent,
  comparison,
}: {
  recent: PeriodTotals;
  comparison: PeriodTotals;
}) {
  const rows: CategoryRow[] = [];
  for (const key of RETROSPECTIVE_CATEGORY_ORDER) {
    const r = recent.byCategory[key];
    const p = comparison.byCategory[key];
    const delta = computeDelta(r, p);
    if (delta === null) continue;
    rows.push({ key, label: CATEGORY_LABELS[key], recent: r, prior: p, delta });
  }

  if (rows.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        By category
      </h2>
      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <CategoryListRow key={row.key} row={row} />
        ))}
      </ul>
    </section>
  );
}

function CategoryListRow({ row }: { row: CategoryRow }) {
  let arrow: string;
  let colour: string;
  let text: string;

  if (row.delta.kind === "new") {
    arrow = "↑";
    colour = "text-red-600";
    text = "new spending";
  } else {
    const pct = row.delta.pct;
    const abs = Math.abs(pct);
    const rounded = Math.round(abs);
    // ±5% window reads as "essentially flat" — both arrow and colour go
    // neutral so the reader's eye skips the noise.
    if (abs <= 5) {
      arrow = "→";
      colour = "text-neutral-500";
    } else if (pct < 0) {
      arrow = "↓";
      colour = "text-emerald-600";
    } else {
      arrow = "↑";
      colour = "text-red-600";
    }
    text = `${rounded}%`;
  }

  return (
    <li className="rounded-md border border-stone-200 bg-white px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-neutral-700">{row.label}</div>
        <div className={`text-sm font-semibold tabular-nums ${colour}`}>
          {arrow} {text}
        </div>
      </div>
      <div className="mt-1 text-xs text-neutral-500 tabular-nums">
        {moneyFormatter.format(row.recent)} vs {moneyFormatter.format(row.prior)}
      </div>
    </li>
  );
}

function TopTransactionColumn({ p }: { p: PeriodTotals }) {
  return (
    <div className="flex-1 rounded-md border border-stone-200 bg-white px-5 py-5">
      <div className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {p.window.label}
      </div>
      {p.topTransactions.length === 0 ? (
        <div className="mt-3 text-sm text-neutral-500">No outflows</div>
      ) : (
        <ul className="mt-3 space-y-2">
          {p.topTransactions.map((t, i) => (
            <li
              key={`${t.date}-${t.name}-${i}`}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="truncate text-neutral-700">{t.name}</span>
              <span className="shrink-0 tabular-nums text-neutral-900">
                {moneyFormatter.format(t.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TopTransactions({
  recent,
  comparison,
}: {
  recent: PeriodTotals;
  comparison: PeriodTotals;
}) {
  return (
    <section className="mt-12">
      <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        Top 3 transactions
      </h2>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row">
        <TopTransactionColumn p={recent} />
        <TopTransactionColumn p={comparison} />
      </div>
    </section>
  );
}
