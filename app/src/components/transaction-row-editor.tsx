"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { ChevronRight } from "lucide-react";
import {
  CATEGORY_OPTIONS,
  FLOW_TYPE_OPTIONS,
} from "@/app/settings/categories/form-values";
import type { TransactionOverrideResult } from "@/app/actions";

// ---------------------------------------------------------------------------
// One row of the transaction inspector. Collapsed by default — click to
// reveal inline editors for category and flow_type.
//
// Save semantics (the "two flags, single Save" question, resolved):
//   - The form remembers the row's values at the moment it was expanded.
//   - On submit, only the fields the user actually changed are sent
//     through. The server action's `setTransactionOverride` flips
//     `manual_category` / `manual_flow_type` only for the fields it
//     receives, so editing only the flow_type doesn't accidentally lock
//     the category from future rule passes.
// ---------------------------------------------------------------------------

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

const shortDateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

export interface TransactionAccount {
  account_id: string;
  name: string;
}

export interface TransactionRowData {
  transaction_id: string;
  date: string;
  display_name: string;
  raw_name: string | null;
  amount: number;
  category: string | null;
  subcategory: string | null;
  flow_type: string | null;
  manual_category: number;
  manual_flow_type: number;
  account_id: string;
}

interface Props {
  row: TransactionRowData;
  setOverrideAction: (
    transactionId: string,
    input: { category?: string; subcategory?: string; flowType?: string },
  ) => Promise<TransactionOverrideResult>;
  clearOverrideAction: (
    transactionId: string,
  ) => Promise<TransactionOverrideResult>;
}

const categoryLabelMap = new Map(CATEGORY_OPTIONS.map((c) => [c.value, c.label]));
const flowTypeLabelMap = new Map(FLOW_TYPE_OPTIONS.map((f) => [f.value, f.label]));

function categoryLabel(value: string | null): string {
  if (!value) return "—";
  return categoryLabelMap.get(value) ?? value;
}

function flowTypeLabel(value: string | null): string {
  if (!value) return "—";
  return flowTypeLabelMap.get(value) ?? value;
}

export function TransactionRowEditor({
  row,
  setOverrideAction,
  clearOverrideAction,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Snapshot the row's original values when the editor opens so the save
  // path can tell which fields the user actually changed.
  const original = useMemo(
    () => ({
      category: row.category ?? "",
      subcategory: row.subcategory ?? "",
      flowType: row.flow_type ?? "",
    }),
    [row.category, row.subcategory, row.flow_type],
  );

  const [category, setCategory] = useState(original.category);
  const [flowType, setFlowType] = useState(original.flowType);

  const ruleHref = `/settings/categories/new?pattern=${encodeURIComponent(
    (row.raw_name ?? row.display_name).toUpperCase(),
  )}`;

  const dateLabel = shortDateFormatter.format(
    new Date(row.date + "T00:00:00Z"),
  );
  const amountClass = row.amount > 0 ? "text-neutral-900" : "text-emerald-700";

  const handleSave = () => {
    setError(null);
    const input: { category?: string; subcategory?: string; flowType?: string } = {};
    if (category !== original.category) {
      input.category = category;
      // Also send subcategory through when category is being changed —
      // keeps the row's subcategory in sync (clear vs preserve handled
      // server-side; we just pass the current value).
      input.subcategory = row.subcategory ?? "";
    }
    if (flowType !== original.flowType) {
      input.flowType = flowType;
    }
    if (Object.keys(input).length === 0) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const result = await setOverrideAction(row.transaction_id, input);
      if (result.ok) {
        setOpen(false);
      } else {
        setError(result.error);
      }
    });
  };

  const handleReset = () => {
    setError(null);
    startTransition(async () => {
      const result = await clearOverrideAction(row.transaction_id);
      if (result.ok) {
        setOpen(false);
        // Local state will refresh on next navigation — but reflect the
        // reset visually in case the user re-opens before that.
        setCategory(row.category ?? "");
        setFlowType(row.flow_type ?? "");
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <li className="border-b border-stone-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-stone-50"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform ${open ? "rotate-90" : ""}`}
          strokeWidth={2}
        />
        <span className="w-20 shrink-0 text-xs tabular-nums text-neutral-500">
          {dateLabel}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
          {row.display_name}
        </span>
        <span className={`w-24 shrink-0 text-right text-sm tabular-nums ${amountClass}`}>
          {row.amount > 0 ? "" : "+"}
          {moneyFormatter.format(Math.abs(row.amount))}
        </span>
        <span className="w-32 shrink-0 truncate text-right text-xs text-neutral-600">
          {categoryLabel(row.category)}
          {row.manual_category ? (
            <span className="ml-1 text-amber-600" title="Manually overridden">
              •
            </span>
          ) : null}
        </span>
        <span className="w-32 shrink-0 truncate text-right text-xs text-neutral-500">
          {flowTypeLabel(row.flow_type)}
          {row.manual_flow_type ? (
            <span className="ml-1 text-amber-600" title="Manually overridden">
              •
            </span>
          ) : null}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-stone-100 bg-stone-50 px-5 py-4 text-sm">
          {row.raw_name && row.raw_name !== row.display_name && (
            <div className="text-xs text-neutral-500">
              <span className="text-neutral-400">Raw:</span> {row.raw_name}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs font-medium text-neutral-500">
                Category
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
              >
                <option value="">(unchanged)</option>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-neutral-500">
                Flow type
              </span>
              <select
                value={flowType}
                onChange={(e) => setFlowType(e.target.value)}
                className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
              >
                <option value="">(unchanged)</option>
                {FLOW_TYPE_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link
              href={ruleHref}
              className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
            >
              Create rule from this transaction →
            </Link>
            <div className="flex items-center gap-3">
              {(row.manual_category || row.manual_flow_type) && (
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={pending}
                  className="text-xs text-neutral-500 underline-offset-2 hover:text-red-600 hover:underline disabled:opacity-50"
                >
                  Reset to automatic
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={pending}
                className="rounded border border-neutral-800 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-900 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save as manual override"}
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
