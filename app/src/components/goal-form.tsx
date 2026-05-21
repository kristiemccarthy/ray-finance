"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { GoalFormState, GoalFormValues } from "@/app/actions";
import type { GoalMode, GoalType } from "@ray/goals";

type GoalFormAction = (
  state: GoalFormState,
  formData: FormData,
) => Promise<GoalFormState>;

export const EMPTY_GOAL_FORM_VALUES: GoalFormValues = {
  type: "savings",
  mode: "balance",
  name: "",
  targetAmount: "",
  targetDate: "",
  accountId: "",
  category: "",
  includedBillIds: [],
};

export interface AccountOption {
  account_id: string;
  display: string;
}

export interface SubscriptionOption {
  /** Composite key — `manual:<id>` or `stream:<id>`. */
  key: string;
  name: string;
  amount: number;
  group: "manual" | "recurring";
  frequency: string;
}

const CATEGORY_OPTIONS = [
  { value: "FOOD_AND_DRINK", label: "Food & Drink" },
  { value: "MEDICAL", label: "Medical" },
  { value: "GENERAL_MERCHANDISE", label: "Shopping" },
  { value: "ENTERTAINMENT", label: "Entertainment" },
];

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

interface GoalFormProps {
  action: GoalFormAction;
  initialValues: GoalFormValues;
  submitLabel: string;
  accounts: AccountOption[];
  subscriptions: SubscriptionOption[];
}

export function GoalForm({
  action,
  initialValues,
  submitLabel,
  accounts,
  subscriptions,
}: GoalFormProps) {
  const [state, formAction, pending] = useActionState<GoalFormState, FormData>(
    action,
    { values: initialValues },
  );
  const v: GoalFormValues = state.values ?? initialValues;
  const errors = state.errors ?? {};

  // `type` drives conditional fields, so it needs to be controlled. `mode`
  // is conditionally rendered (savings only) — also controlled. Selected
  // subscriptions are also controlled — `getAll("includedBillIds")` collects
  // them at submit, but we need React state to render checked-ness.
  const [type, setType] = useState<GoalType>(v.type);
  const [mode, setMode] = useState<GoalMode>(v.mode);
  const [includedBillIds, setIncludedBillIds] = useState<string[]>(
    v.includedBillIds,
  );

  const toggleSubscription = (key: string) =>
    setIncludedBillIds((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  return (
    <form action={formAction} className="space-y-6">
      <Field label="Name" htmlFor="name" error={errors.name}>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={v.name}
          className={inputClass(!!errors.name)}
          autoComplete="off"
          placeholder="e.g. Holiday fund"
        />
      </Field>

      <fieldset>
        <legend className="mb-2 block text-xs font-medium tracking-wide text-neutral-500 uppercase">
          Type
        </legend>
        <div className="flex flex-col gap-2 text-sm text-neutral-700 sm:flex-row sm:gap-4">
          <RadioOption
            name="type"
            value="savings"
            label="Savings"
            checked={type === "savings"}
            onChange={() => setType("savings")}
          />
          <RadioOption
            name="type"
            value="category-cap"
            label="Category cap"
            checked={type === "category-cap"}
            onChange={() => setType("category-cap")}
          />
          <RadioOption
            name="type"
            value="subscription-cap"
            label="Subscription cap"
            checked={type === "subscription-cap"}
            onChange={() => setType("subscription-cap")}
          />
        </div>
      </fieldset>

      {type === "savings" && (
        <fieldset>
          <legend className="mb-2 block text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Mode
          </legend>
          <div className="space-y-2">
            <ModeOption
              value="balance"
              title="Balance mode"
              description="Goal progress = account balance"
              checked={mode === "balance"}
              onChange={() => setMode("balance")}
            />
            <ModeOption
              value="ledger"
              title="Ledger mode"
              description="Goal progress = my logged contributions"
              checked={mode === "ledger"}
              onChange={() => setMode("ledger")}
            />
          </div>
        </fieldset>
      )}
      {/* Always submit `mode` so non-savings goals still round-trip a sane
          default. Hidden when not savings; controlled in either case. */}
      {type !== "savings" && (
        <input type="hidden" name="mode" value="balance" />
      )}

      <Field
        label={amountLabel(type)}
        htmlFor="targetAmount"
        error={errors.targetAmount}
      >
        <input
          id="targetAmount"
          name="targetAmount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          defaultValue={v.targetAmount}
          className={inputClass(!!errors.targetAmount)}
          placeholder={amountPlaceholder(type)}
        />
      </Field>

      {type === "savings" && (
        <>
          <Field
            label="Target date"
            htmlFor="targetDate"
            error={errors.targetDate}
          >
            <input
              id="targetDate"
              name="targetDate"
              type="date"
              defaultValue={v.targetDate}
              className={inputClass(!!errors.targetDate)}
            />
          </Field>

          <Field
            label="Account"
            htmlFor="accountId"
            error={errors.accountId}
            hint="Goal progress is read from this account's current balance."
          >
            <select
              id="accountId"
              name="accountId"
              defaultValue={v.accountId}
              className={inputClass(!!errors.accountId)}
            >
              <option value="">Select an account…</option>
              {accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.display}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      {type === "category-cap" && (
        <Field label="Category" htmlFor="category" error={errors.category}>
          <select
            id="category"
            name="category"
            defaultValue={v.category}
            className={inputClass(!!errors.category)}
          >
            <option value="">Select a category…</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      {type === "subscription-cap" && (
        <SubscriptionPicker
          subscriptions={subscriptions}
          selected={includedBillIds}
          onToggle={toggleSubscription}
          error={errors.includedBillIds}
        />
      )}

      <div className="flex items-center gap-4 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-800 px-5 py-3 text-sm font-medium text-stone-50 hover:bg-neutral-900 disabled:opacity-50"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        <Link
          href="/goals"
          className="text-sm text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function amountLabel(type: GoalType): string {
  switch (type) {
    case "savings":
      return "Target amount";
    case "category-cap":
      return "Cap per pay cycle";
    case "subscription-cap":
      return "Cap per month";
  }
}

function amountPlaceholder(type: GoalType): string {
  switch (type) {
    case "savings":
      return "e.g. 3000";
    case "category-cap":
      return "e.g. 645";
    case "subscription-cap":
      return "e.g. 50";
  }
}

// ---------------------------------------------------------------------------
// Subscription picker
// ---------------------------------------------------------------------------

function SubscriptionPicker({
  subscriptions,
  selected,
  onToggle,
  error,
}: {
  subscriptions: SubscriptionOption[];
  selected: string[];
  onToggle: (key: string) => void;
  error?: string;
}) {
  // Split into two groups so the user can quickly tell which list a row
  // came from. Order: manual bills first (the user's intent is more direct),
  // then auto-detected streams.
  const manual = subscriptions.filter((s) => s.group === "manual");
  const recurring = subscriptions.filter((s) => s.group === "recurring");

  const totalSelected = selected
    .map((k) => subscriptions.find((s) => s.key === k))
    .filter((s): s is SubscriptionOption => Boolean(s))
    .reduce((sum, s) => sum + s.amount, 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          Included subscriptions
        </label>
        <span className="text-xs tabular-nums text-neutral-500">
          {selected.length} selected · {moneyFormatter.format(totalSelected)}
        </span>
      </div>

      {/* Hidden inputs mirror the React state so the server action receives
          `includedBillIds` from the form. Using a controlled hidden input
          avoids stale-checkbox issues during the in-flight optimistic UI. */}
      {selected.map((key) => (
        <input key={key} type="hidden" name="includedBillIds" value={key} />
      ))}

      <div className="space-y-4 rounded-md border border-stone-300 bg-white p-4">
        {manual.length > 0 && (
          <SubscriptionGroup
            label="Manual bills"
            items={manual}
            selected={selected}
            onToggle={onToggle}
          />
        )}
        {recurring.length > 0 && (
          <SubscriptionGroup
            label="Auto-detected subscriptions"
            items={recurring}
            selected={selected}
            onToggle={onToggle}
          />
        )}
        {manual.length === 0 && recurring.length === 0 && (
          <p className="text-sm text-neutral-500">
            No subscriptions on file yet. Add a recurring bill first.
          </p>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function SubscriptionGroup({
  label,
  items,
  selected,
  onToggle,
}: {
  label: string;
  items: SubscriptionOption[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => {
          const isSelected = selected.includes(item.key);
          return (
            <li key={item.key}>
              <label className="flex items-center gap-3 rounded px-1 py-1 hover:bg-stone-50">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(item.key)}
                  className="h-4 w-4 rounded border-stone-300 text-neutral-800 focus:ring-neutral-400"
                />
                <span className="flex-1 truncate text-sm text-neutral-800">
                  {item.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                  {moneyFormatter.format(item.amount)} / {item.frequency.toLowerCase()}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared form primitives — matched to bill-form.tsx for visual consistency
// ---------------------------------------------------------------------------

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

function RadioOption({
  name,
  value,
  label,
  checked,
  onChange,
}: {
  name: string;
  value: string;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="inline-flex items-center gap-2">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 accent-neutral-800"
      />
      {label}
    </label>
  );
}

/**
 * Block-style radio for the savings Mode picker — gives each option room
 * for its description without crowding the form. Uses the same accent
 * colour as `RadioOption` for visual consistency.
 */
function ModeOption({
  value,
  title,
  description,
  checked,
  onChange,
}: {
  value: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border bg-white px-4 py-3 ${
        checked ? "border-neutral-800" : "border-stone-300 hover:border-neutral-400"
      }`}
    >
      <input
        type="radio"
        name="mode"
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 accent-neutral-800"
      />
      <span>
        <span className="block text-sm font-medium text-neutral-800">
          {title}
        </span>
        <span className="block text-xs text-neutral-500">{description}</span>
      </span>
    </label>
  );
}

function inputClass(hasError: boolean): string {
  const base =
    "w-full rounded-md border bg-white px-3 py-3 text-base text-neutral-900 focus:border-neutral-500 focus:outline-none";
  return hasError
    ? `${base} border-red-400 focus:border-red-500`
    : `${base} border-stone-300`;
}
