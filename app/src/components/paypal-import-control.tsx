"use client";

import { useRef, useState, useTransition } from "react";
import type { ImportPaypalResult } from "@/app/actions";

// ---------------------------------------------------------------------------
// "Import PayPal" expandable panel.
//
// Lives in the corner of the bills view as a small link by default. Click
// it and an inline panel reveals the explainer + file picker. After
// upload, the same panel shows a four-line summary so the user can see
// what was imported / matched / ambiguous / unmatched without leaving
// the bills page.
//
// Errors render inline (no toast) since they tend to be specific
// ("download Completed Payments, not Account Activity") and worth
// reading.
// ---------------------------------------------------------------------------

interface Props {
  action: (formData: FormData) => Promise<ImportPaypalResult>;
}

export function PaypalImportControl({ action }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-center">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="text-xs text-neutral-400 underline-offset-2 hover:text-neutral-700 hover:underline"
      >
        {open ? "Close PayPal import" : "Import PayPal"}
      </button>
      {open && (
        <div className="mt-4">
          <PaypalImportPanel action={action} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function PaypalImportPanel({
  action,
  onDone,
}: {
  action: (formData: FormData) => Promise<ImportPaypalResult>;
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ImportPaypalResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  function onFile(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setFileName(file.name);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    startTransition(async () => {
      const res = await action(formData);
      setResult(res);
    });
  }

  return (
    <div className="mx-auto max-w-md rounded-md border border-stone-200 bg-white p-5 text-left text-sm text-neutral-700 shadow-sm">
      <h2 className="text-sm font-semibold text-neutral-900">
        Import PayPal transactions
      </h2>
      <p className="mt-2 text-xs text-neutral-500">
        PayPal hides the merchant behind opaque bank descriptors. Import the
        Completed Payments CSV to attach merchant names to the matching
        bank rows.
      </p>

      <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs text-neutral-600">
        <li>Log in to PayPal</li>
        <li>
          Activity → Statements → Download
        </li>
        <li>
          Select <span className="font-medium">Completed Payments</span> and
          a date range
        </li>
        <li>Save as CSV</li>
      </ol>

      <div className="mt-5 flex flex-col gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="hidden"
          aria-hidden
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={pending}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 disabled:opacity-50"
          >
            Choose file
          </button>
          <span className="truncate text-xs text-neutral-500">
            {fileName ?? "No file selected"}
          </span>
        </div>
        {pending && (
          <p className="text-xs text-neutral-500">Uploading and matching…</p>
        )}
      </div>

      {result && !pending && <ResultSummary result={result} />}

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function ResultSummary({ result }: { result: ImportPaypalResult }) {
  if (!result.ok) {
    return (
      <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
        Couldn't import. {result.error}
      </div>
    );
  }
  const { totalImported, matched, ambiguous, unmatched } = result.summary;
  return (
    <ul className="mt-4 space-y-1 rounded border border-stone-200 bg-stone-50 p-3 text-xs">
      <li className="text-emerald-700">
        ✓ Imported {totalImported}{" "}
        {totalImported === 1 ? "PayPal transaction" : "PayPal transactions"}
      </li>
      <li className="text-emerald-700">
        ✓ Matched {matched} to{" "}
        {matched === 1 ? "bank transaction" : "bank transactions"}
      </li>
      {ambiguous > 0 ? (
        <li className="text-amber-700">
          ⚠ {ambiguous}{" "}
          {ambiguous === 1 ? "was ambiguous" : "were ambiguous"} (skipped)
        </li>
      ) : (
        <li className="text-neutral-500">No ambiguous rows.</li>
      )}
      <li className="text-neutral-500">
        {unmatched} unmatched (likely one-offs or from earlier dates)
      </li>
    </ul>
  );
}
