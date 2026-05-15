"use client";

import { useEffect, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import type { RefreshSummary } from "@ray/csv-import/refresh";

// ---------------------------------------------------------------------------
// Button + ephemeral toast.
//
// Owns its own state because both pieces share a `notice` lifecycle: trigger
// the server action, render the result, then fade out a few seconds later.
// Renders the button inline (wherever the caller drops it) and the toast as
// a fixed-position banner near the top of the viewport, so the visual
// surface doesn't fight with the page header for space.
// ---------------------------------------------------------------------------

type NoticeKind = "success" | "info" | "error";

interface Notice {
  kind: NoticeKind;
  text: string;
}

// 5 s of full visibility, then a 400 ms opacity fade. Long enough to read,
// short enough that it doesn't outstay its welcome when refreshes are quick.
const VISIBLE_MS = 5000;
const FADE_MS = 400;

const KIND_CLASSES: Record<NoticeKind, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  info: "border-stone-200 bg-white text-neutral-700",
  error: "border-red-200 bg-red-50 text-red-800",
};

export function RefreshDataControl({
  action,
}: {
  action: () => Promise<RefreshSummary>;
}) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [leaving, setLeaving] = useState(false);

  function trigger(): void {
    startTransition(async () => {
      try {
        const summary = await action();
        setNotice(buildNotice(summary));
        setLeaving(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ kind: "error", text: `Refresh failed: ${message}` });
        setLeaving(false);
      }
    });
  }

  // Hold the notice for VISIBLE_MS, fade for FADE_MS, then unmount. Both
  // timers re-key on every new notice so a follow-up refresh doesn't cut
  // its predecessor's fade short.
  useEffect(() => {
    if (!notice) return;
    const fadeTimer = setTimeout(() => setLeaving(true), VISIBLE_MS);
    const removeTimer = setTimeout(() => {
      setNotice(null);
      setLeaving(false);
    }, VISIBLE_MS + FADE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, [notice]);

  return (
    <>
      <button
        type="button"
        onClick={trigger}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-sm transition-colors hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`}
          strokeWidth={1.75}
        />
        {pending ? "Refreshing…" : "Refresh data"}
      </button>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed left-1/2 top-4 z-50 max-w-[min(90vw,32rem)] -translate-x-1/2 rounded-md border px-4 py-2 text-sm shadow-sm transition-opacity duration-300 ${
            KIND_CLASSES[notice.kind]
          } ${leaving ? "opacity-0" : "opacity-100"}`}
        >
          {notice.text}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Summary → notice text
// ---------------------------------------------------------------------------

function buildNotice(summary: RefreshSummary): Notice {
  const time = formatLocalTime(summary.ranAt);

  // Errors win regardless of partial success — surface the failure so the
  // user knows something needs attention.
  if (summary.filesFailed > 0) {
    const failed = summary.details.filter((d) => !d.ok);
    const detail = failed.map((d) => `${d.label} (${d.error ?? "unknown"})`).join("; ");
    return {
      kind: "error",
      text: `Refreshed with errors at ${time}: ${detail}`,
    };
  }

  if (summary.filesAttempted === 0) {
    return {
      kind: "info",
      text: "No statement files found in the downloads directory.",
    };
  }

  if (summary.transactionsAdded === 0) {
    const noun = summary.filesAttempted === 1 ? "file" : "files";
    return {
      kind: "info",
      text: `Already up to date — checked ${summary.filesAttempted} ${noun} at ${time}.`,
    };
  }

  const txNoun = summary.transactionsAdded === 1 ? "transaction" : "transactions";
  const fileNoun = summary.filesSucceeded === 1 ? "source" : "sources";
  return {
    kind: "success",
    text: `Refreshed at ${time} — ${summary.transactionsAdded} new ${txNoun} imported across ${summary.filesSucceeded} ${fileNoun}.`,
  };
}

/**
 * Render the ISO timestamp from the server as the user's local time, like
 * "5:42pm". Lowercase am/pm matches the rest of the app's typography.
 * This only runs client-side (component is `"use client"`), so SSR vs
 * browser timezone divergence isn't a concern.
 */
function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  let hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${hours}:${mins}${ampm}`;
}
