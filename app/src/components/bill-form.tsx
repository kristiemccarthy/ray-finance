"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type {
  BillFormState,
  BillFormValues,
  BillFrequency,
  AmountType,
} from "@/app/actions";

type BillFormAction = (
  state: BillFormState,
  formData: FormData,
) => Promise<BillFormState>;

export const EMPTY_BILL_FORM_VALUES: BillFormValues = {
  name: "",
  amountType: "fixed",
  amount: "",
  amountMin: "",
  amountMax: "",
  frequency: "monthly",
  dayOfMonth: "",
  nextDueDate: "",
  type: "",
  accountId: "",
};

export function BillForm({
  action,
  initialValues,
  submitLabel,
}: {
  action: BillFormAction;
  initialValues: BillFormValues;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState<BillFormState, FormData>(
    action,
    { values: initialValues },
  );
  const v: BillFormValues = state.values ?? initialValues;
  const errors = state.errors ?? {};

  // Controlled state only for the discriminator fields — they drive
  // conditional rendering, so they need to be in React state, not just
  // form fields. Re-keyed off the server state version so the submitted
  // selection persists if validation bounces the form back.
  const [amountType, setAmountType] = useState<AmountType>(v.amountType);
  const [frequency, setFrequency] = useState<BillFrequency>(v.frequency);

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
        />
      </Field>

      <fieldset>
        <legend className="mb-2 block text-xs font-medium tracking-wide text-neutral-500 uppercase">
          Amount
        </legend>
        <div className="flex gap-4 text-sm text-neutral-700">
          <RadioOption
            name="amountType"
            value="fixed"
            label="Fixed"
            checked={amountType === "fixed"}
            onChange={() => setAmountType("fixed")}
          />
          <RadioOption
            name="amountType"
            value="range"
            label="Range"
            checked={amountType === "range"}
            onChange={() => setAmountType("range")}
          />
        </div>

        {amountType === "fixed" ? (
          <div className="mt-3">
            <input
              id="amount"
              name="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              defaultValue={v.amount}
              className={inputClass(!!errors.amount)}
              placeholder="e.g. 49.95"
            />
            {errors.amount && (
              <p className="mt-1 text-xs text-red-600">{errors.amount}</p>
            )}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="amountMin" className="block text-xs text-neutral-500">
                Min
              </label>
              <input
                id="amountMin"
                name="amountMin"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                defaultValue={v.amountMin}
                className={inputClass(!!errors.amountMin)}
                placeholder="200"
              />
              {errors.amountMin && (
                <p className="mt-1 text-xs text-red-600">{errors.amountMin}</p>
              )}
            </div>
            <div>
              <label htmlFor="amountMax" className="block text-xs text-neutral-500">
                Max
              </label>
              <input
                id="amountMax"
                name="amountMax"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                defaultValue={v.amountMax}
                className={inputClass(!!errors.amountMax)}
                placeholder="280"
              />
              {errors.amountMax && (
                <p className="mt-1 text-xs text-red-600">{errors.amountMax}</p>
              )}
            </div>
            <p className="col-span-2 text-xs text-neutral-400">
              Stored as the midpoint. The display name gets the range appended,
              e.g. <span className="font-mono">Arc Energy ($200-$280)</span>.
            </p>
          </div>
        )}
      </fieldset>

      <Field label="Frequency" htmlFor="frequency">
        <select
          id="frequency"
          name="frequency"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as BillFrequency)}
          className={inputClass(false)}
        >
          <option value="monthly">Monthly</option>
          <option value="fortnightly">Fortnightly</option>
          <option value="weekly">Weekly</option>
        </select>
      </Field>

      {frequency === "monthly" ? (
        <Field
          label="Day of month"
          htmlFor="dayOfMonth"
          error={errors.dayOfMonth}
          hint="1–31. Clamps to the last day of the month for shorter months."
        >
          <input
            id="dayOfMonth"
            name="dayOfMonth"
            type="number"
            inputMode="numeric"
            min="1"
            max="31"
            defaultValue={v.dayOfMonth}
            className={inputClass(!!errors.dayOfMonth)}
            placeholder="15"
          />
        </Field>
      ) : (
        <Field
          label="Next due date"
          htmlFor="nextDueDate"
          error={errors.nextDueDate}
          hint="The next time this bill is due. Future occurrences will step from here."
        >
          <input
            id="nextDueDate"
            name="nextDueDate"
            type="date"
            defaultValue={v.nextDueDate}
            className={inputClass(!!errors.nextDueDate)}
          />
        </Field>
      )}

      <Field
        label="Type (optional)"
        htmlFor="type"
        hint="Used for categorisation later. Defaults to 'manual'."
      >
        <input
          id="type"
          name="type"
          type="text"
          defaultValue={v.type}
          className={inputClass(false)}
          placeholder="utility, subscription, …"
          autoComplete="off"
        />
      </Field>

      <Field
        label="Account ID (optional)"
        htmlFor="accountId"
        hint="Plaid-style account_id this bill is paid from. Blank for any."
      >
        <input
          id="accountId"
          name="accountId"
          type="text"
          defaultValue={v.accountId}
          className={inputClass(false)}
          placeholder="csv:st-george:personal"
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
          href="/bills/manage"
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

function inputClass(hasError: boolean): string {
  const base =
    "w-full rounded-md border bg-white px-3 py-3 text-base text-neutral-900 focus:border-neutral-500 focus:outline-none";
  return hasError
    ? `${base} border-red-400 focus:border-red-500`
    : `${base} border-stone-300`;
}
