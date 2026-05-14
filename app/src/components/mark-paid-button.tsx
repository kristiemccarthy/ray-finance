"use client";

import { useTransition } from "react";

export function MarkPaidButton({ action }: { action: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => action())}
      className="shrink-0 text-xs text-neutral-400 underline-offset-2 hover:text-neutral-700 hover:underline disabled:opacity-50"
    >
      {pending ? "Marking…" : "Mark paid"}
    </button>
  );
}
