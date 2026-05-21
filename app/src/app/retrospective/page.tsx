import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  getRetrospective,
  RETROSPECTIVE_CATEGORY_ORDER,
  ALLOWED_PERIOD_COUNTS,
  DEFAULT_PERIOD_COUNT,
  type PeriodSummary,
  type RetrospectiveCategoryKey,
  type RetrospectiveView,
} from "@ray/retrospective";
import { Sparkline } from "@/components/sparkline";

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

// Hex literals match the Tailwind palette in use across the app
// (red-600 / emerald-600). Inlined here so the SVG `fill` attribute can use
// them without resorting to CSS custom properties.
const COLOUR_NEGATIVE = "#dc2626";

interface PageProps {
  searchParams: Promise<{ view?: string; periods?: string }>;
}

export default async function RetrospectivePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const view: RetrospectiveView = sp.view === "cycles" ? "cycles" : "calendar";
  const requested = Number.parseInt(sp.periods ?? "", 10);
  const count = (ALLOWED_PERIOD_COUNTS as readonly number[]).includes(requested)
    ? requested
    : DEFAULT_PERIOD_COUNT;

  const data = getRetrospective(view, count);

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Retrospective
        </h1>

        <div className="mt-6 flex flex-col items-center gap-3">
          <PeriodCountToggle count={count} view={view} />
          <ViewToggle view={view} count={count} />
        </div>

        {data.notEnoughHistory || data.periods.length === 0 ? (
          <p className="mt-16 text-center text-sm text-neutral-500">
            Not enough history yet — we need at least one completed{" "}
            {view === "calendar" ? "calendar month" : "pay cycle"} of data
            before there's anything to compare.
          </p>
        ) : (
          <>
            <NetCashflowHero
              periods={data.periods}
              view={view}
              count={count}
            />
            <PeriodList periods={data.periods} />
          </>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

function PeriodCountToggle({
  count,
  view,
}: {
  count: number;
  view: RetrospectiveView;
}) {
  const base =
    "rounded-full border px-3 py-1 text-xs font-medium tracking-wide uppercase transition";
  const active = "border-neutral-800 bg-neutral-800 text-white";
  const inactive =
    "border-stone-300 bg-white text-neutral-600 hover:border-neutral-400 hover:text-neutral-800";
  return (
    <div className="flex gap-2">
      {ALLOWED_PERIOD_COUNTS.map((c) => (
        <Link
          key={c}
          href={`/retrospective?view=${view}&periods=${c}`}
          className={`${base} ${count === c ? active : inactive}`}
        >
          {c} periods
        </Link>
      ))}
    </div>
  );
}

function ViewToggle({
  view,
  count,
}: {
  view: RetrospectiveView;
  count: number;
}) {
  const base =
    "rounded-full border px-4 py-1.5 text-xs font-medium tracking-wide uppercase transition";
  const active = "border-neutral-800 bg-neutral-800 text-white";
  const inactive =
    "border-stone-300 bg-white text-neutral-600 hover:border-neutral-400 hover:text-neutral-800";
  return (
    <div className="flex gap-2">
      <Link
        href={`/retrospective?view=calendar&periods=${count}`}
        className={`${base} ${view === "calendar" ? active : inactive}`}
      >
        Calendar months
      </Link>
      <Link
        href={`/retrospective?view=cycles&periods=${count}`}
        className={`${base} ${view === "cycles" ? active : inactive}`}
      >
        Pay cycles
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Net cashflow hero
// ---------------------------------------------------------------------------

function NetCashflowHero({
  periods,
  view,
  count,
}: {
  periods: PeriodSummary[];
  view: RetrospectiveView;
  count: number;
}) {
  // `periods` is most-recent-first; the sparkline wants oldest-left to
  // most-recent-right, so flip a copy for the chart only.
  const ordered = [...periods].reverse();
  const values = ordered.map((p) => p.net);
  const labels = ordered.map((p) =>
    Math.abs(p.net) >= 1000
      ? `${p.net < 0 ? "−" : ""}$${Math.round(Math.abs(p.net) / 1000)}k`
      : moneyFormatter.format(p.net),
  );
  const colors = ordered.map((p) =>
    p.net < 0 ? COLOUR_NEGATIVE : undefined,
  );

  // Sparkline needs at least two points to render. Single-period histories
  // get a textual fallback so the page doesn't show a silent gap.
  return (
    <section className="mt-10">
      {values.length >= 2 ? (
        <div className="text-slate-500">
          <Sparkline
            values={values}
            pointLabels={labels}
            pointColors={colors}
            width={672}
            height={140}
            className="h-32 w-full"
            ariaLabel={`Net cashflow across last ${count} ${view === "calendar" ? "months" : "cycles"}`}
          />
        </div>
      ) : (
        <div className="rounded-md border border-stone-200 bg-white px-4 py-6 text-center text-sm text-neutral-500">
          One period of data so far — add more history to see a trend.
        </div>
      )}
      <p className="mt-3 text-center text-xs leading-relaxed text-neutral-500">
        Net cashflow across last {count}{" "}
        {view === "calendar" ? "months" : "cycles"}. Dots above zero are
        positive periods; below are negative.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Expandable period rows
// ---------------------------------------------------------------------------

function PeriodList({ periods }: { periods: PeriodSummary[] }) {
  return (
    <section className="mt-12 space-y-3">
      {periods.map((p, i) => (
        <PeriodRow
          key={p.window.startDate}
          period={p}
          // Most recent expanded by default; everything else collapsed so
          // the page reads as a scannable list of period summaries.
          defaultOpen={i === 0}
        />
      ))}
    </section>
  );
}

function netColourClass(net: number): string {
  if (net > 0) return "text-emerald-600";
  if (net < 0) return "text-red-600";
  return "text-neutral-800";
}

function PeriodRow({
  period,
  defaultOpen,
}: {
  period: PeriodSummary;
  defaultOpen: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-md border border-stone-200 bg-white open:shadow-xs"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
        <ChevronRight
          className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-open:rotate-90"
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium tracking-wide text-neutral-900 uppercase">
              {period.window.label}
            </h2>
            <div
              className={`text-base font-semibold tabular-nums ${netColourClass(period.net)}`}
            >
              {moneyFormatter.format(period.net)} net
            </div>
          </div>
          <div className="mt-1 text-xs text-neutral-500 tabular-nums">
            {moneyFormatter.format(period.incomeTotal)} in /{" "}
            {moneyFormatter.format(period.outflowTotal)} out
          </div>
        </div>
      </summary>

      <div className="space-y-6 border-t border-stone-100 px-5 py-4">
        <CategoryList period={period} />
        <TopTransactionsList period={period} />
      </div>
    </details>
  );
}

interface CategoryRow {
  key: RetrospectiveCategoryKey;
  label: string;
  recent: number;
  prior: number | null;
  delta:
    | { kind: "new" }
    | { kind: "pct"; pct: number }
    | { kind: "none" }
    | null;
}

/**
 * +X% / -X% / new-spending. Returns null when both periods are zero (skip
 * the row), and `{kind: "none"}` when there's no prior at all (oldest
 * visible row with no history beyond — render the dollar only).
 */
function buildCategoryRows(period: PeriodSummary): CategoryRow[] {
  const rows: CategoryRow[] = [];
  for (const key of RETROSPECTIVE_CATEGORY_ORDER) {
    const recent = period.byCategory[key];
    const prior =
      period.priorByCategory !== null ? period.priorByCategory[key] : null;

    if (prior === null) {
      // No prior period to compare against (oldest visible, no history
      // beyond). Drop zero-amount rows so the list stays tight.
      if (recent === 0) continue;
      rows.push({
        key,
        label: CATEGORY_LABELS[key],
        recent,
        prior: null,
        delta: { kind: "none" },
      });
      continue;
    }

    if (recent === 0 && prior === 0) continue;
    if (prior === 0) {
      rows.push({
        key,
        label: CATEGORY_LABELS[key],
        recent,
        prior,
        delta: { kind: "new" },
      });
      continue;
    }
    const pct = ((recent - prior) / prior) * 100;
    rows.push({
      key,
      label: CATEGORY_LABELS[key],
      recent,
      prior,
      delta: { kind: "pct", pct },
    });
  }
  return rows;
}

function CategoryList({ period }: { period: PeriodSummary }) {
  const rows = buildCategoryRows(period);
  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="mb-3 text-xs font-medium tracking-wide text-neutral-500 uppercase">
        By category
      </h3>
      <ul className="space-y-2">
        {rows.map((row) => (
          <CategoryRowLi key={row.key} row={row} />
        ))}
      </ul>
    </div>
  );
}

function CategoryRowLi({ row }: { row: CategoryRow }) {
  let arrow: string | null;
  let colour: string;
  let text: string;

  if (!row.delta || row.delta.kind === "none") {
    // First (oldest) period — dollar only, no comparison.
    arrow = null;
    colour = "text-neutral-700";
    text = moneyFormatter.format(row.recent);
  } else if (row.delta.kind === "new") {
    arrow = "↑";
    colour = "text-red-600";
    text = "new spending";
  } else {
    const pct = row.delta.pct;
    const abs = Math.abs(pct);
    const rounded = Math.round(abs);
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
    <li className="rounded-md border border-stone-200 bg-stone-50 px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-neutral-700">{row.label}</div>
        <div className={`text-sm font-semibold tabular-nums ${colour}`}>
          {arrow ? `${arrow} ${text}` : text}
        </div>
      </div>
      {row.prior !== null && (
        <div className="mt-0.5 text-xs text-neutral-500 tabular-nums">
          {moneyFormatter.format(row.recent)} vs{" "}
          {moneyFormatter.format(row.prior)}
        </div>
      )}
    </li>
  );
}

function TopTransactionsList({ period }: { period: PeriodSummary }) {
  if (period.topTransactions.length === 0) return null;
  return (
    <div>
      <h3 className="mb-3 text-xs font-medium tracking-wide text-neutral-500 uppercase">
        Top 3 transactions
      </h3>
      <ul className="space-y-2">
        {period.topTransactions.map((t, i) => (
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
    </div>
  );
}
