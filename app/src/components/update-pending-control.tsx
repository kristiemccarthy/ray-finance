"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ImageUp } from "lucide-react";
import type { UpdatePendingResult } from "@/app/actions";

// ---------------------------------------------------------------------------
// Hidden-file-input button.
//
// Mirrors the visual + lifecycle pattern of `RefreshDataControl` so the two
// buttons sitting in the bills page header look like a pair. The trick is
// that browsers won't let you label a file input or trigger one without a
// real <input type=file>, so we render a visually-hidden one and click it
// from the visible button.
//
// Toast styling is intentionally identical to the refresh toast — same
// position, same fade timing, same colour bucket — because the two are
// alternatives, not parallel signals.
// ---------------------------------------------------------------------------

type NoticeKind = "success" | "info" | "error";

interface Notice {
  kind: NoticeKind;
  text: string;
}

const VISIBLE_MS = 5000;
const FADE_MS = 400;

const KIND_CLASSES: Record<NoticeKind, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  info: "border-stone-200 bg-white text-neutral-700",
  error: "border-red-200 bg-red-50 text-red-800",
};

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

export function UpdatePendingControl({
  action,
}: {
  action: (formData: FormData) => Promise<UpdatePendingResult>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [leaving, setLeaving] = useState(false);

  function pickFile(): void {
    inputRef.current?.click();
  }

  function onChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Reset the input so the same file can be picked again later — file
    // inputs only fire `change` when the value actually changes.
    event.target.value = "";
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    startTransition(async () => {
      try {
        const result = await action(formData);
        setNotice(buildNotice(result));
        setLeaving(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({
          kind: "error",
          text: `Couldn't read screenshot. ${message}`,
        });
        setLeaving(false);
      }
    });
  }

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
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={onChange}
        className="hidden"
        aria-hidden
      />
      <button
        type="button"
        onClick={pickFile}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-sm transition-colors hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <ImageUp
          className={`h-3.5 w-3.5 ${pending ? "animate-pulse" : ""}`}
          strokeWidth={1.75}
        />
        {pending ? "Extracting…" : "Update pending"}
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

function buildNotice(result: UpdatePendingResult): Notice {
  if (!result.ok) {
    return {
      kind: "error",
      text: `Couldn't read screenshot. ${result.error}`,
    };
  }
  const { total, count } = result.summary;
  if (count === 0) {
    return {
      kind: "info",
      text: "No pending transactions found in the screenshot.",
    };
  }
  const noun = count === 1 ? "transaction" : "transactions";
  return {
    kind: "success",
    text: `Pending updated: ${moneyFormatter.format(total)} across ${count} ${noun}.`,
  };
}
