"use client";

import { useState, useTransition } from "react";
import type { AddContributionResult } from "@/app/actions";

// ---------------------------------------------------------------------------
// Inline "+ Add contribution" affordance for ledger-mode goal cards.
//
// Collapsed by default — a single subtle button. Click to reveal an
// inline form (amount, date, optional note). The server action is bound
// to the goal id by the caller, so this component stays goal-agnostic.
//
// Errors surface in-place (no toast) so the user can correct the field
// they got wrong without losing context. On success the form collapses
// back to its initial state and Next's revalidation refreshes the card.
// ---------------------------------------------------------------------------

interface Props {
  /** Already bound to goalId by the page. */
  action: (formData: FormData) => Promise<AddContributionResult>;
}

function todayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    .toISOString()
    .slice(0, 10);
}

export function AddContributionForm({ action }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
      >
        + Add contribution
      </button>
    );
  }

  const handleSubmit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        setOpen(false);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form
      action={handleSubmit}
      className="space-y-3 rounded-md border border-stone-300 bg-white p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">
            Amount
          </span>
          <input
            name="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            required
            placeholder="e.g. 50"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">
            Date
          </span>
          <input
            name="contributionDate"
            type="date"
            required
            defaultValue={todayIso()}
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500">
            Note (optional)
          </span>
          <input
            name="note"
            type="text"
            placeholder="e.g. bonus split"
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
        </label>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-neutral-800 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-900 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save contribution"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setOpen(false);
          }}
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
