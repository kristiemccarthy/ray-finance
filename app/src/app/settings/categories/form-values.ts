// ---------------------------------------------------------------------------
// Plain-TS module for the category-rule form's static data.
//
// Lives outside `app/src/app/actions.ts` because that file is marked
// "use server" — every export from there must be an async server action.
// Synchronous constants like the category dropdown list belong elsewhere.
//
// Consumed by:
//   - `category-rule-form.tsx` — the dropdown options
//   - `settings/categories/page.tsx` — label lookup for rendered rules
//   - `actions.ts` — derives the validator's VALID_CATEGORY_VALUES set
// ---------------------------------------------------------------------------

export interface CategoryOption {
  value: string;
  label: string;
}

/**
 * The full list of categories the rule-form dropdown offers. New
 * categories surface here. The PFC categoriser still accepts arbitrary
 * strings on the read-path, so unknown categories from old rows degrade
 * gracefully — they show up as their UPPER_CASE value in displays that
 * don't have a label override.
 */
export const CATEGORY_OPTIONS: CategoryOption[] = [
  { value: "FOOD_AND_DRINK", label: "Food & Drink" },
  { value: "MEDICAL", label: "Medical" },
  { value: "GENERAL_MERCHANDISE", label: "Shopping" },
  { value: "ENTERTAINMENT", label: "Entertainment" },
  { value: "ALCOHOL", label: "Alcohol" },
  { value: "PET_CARE", label: "Pet Care" },
  { value: "TRANSPORTATION", label: "Transportation" },
  { value: "TRAVEL", label: "Travel" },
  { value: "RENT_AND_UTILITIES", label: "Rent & Utilities" },
  { value: "GENERAL_SERVICES", label: "Services" },
  { value: "PERSONAL_CARE", label: "Personal Care" },
  { value: "HOME_IMPROVEMENT", label: "Home Improvement" },
  { value: "BANK_FEES", label: "Bank Fees" },
  { value: "INCOME", label: "Income" },
  { value: "LOAN_PAYMENTS", label: "Loan Payments" },
  { value: "TRANSFER_IN", label: "Transfer In" },
  { value: "TRANSFER_OUT", label: "Transfer Out" },
  { value: "OTHER", label: "Other" },
];

/** Set of valid category values, for server-side validation. */
export const VALID_CATEGORY_VALUES = new Set(
  CATEGORY_OPTIONS.map((c) => c.value),
);

export interface FlowTypeOption {
  value: string;
  label: string;
  /** Short hint shown below the dropdown when this option is selected. */
  hint: string;
}

/**
 * The six flow-type buckets. Order matches a natural top-to-bottom read:
 * earned income first, then internal/external/refund inflows, then the
 * two outflow types. The empty-string entry (renders as "(inherit from
 * category)") is a sentinel that tells the rule form to leave flow_type
 * NULL on the rule — i.e. the rule only writes category.
 */
export const FLOW_TYPE_OPTIONS: FlowTypeOption[] = [
  { value: "EARNED_INCOME", label: "Earned income", hint: "Salary, wages, freelance — your work brought this in." },
  { value: "INTERNAL_TRANSFER", label: "Internal transfer", hint: "Movement between your own accounts. Excluded from income / outflow totals." },
  { value: "EXTERNAL_GIFT", label: "External gift", hint: "Money from family, friends, or any non-employer external party." },
  { value: "REIMBURSEMENT", label: "Reimbursement / refund", hint: "Money back — refunds, shared-expense reimbursements." },
  { value: "SPENDING", label: "Spending", hint: "Default outgoing — anything that reduces your spending budget." },
  { value: "REPAYMENT", label: "Repayment", hint: "Loan principal / paying back debt. Tracked separately from spending." },
];

export const VALID_FLOW_TYPES = new Set(FLOW_TYPE_OPTIONS.map((f) => f.value));
