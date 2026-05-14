"use client";

import { useState, useTransition } from "react";

/**
 * Two-step inline delete. First click swaps the row into a "Confirm / Cancel"
 * state — second click runs the server action. No native confirm() dialog;
 * the affordance lives in the row.
 */
export function DeleteBillButton({ action }: { action: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="text-sm text-neutral-400 underline-offset-2 hover:text-red-600 hover:underline"
      >
        Delete
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => action())}
        className="text-sm font-medium text-red-600 underline-offset-2 hover:underline disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Confirm"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setArmed(false)}
        className="text-sm text-neutral-400 hover:text-neutral-800"
      >
        Cancel
      </button>
    </div>
  );
}
