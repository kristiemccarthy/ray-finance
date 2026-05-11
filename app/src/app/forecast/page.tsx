import { ChevronRight } from "lucide-react";
import {
  forecastBalance,
  loadForecastSettings,
  type CycleProjection,
  type ForecastItem,
  type ForecastResult,
} from "@ray/csv-import/balance-forecast";

export const dynamic = "force-dynamic";

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

// Lock the timezone explicitly: server SSR (often UTC) and client hydration
// (Sydney) would otherwise format the same Date differently. The render path
// here doesn't call `new Date()`, but the formatters can still diverge if the
// host timezone differs between SSR and hydration.
const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "Australia/Sydney",
});

const dayMonthFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  timeZone: "Australia/Sydney",
});

const dayFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  timeZone: "Australia/Sydney",
});

function parseYMD(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function formatFriendlyDate(ymd: string): string {
  return dateFormatter.format(parseYMD(ymd));
}

function formatCycleRange(startYMD: string, endYMD: string): string {
  const start = parseYMD(startYMD);
  const end = parseYMD(endYMD);
  const sameMonth =
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCFullYear() === end.getUTCFullYear();
  if (sameMonth) {
    return `${dayFormatter.format(start)} – ${dayMonthFormatter.format(end)}`;
  }
  return `${dayMonthFormatter.format(start)} – ${dayMonthFormatter.format(end)}`;
}

function cleanReason(reason: string): string {
  return reason.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function signedDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${moneyFormatter.format(Math.abs(delta))}`;
}

export default function ForecastPage() {
  const result: ForecastResult = forecastBalance({
    accountId: "csv:st-george:personal",
    cycleAnchorDayOfWeek: 3,
    numberOfCycles: 4,
  });
  const settings = loadForecastSettings();
  const budgetsPerCycle = result.cycleAdjustment - settings.perCycleBuffer;

  // Sparkline now plots the realistic trajectory.
  const sparklineValues = [
    result.currentBalance,
    ...result.cycles.map((c) => c.lifeAdjustedEndingBalance),
  ];

  // Bill-only lowest, end-of-cycle approximation. Used as the secondary
  // "before life" annotation in the hero.
  const billOnlyLowest = Math.min(
    result.currentBalance,
    ...result.cycles.map((c) => c.endingBalance),
  );

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-12 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Balance forecast
        </h1>

        <Hero result={result} billOnlyLowest={billOnlyLowest} />

        <div className="mb-14 text-slate-500">
          <Sparkline values={sparklineValues} />
        </div>

        <div className="space-y-4">
          {result.cycles.map((cycle, i) => (
            <CycleCard key={i} cycle={cycle} index={i} />
          ))}
        </div>

        <p className="mt-16 text-center text-xs leading-relaxed text-neutral-400">
          Forecast subtracts your monthly budgets (
          {moneyFormatter.format(budgetsPerCycle)}/cycle) plus a{" "}
          {moneyFormatter.format(settings.perCycleBuffer)}/cycle buffer for
          unexpected costs. Edit{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-[11px] text-neutral-500">
            ~/.ray/forecast.json
          </code>{" "}
          to adjust.
        </p>
      </div>
    </main>
  );
}

function Hero({
  result,
  billOnlyLowest,
}: {
  result: ForecastResult;
  billOnlyLowest: number;
}) {
  const { lowestPoint } = result;
  return (
    <section className="mb-12 text-center">
      <div className="text-sm text-neutral-500">Lowest projected</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-neutral-900">
        {moneyFormatter.format(lowestPoint.balance)}
      </div>
      <div className="mt-2 text-sm text-neutral-500">
        on {formatFriendlyDate(lowestPoint.date)},{" "}
        {cleanReason(lowestPoint.reason)}
      </div>
      <div className="mt-3 text-xs text-neutral-400">
        Before life: {moneyFormatter.format(billOnlyLowest)}
      </div>
    </section>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;

  const w = 672;
  const h = 120;
  const padding = 8;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (w - 2 * padding) / (values.length - 1);

  const coords = values.map((v, i) => {
    const x = padding + i * stepX;
    const y = padding + (h - 2 * padding) * (1 - (v - min) / range);
    return [x, y] as const;
  });

  const polyline = coords.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-30 w-full"
      role="img"
      aria-label="Realistic balance trajectory across upcoming cycles"
    >
      <polyline
        points={polyline}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {coords.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3} fill="currentColor" />
      ))}
    </svg>
  );
}

function CycleCard({
  cycle,
  index,
}: {
  cycle: CycleProjection;
  index: number;
}) {
  const lifeDelta =
    cycle.lifeAdjustedEndingBalance - cycle.lifeAdjustedStartingBalance;
  const itemCount = cycle.incomingItems.length + cycle.outgoingItems.length;
  const deltaColor = lifeDelta >= 0 ? "text-emerald-600" : "text-red-600";

  return (
    <details className="group rounded-md border border-stone-200 bg-white open:shadow-xs">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
        <ChevronRight
          className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-open:rotate-90"
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-900">
              Cycle {index + 1}
              <span className="ml-2 font-normal text-neutral-500">
                {formatCycleRange(cycle.startDate, cycle.endDate)}
              </span>
            </h2>
            <div className="text-sm tabular-nums text-neutral-700">
              {moneyFormatter.format(cycle.lifeAdjustedStartingBalance)}
              <span className="mx-1.5 text-neutral-400">→</span>
              {moneyFormatter.format(cycle.lifeAdjustedEndingBalance)}
              <span className={`ml-2 ${deltaColor}`}>
                ({signedDelta(lifeDelta)})
              </span>
            </div>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3 text-xs text-neutral-500">
            <span>
              Income {moneyFormatter.format(cycle.totalIncome)}, bills{" "}
              {moneyFormatter.format(cycle.totalBills)}, {itemCount}{" "}
              {itemCount === 1 ? "item" : "items"}
            </span>
            <span className="tabular-nums text-neutral-400">
              before life: {moneyFormatter.format(cycle.startingBalance)} →{" "}
              {moneyFormatter.format(cycle.endingBalance)}
            </span>
          </div>
        </div>
      </summary>

      <div className="border-t border-stone-100 px-5 py-4">
        {cycle.incomingItems.length > 0 && (
          <ItemList
            label="Income"
            items={cycle.incomingItems}
            amountClass="text-emerald-600"
            sign="+"
          />
        )}
        {cycle.outgoingItems.length > 0 && (
          <ItemList
            label="Bills"
            items={cycle.outgoingItems}
            amountClass="text-neutral-700"
            sign="−"
            extraTopMargin={cycle.incomingItems.length > 0}
          />
        )}
        {itemCount === 0 && (
          <p className="text-xs text-neutral-500">No items in this cycle.</p>
        )}
      </div>
    </details>
  );
}

function ItemList({
  label,
  items,
  amountClass,
  sign,
  extraTopMargin = false,
}: {
  label: string;
  items: ForecastItem[];
  amountClass: string;
  sign: "+" | "−";
  extraTopMargin?: boolean;
}) {
  return (
    <div className={extraTopMargin ? "mt-4" : ""}>
      <div className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li
            key={i}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="shrink-0 text-xs tabular-nums text-neutral-500">
              {formatFriendlyDate(item.date)}
            </span>
            <span className="min-w-0 flex-1 truncate text-neutral-800">
              {item.description}
              <span className="ml-2 text-xs text-neutral-400">
                [{item.source}]
              </span>
            </span>
            <span className={`shrink-0 tabular-nums ${amountClass}`}>
              {sign}
              {moneyFormatterCents.format(item.amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
