"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ForecastResult } from "@ray/csv-import/balance-forecast";
import type {
  HypotheticalBill,
  HypotheticalFrequency,
  Scenario,
} from "@ray/forecast/scenario";
import type { ScenarioListItem } from "@/app/what-if/page";
import type { ScenarioForecastResult } from "@/app/actions";

// ---------------------------------------------------------------------------
// What-if scenario UI.
//
// Holds all interactive state for /what-if: which bills are toggled off,
// which amounts have been edited, and any hypothetical bills the user has
// invented. Pings the server action whenever scenario state settles for
// 300ms.
//
// State lives only in memory — refreshing the page resets to baseline.
// Intentional for v1; persisting scenarios is a separate feature.
// ---------------------------------------------------------------------------

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

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "Australia/Sydney",
});

const DEBOUNCE_MS = 300;

const DEFAULT_HORIZON = 4;

interface HorizonOption {
  label: string;
  /** Number of cycles passed to `forecastBalance`. */
  value: number;
}

const HORIZON_OPTIONS: HorizonOption[] = [
  { label: "8 weeks (4 cycles)", value: 4 },
  { label: "3 months (7 cycles)", value: 7 },
  { label: "6 months (13 cycles)", value: 13 },
  { label: "12 months (26 cycles)", value: 26 },
];

interface Props {
  baseline: ForecastResult;
  manualBills: ScenarioListItem[];
  recurringOutflows: ScenarioListItem[];
  recurringInflows: ScenarioListItem[];
  computeAction: (
    scenario: Scenario,
    horizon: number,
  ) => Promise<ScenarioForecastResult>;
}

const EMPTY: Scenario = {
  disabledManualBillIds: [],
  disabledStreamKeys: [],
  amountOverrides: {},
  hypotheticalBills: [],
};

export function WhatIfScenario({
  baseline,
  manualBills,
  recurringOutflows,
  recurringInflows,
  computeAction,
}: Props) {
  const [scenario, setScenario] = useState<Scenario>(EMPTY);
  const [horizon, setHorizon] = useState<number>(DEFAULT_HORIZON);
  // `current` and `hypothetical` are tracked separately because both change
  // when the user picks a longer horizon — `current` is no longer pinned to
  // the server-rendered baseline once you step off the default.
  const [current, setCurrent] = useState<ForecastResult>(baseline);
  const [hypothetical, setHypothetical] = useState<ForecastResult>(baseline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tracks which scenario was last *requested* — if the user keeps clicking
  // mid-flight, a stale response shouldn't clobber a newer one. The token is
  // a monotonically increasing integer rather than a ref to the scenario
  // itself (which would compare by identity, not value).
  const requestSeq = useRef(0);

  const isEmpty = useMemo(() => isEmptyScenario(scenario), [scenario]);
  const isDefaultHorizon = horizon === DEFAULT_HORIZON;

  useEffect(() => {
    // Short-circuit: default horizon + empty scenario is exactly what the
    // server rendered into `baseline`. No fetch, no debounce, no flicker.
    if (isDefaultHorizon && isEmpty) {
      setCurrent(baseline);
      setHypothetical(baseline);
      setError(null);
      setPending(false);
      return;
    }

    setPending(true);
    const token = ++requestSeq.current;
    const handle = setTimeout(async () => {
      // When the scenario is empty, `current` and `hypothetical` are
      // identical at this horizon — one server call covers both, halving
      // the work for a pure horizon change.
      if (isEmpty) {
        const res = await computeAction(EMPTY, horizon);
        if (token !== requestSeq.current) return;
        if (res.ok) {
          setCurrent(res.result);
          setHypothetical(res.result);
          setError(null);
        } else {
          setError(res.error);
        }
        setPending(false);
        return;
      }

      const [currentRes, hypRes] = await Promise.all([
        computeAction(EMPTY, horizon),
        computeAction(scenario, horizon),
      ]);
      if (token !== requestSeq.current) return;
      if (currentRes.ok && hypRes.ok) {
        setCurrent(currentRes.result);
        setHypothetical(hypRes.result);
        setError(null);
      } else {
        setError(
          (!currentRes.ok && currentRes.error) ||
            (!hypRes.ok && hypRes.error) ||
            "Unknown error",
        );
      }
      setPending(false);
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [scenario, isEmpty, horizon, isDefaultHorizon, baseline, computeAction]);

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  const toggleManual = (id: number) =>
    setScenario((s) => {
      const set = new Set(s.disabledManualBillIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...s, disabledManualBillIds: [...set] };
    });

  const toggleStream = (streamId: string) =>
    setScenario((s) => {
      const set = new Set(s.disabledStreamKeys);
      if (set.has(streamId)) set.delete(streamId);
      else set.add(streamId);
      return { ...s, disabledStreamKeys: [...set] };
    });

  const setOverride = (key: string, amount: number | null) =>
    setScenario((s) => {
      const next = { ...s.amountOverrides };
      if (amount === null || !Number.isFinite(amount) || amount < 0) {
        delete next[key];
      } else {
        next[key] = amount;
      }
      return { ...s, amountOverrides: next };
    });

  const addHypothetical = (h: HypotheticalBill) =>
    setScenario((s) => ({ ...s, hypotheticalBills: [...s.hypotheticalBills, h] }));

  const removeHypothetical = (tempId: string) =>
    setScenario((s) => ({
      ...s,
      hypotheticalBills: s.hypotheticalBills.filter((h) => h.tempId !== tempId),
    }));

  const reset = () => setScenario(EMPTY);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-12">
      <div className="space-y-4">
        <HorizonPicker horizon={horizon} onChange={setHorizon} />
        <ComparisonHero
          baseline={current}
          hypothetical={hypothetical}
          pending={pending}
          horizon={horizon}
        />
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Couldn't recompute scenario: {error}
        </div>
      )}

      <Section title="Income">
        <ItemList
          items={recurringInflows}
          scenario={scenario}
          onToggleManual={toggleManual}
          onToggleStream={toggleStream}
          onSetOverride={setOverride}
          emptyMessage="No recurring income detected."
        />
      </Section>

      <Section title="Manual bills">
        <ItemList
          items={manualBills}
          scenario={scenario}
          onToggleManual={toggleManual}
          onToggleStream={toggleStream}
          onSetOverride={setOverride}
          emptyMessage="No manual bills configured."
        />
      </Section>

      <Section title="Auto-detected subscriptions">
        <ItemList
          items={recurringOutflows}
          scenario={scenario}
          onToggleManual={toggleManual}
          onToggleStream={toggleStream}
          onSetOverride={setOverride}
          emptyMessage="No auto-detected recurring outflows."
        />
      </Section>

      <Section title="Hypothetical">
        <HypotheticalsList
          hypotheticals={scenario.hypotheticalBills}
          onRemove={removeHypothetical}
          onAdd={addHypothetical}
        />
      </Section>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={reset}
          disabled={isEmpty}
          className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset to current state
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero — side-by-side comparison
// ---------------------------------------------------------------------------

function ComparisonHero({
  baseline,
  hypothetical,
  pending,
  horizon,
}: {
  baseline: ForecastResult;
  hypothetical: ForecastResult;
  pending: boolean;
  horizon: number;
}) {
  const lowestDelta =
    hypothetical.lowestPoint.balance - baseline.lowestPoint.balance;

  return (
    <section>
      <div className="mb-4 flex items-center justify-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
        <span>Forecast comparison</span>
        {pending && (
          <span className="text-neutral-400">· recalculating…</span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ForecastBlock
          label="Current scenario"
          result={baseline}
        />
        <ForecastBlock
          label="Hypothetical scenario"
          result={hypothetical}
          delta={lowestDelta}
        />
      </div>

      <CycleComparison baseline={baseline} hypothetical={hypothetical} />

      {horizon > DEFAULT_HORIZON && (
        <p className="mt-4 text-center text-xs leading-relaxed text-neutral-400">
          Long horizons assume current recurring patterns continue unchanged.
          Pay rises, rent reviews, subscription changes, and unexpected costs
          are not modeled.
        </p>
      )}
    </section>
  );
}

function HorizonPicker({
  horizon,
  onChange,
}: {
  horizon: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3">
      <label
        htmlFor="what-if-horizon"
        className="text-xs font-medium tracking-wide text-neutral-500 uppercase"
      >
        Horizon
      </label>
      <select
        id="what-if-horizon"
        value={horizon}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-neutral-800 focus:border-neutral-500 focus:outline-none"
      >
        {HORIZON_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ForecastBlock({
  label,
  result,
  delta,
}: {
  label: string;
  result: ForecastResult;
  delta?: number;
}) {
  const showDelta = delta !== undefined && Math.abs(delta) >= 1;
  const deltaClass = !showDelta
    ? ""
    : delta! > 0
      ? "text-emerald-600"
      : "text-red-600";
  return (
    <div className="rounded-md border border-stone-200 bg-white px-5 py-5">
      <div className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </div>
      <div className="mt-1 text-xs text-neutral-500">Lowest</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-neutral-900">
        {moneyFormatter.format(result.lowestPoint.balance)}
      </div>
      <div className="mt-1 text-xs text-neutral-500">
        on {dateFormatter.format(new Date(result.lowestPoint.date + "T00:00:00Z"))}
      </div>
      {showDelta && (
        <div className={`mt-3 text-sm font-medium tabular-nums ${deltaClass}`}>
          {delta! > 0 ? "+" : "−"}
          {moneyFormatter.format(Math.abs(delta!))} {delta! > 0 ? "better" : "worse"}
        </div>
      )}
    </div>
  );
}

function CycleComparison({
  baseline,
  hypothetical,
}: {
  baseline: ForecastResult;
  hypothetical: ForecastResult;
}) {
  const rows = baseline.cycles.map((b, i) => {
    const h = hypothetical.cycles[i];
    const baseEnd = b.lifeAdjustedEndingBalance;
    const hypEnd = h?.lifeAdjustedEndingBalance ?? baseEnd;
    return {
      index: i + 1,
      base: baseEnd,
      hyp: hypEnd,
      delta: hypEnd - baseEnd,
    };
  });

  return (
    <div className="mt-6 rounded-md border border-stone-200 bg-white px-5 py-4">
      <div className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        Cycle by cycle
      </div>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => {
          const noChange = Math.abs(r.delta) < 1;
          const deltaClass = noChange
            ? "text-neutral-400"
            : r.delta > 0
              ? "text-emerald-600"
              : "text-red-600";
          const deltaText = noChange
            ? "no change"
            : (r.delta > 0 ? "+" : "−") +
              moneyFormatter.format(Math.abs(r.delta));
          return (
            <li
              key={r.index}
              className="flex items-baseline justify-between gap-3 text-sm tabular-nums"
            >
              <span className="text-neutral-600">Cycle {r.index}</span>
              <span className="flex-1 text-right text-neutral-700">
                {moneyFormatter.format(r.base)}
                <span className="mx-2 text-neutral-400">→</span>
                {moneyFormatter.format(r.hyp)}
                <span className={`ml-3 ${deltaClass}`}>({deltaText})</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections / list rows
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

interface ItemListProps {
  items: ScenarioListItem[];
  scenario: Scenario;
  onToggleManual: (id: number) => void;
  onToggleStream: (streamId: string) => void;
  onSetOverride: (key: string, amount: number | null) => void;
  emptyMessage: string;
}

function ItemList({
  items,
  scenario,
  onToggleManual,
  onToggleStream,
  onSetOverride,
  emptyMessage,
}: ItemListProps) {
  if (items.length === 0) {
    return <p className="text-sm text-neutral-500">{emptyMessage}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((it) => {
        const disabled =
          it.source === "manual"
            ? scenario.disabledManualBillIds.includes(it.manualId!)
            : scenario.disabledStreamKeys.includes(it.streamKey!);
        const override = scenario.amountOverrides[it.key];
        const effectiveAmount = override ?? it.amount;
        return (
          <ItemRow
            key={it.key}
            item={it}
            disabled={disabled}
            effectiveAmount={effectiveAmount}
            edited={override !== undefined}
            onToggle={() =>
              it.source === "manual"
                ? onToggleManual(it.manualId!)
                : onToggleStream(it.streamKey!)
            }
            onSaveOverride={(amount) => onSetOverride(it.key, amount)}
            onClearOverride={() => onSetOverride(it.key, null)}
          />
        );
      })}
    </ul>
  );
}

function ItemRow({
  item,
  disabled,
  effectiveAmount,
  edited,
  onToggle,
  onSaveOverride,
  onClearOverride,
}: {
  item: ScenarioListItem;
  disabled: boolean;
  effectiveAmount: number;
  edited: boolean;
  onToggle: () => void;
  onSaveOverride: (amount: number) => void;
  onClearOverride: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(effectiveAmount.toFixed(2)));
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the editor in sync if the underlying amount changes while not
  // actively editing (e.g. after a Reset wipes the override).
  useEffect(() => {
    if (!editing) setDraft(String(effectiveAmount.toFixed(2)));
  }, [effectiveAmount, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitDraft = () => {
    const n = Number.parseFloat(draft);
    if (Number.isFinite(n) && n >= 0) {
      onSaveOverride(n);
    }
    setEditing(false);
  };

  const cancelDraft = () => {
    setDraft(String(effectiveAmount.toFixed(2)));
    setEditing(false);
  };

  return (
    <li
      className={`flex items-center gap-3 rounded-md border border-stone-200 bg-white px-4 py-3 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={!disabled}
        onChange={onToggle}
        className="h-4 w-4 rounded border-stone-300 text-neutral-800 focus:ring-neutral-400"
        aria-label={disabled ? `Re-enable ${item.name}` : `Disable ${item.name}`}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-sm ${
            disabled ? "text-neutral-500 line-through" : "text-neutral-800"
          }`}
        >
          {item.name}
        </div>
      </div>
      {editing ? (
        <div className="flex items-center gap-1">
          <span className="text-sm text-neutral-500">$</span>
          <input
            ref={inputRef}
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
              else if (e.key === "Escape") cancelDraft();
            }}
            className="w-20 rounded border border-stone-300 px-2 py-1 text-right text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
          />
        </div>
      ) : (
        <div className="flex items-baseline gap-2">
          <span
            className={`text-sm tabular-nums ${
              edited ? "font-semibold text-neutral-900" : "text-neutral-700"
            }`}
          >
            {moneyFormatterCents.format(effectiveAmount)}
          </span>
          <span className="text-xs text-neutral-500">
            / {humaniseFrequency(item.frequency)}
          </span>
        </div>
      )}
      {!editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
        >
          edit
        </button>
      )}
      {edited && !editing && (
        <button
          type="button"
          onClick={onClearOverride}
          className="text-xs text-neutral-400 underline-offset-2 hover:text-neutral-700 hover:underline"
          aria-label={`Clear amount override for ${item.name}`}
        >
          reset
        </button>
      )}
    </li>
  );
}

/** Map raw frequency strings (Plaid uses UPPER, manual uses lower) to a short label. */
function humaniseFrequency(f: string): string {
  const lower = f.toLowerCase();
  if (lower === "biweekly" || lower === "fortnightly") return "fortnight";
  if (lower === "weekly") return "week";
  if (lower === "monthly") return "month";
  if (lower === "bi-monthly") return "2 months";
  if (lower === "quarterly") return "quarter";
  if (lower === "annually" || lower === "yearly") return "year";
  return lower;
}

// ---------------------------------------------------------------------------
// Hypothetical bills — list + inline add form
// ---------------------------------------------------------------------------

function HypotheticalsList({
  hypotheticals,
  onAdd,
  onRemove,
}: {
  hypotheticals: HypotheticalBill[];
  onAdd: (h: HypotheticalBill) => void;
  onRemove: (tempId: string) => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      {hypotheticals.length === 0 && !adding && (
        <p className="text-sm text-neutral-500">No hypothetical bills yet.</p>
      )}

      {hypotheticals.length > 0 && (
        <ul className="space-y-2">
          {hypotheticals.map((h) => (
            <li
              key={h.tempId}
              className="flex items-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50 px-4 py-3"
            >
              <div className="flex h-4 w-4 items-center justify-center text-neutral-500">
                +
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-800">{h.name}</div>
                <div className="text-xs text-neutral-500">
                  {h.frequency === "monthly"
                    ? `monthly, day ${h.dayOfMonth ?? "?"}`
                    : `${h.frequency}, starting ${h.nextDueDate ?? "?"}`}
                </div>
              </div>
              <span className="text-sm tabular-nums text-neutral-700">
                {moneyFormatterCents.format(h.amount)}
              </span>
              <button
                type="button"
                onClick={() => onRemove(h.tempId)}
                className="text-xs text-neutral-400 underline-offset-2 hover:text-red-600 hover:underline"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <HypotheticalForm
          onCancel={() => setAdding(false)}
          onSubmit={(h) => {
            onAdd(h);
            setAdding(false);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
        >
          + Add hypothetical bill
        </button>
      )}
    </div>
  );
}

function HypotheticalForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (h: HypotheticalBill) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<HypotheticalFrequency>("monthly");
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const amt = Number.parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Amount must be a positive number.");
      return;
    }
    if (frequency === "monthly") {
      const d = Number.parseInt(dayOfMonth, 10);
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        setError("Day of month must be between 1 and 31.");
        return;
      }
      onSubmit({
        tempId: cryptoRandomId(),
        name: name.trim(),
        amount: amt,
        frequency,
        dayOfMonth: d,
      });
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) {
        setError("Next due date is required (YYYY-MM-DD).");
        return;
      }
      onSubmit({
        tempId: cryptoRandomId(),
        name: name.trim(),
        amount: amt,
        frequency,
        nextDueDate,
      });
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-stone-300 bg-white p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Gym membership"
            className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
        </Field>
        <Field label="Amount">
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 39.95"
            className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
          />
        </Field>
        <Field label="Frequency">
          <select
            value={frequency}
            onChange={(e) =>
              setFrequency(e.target.value as HypotheticalFrequency)
            }
            className="w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          >
            <option value="monthly">Monthly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="weekly">Weekly</option>
            <option value="bi-monthly">Bi-monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
        </Field>
        {frequency === "monthly" ? (
          <Field label="Day of month">
            <input
              type="number"
              min="1"
              max="31"
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
            />
          </Field>
        ) : (
          <Field label="Next due date">
            <input
              type="date"
              value={nextDueDate}
              onChange={(e) => setNextDueDate(e.target.value)}
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
            />
          </Field>
        )}
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 hover:text-neutral-900"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          className="rounded border border-neutral-800 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-900"
        >
          Add bill
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-500">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmptyScenario(s: Scenario): boolean {
  return (
    s.disabledManualBillIds.length === 0 &&
    s.disabledStreamKeys.length === 0 &&
    Object.keys(s.amountOverrides).length === 0 &&
    s.hypotheticalBills.length === 0
  );
}

/**
 * `crypto.randomUUID` is widely available in browsers we target. Falls back
 * to a timestamp+random combo for old browsers / SSR — temp IDs only need to
 * be unique within the current session, never persisted.
 */
function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
