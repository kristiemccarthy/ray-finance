"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type {
  CategoryRuleFormState,
  CategoryRuleFormValues,
} from "@/app/actions";
import {
  CATEGORY_OPTIONS,
  FLOW_TYPE_OPTIONS,
} from "@/app/settings/categories/form-values";

// ---------------------------------------------------------------------------
// Add / Edit form for a category-override rule. Mirrors the bill-form and
// goal-form patterns — same `useActionState` cadence, same field/error
// primitives, so the three forms feel like one family.
// ---------------------------------------------------------------------------

type CategoryRuleFormAction = (
  state: CategoryRuleFormState,
  formData: FormData,
) => Promise<CategoryRuleFormState>;

export const EMPTY_CATEGORY_RULE_FORM_VALUES: CategoryRuleFormValues = {
  pattern: "",
  category: "",
  subcategory: "",
  note: "",
  flowType: "",
  // Default to "rule sets a category" — matches the existing form's
  // pre-flow-type behaviour. Users can uncheck to make a flow-type-only
  // rule (e.g. "INTERNET DEPOSIT FROM" → INTERNAL_TRANSFER without
  // touching the row's category).
  setCategory: "1",
};

interface Props {
  action: CategoryRuleFormAction;
  initialValues: CategoryRuleFormValues;
  submitLabel: string;
}

export function CategoryRuleForm({
  action,
  initialValues,
  submitLabel,
}: Props) {
  const [state, formAction, pending] = useActionState<
    CategoryRuleFormState,
    FormData
  >(action, { values: initialValues });
  const v: CategoryRuleFormValues = state.values ?? initialValues;
  const errors = state.errors ?? {};

  // `setCategory` drives the conditional disabling of the category
  // dropdown, so it has to be controlled. Initialise from the form
  // state (which carries the most recent submission's choice).
  const [setCategory, setSetCategory] = useState<boolean>(v.setCategory !== "0");
  const [flowType, setFlowType] = useState<string>(v.flowType ?? "");

  const selectedFlowHint = FLOW_TYPE_OPTIONS.find((f) => f.value === flowType)?.hint;

  return (
    <form action={formAction} className="space-y-6">
      <Field
        label="Pattern"
        htmlFor="pattern"
        error={errors.pattern}
        hint="Case-insensitive substring matched against the transaction's merchant name OR raw bank descriptor."
      >
        <input
          id="pattern"
          name="pattern"
          type="text"
          required
          defaultValue={v.pattern}
          className={inputClass(!!errors.pattern)}
          placeholder="e.g. DAN MURPHY"
          autoComplete="off"
        />
      </Field>

      <div>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="setCategory"
            value="1"
            checked={setCategory}
            onChange={(e) => setSetCategory(e.target.checked)}
            className="mt-1 h-4 w-4 accent-neutral-800"
          />
          <span>
            <span className="block text-sm font-medium text-neutral-800">
              Set category
            </span>
            <span className="block text-xs text-neutral-500">
              When unchecked, the rule only sets the flow type — useful for
              descriptors like "Internet Deposit From …" that need to be
              tagged as transfers without changing their category.
            </span>
          </span>
        </label>
      </div>

      <Field label="Category" htmlFor="category" error={errors.category}>
        <select
          id="category"
          name="category"
          defaultValue={v.category}
          disabled={!setCategory}
          className={`${inputClass(!!errors.category)} ${setCategory ? "" : "opacity-50 cursor-not-allowed"}`}
        >
          <option value="">Select a category…</option>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Subcategory (optional)"
        htmlFor="subcategory"
        error={errors.subcategory}
        hint="Optional refinement. Most rules leave this blank."
      >
        <input
          id="subcategory"
          name="subcategory"
          type="text"
          defaultValue={v.subcategory}
          disabled={!setCategory}
          className={`${inputClass(!!errors.subcategory)} ${setCategory ? "" : "opacity-50 cursor-not-allowed"}`}
          autoComplete="off"
        />
      </Field>

      <Field
        label="Flow type"
        htmlFor="flowType"
        error={errors.flowType}
        hint={
          selectedFlowHint ??
          "Optional. Leave as '(inherit from category)' to let the categoriser infer."
        }
      >
        <select
          id="flowType"
          name="flowType"
          value={flowType}
          onChange={(e) => setFlowType(e.target.value)}
          className={inputClass(!!errors.flowType)}
        >
          <option value="">(inherit from category)</option>
          {FLOW_TYPE_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Note (optional)"
        htmlFor="note"
        error={errors.note}
        hint="Why this rule exists — surfaces in the rules list to remind future-you."
      >
        <input
          id="note"
          name="note"
          type="text"
          defaultValue={v.note}
          className={inputClass(!!errors.note)}
          autoComplete="off"
        />
      </Field>

      <div className="flex items-center gap-4 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-800 px-5 py-3 text-sm font-medium text-stone-50 hover:bg-neutral-900 disabled:opacity-50"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        <Link
          href="/settings/categories"
          className="text-sm text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-2 block text-xs font-medium tracking-wide text-neutral-500 uppercase"
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <p className="mt-1 text-xs text-neutral-400">{hint}</p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function inputClass(hasError: boolean): string {
  const base =
    "w-full rounded-md border bg-white px-3 py-3 text-base text-neutral-900 focus:border-neutral-500 focus:outline-none";
  return hasError
    ? `${base} border-red-400 focus:border-red-500`
    : `${base} border-stone-300`;
}
