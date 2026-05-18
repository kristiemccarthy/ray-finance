import {
  forecastBalance,
  loadForecastSources,
  type ForecastResult,
} from "@ray/csv-import/balance-forecast";
import { WhatIfScenario } from "@/components/what-if-scenario";
import { computeScenarioForecast } from "../actions";

export const dynamic = "force-dynamic";

const WHAT_IF_ACCOUNT_ID = "csv:st-george:personal";
/**
 * Default horizon for the initial server-rendered baseline. The client can
 * pick longer horizons via the dropdown, but those re-fetch through the
 * scenario action — the initial render stays cheap.
 */
const DEFAULT_HORIZON = 4;

export interface ScenarioListItem {
  /** Composite key: "manual:<id>" for manual bills, "stream:<stream_id>" for recurring. */
  key: string;
  source: "manual" | "recurring";
  /** Numeric id for manual rows — undefined for recurring. */
  manualId?: number;
  /** Plaid stream_id for recurring rows — undefined for manual. */
  streamKey?: string;
  /** Display label. */
  name: string;
  amount: number;
  /** Free-text cadence label, e.g. "monthly", "fortnight", "MONTHLY". */
  frequency: string;
}

/**
 * Convert the raw forecast sources into the flat list shape the client
 * component renders. Display label prefers `merchant_name` (post-alias) and
 * falls back to the original `description`, matching the convention used by
 * the rest of the app.
 */
function buildLists(accountId: string): {
  manualBills: ScenarioListItem[];
  recurringOutflows: ScenarioListItem[];
  recurringInflows: ScenarioListItem[];
} {
  const sources = loadForecastSources(accountId);

  const manualBills: ScenarioListItem[] = sources.manualRows.map((r) => ({
    key: `manual:${r.id}`,
    source: "manual",
    manualId: r.id,
    name: r.name,
    amount: r.amount,
    frequency: r.frequency,
  }));

  const recurringOutflows: ScenarioListItem[] = sources.outflowRows.map((r) => ({
    key: `stream:${r.stream_id}`,
    source: "recurring",
    streamKey: r.stream_id,
    name: r.merchant_name || r.description,
    // `last_amount` is the most recent observed charge; fall back to `avg_amount`
    // (a stream that's only ever seen one charge has avg = last).
    amount: Math.abs(r.last_amount ?? r.avg_amount ?? 0),
    frequency: r.frequency,
  }));

  const recurringInflows: ScenarioListItem[] = sources.inflowRows.map((r) => ({
    key: `stream:${r.stream_id}`,
    source: "recurring",
    streamKey: r.stream_id,
    name: r.merchant_name || r.description,
    amount: Math.abs(r.last_amount ?? r.avg_amount ?? 0),
    frequency: r.frequency,
  }));

  return { manualBills, recurringOutflows, recurringInflows };
}

export default function WhatIfPage() {
  const baseline: ForecastResult = forecastBalance({
    accountId: WHAT_IF_ACCOUNT_ID,
    cycleAnchorDayOfWeek: 3,
    numberOfCycles: DEFAULT_HORIZON,
  });
  const lists = buildLists(WHAT_IF_ACCOUNT_ID);

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="mb-8 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          What if?
        </h1>

        <WhatIfScenario
          baseline={baseline}
          manualBills={lists.manualBills}
          recurringOutflows={lists.recurringOutflows}
          recurringInflows={lists.recurringInflows}
          computeAction={computeScenarioForecast}
        />
      </div>
    </main>
  );
}
