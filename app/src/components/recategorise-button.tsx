"use client";

import { useState, useTransition } from "react";
import type { RecategoriseResultPayload } from "@/app/actions";

// ---------------------------------------------------------------------------
// "Recategorise everything" client control.
//
// One-shot button that calls the bulk re-categoriser server action. While
// pending, the label flips to "Recategorising…"; on completion an inline
// summary appears next to the button ("Updated X of Y transactions"). The
// result is intentionally not a toast — the user came to the settings
// page to do this, so the answer belongs on the same screen.
// ---------------------------------------------------------------------------

interface Props {
  action: () => Promise<RecategoriseResultPayload>;
}

export function RecategoriseButton({ action }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RecategoriseResultPayload | null>(null);

  const run = () => {
    setResult(null);
    startTransition(async () => {
      const r = await action();
      setResult(r);
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="self-start rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 disabled:opacity-50"
      >
        {pending ? "Recategorising…" : "Recategorise everything"}
      </button>
      {result && !pending && (
        <p
          className={`text-xs ${
            result.ok
              ? result.changed > 0
                ? "text-emerald-700"
                : "text-neutral-500"
              : "text-red-600"
          }`}
        >
          {result.ok
            ? result.changed === 0
              ? `Nothing changed. ${result.scanned} ${result.scanned === 1 ? "row" : "rows"} were already up to date.`
              : `Updated ${result.changed} of ${result.scanned} ${result.scanned === 1 ? "row" : "rows"}.`
            : `Couldn't recategorise. ${result.error}`}
        </p>
      )}
    </div>
  );
}
