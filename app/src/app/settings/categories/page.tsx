import Link from "next/link";
import { getDb } from "@ray/db/connection";
import { loadCategoryOverrides } from "@ray/csv-import/categoriser";
import { DeleteBillButton } from "@/components/delete-bill-button";
import { deleteCategoryRule } from "@/app/actions";
import { CATEGORY_OPTIONS, FLOW_TYPE_OPTIONS } from "./form-values";

export const dynamic = "force-dynamic";

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const categoryLabelByValue = new Map(
  CATEGORY_OPTIONS.map((c) => [c.value, c.label]),
);

const flowTypeLabelByValue = new Map(
  FLOW_TYPE_OPTIONS.map((f) => [f.value, f.label]),
);

function labelFor(category: string): string {
  return categoryLabelByValue.get(category) ?? category;
}

function flowTypeLabelFor(flowType: string | null): string {
  if (!flowType) return "";
  return flowTypeLabelByValue.get(flowType) ?? flowType;
}

interface SuggestionRow {
  merchant: string;
  count: number;
  total: number;
  currentCategory: string | null;
}

/**
 * Top 10 merchant names with the most transactions in the last 90 days
 * that are still in the "we don't really know" categories. The page uses
 * these to nudge the user toward creating rules for their most common
 * un-tagged merchants.
 *
 * Grouping prefers `merchant_name` (the post-alias display name), then
 * `enriched_name`, then `name`. This keeps PayPal-enriched rows clustered
 * by their real merchant rather than the opaque "Paypal Australia ###"
 * bank descriptor.
 */
function loadSuggestions(): SuggestionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT COALESCE(merchant_name, enriched_name, name) AS merchant,
              COUNT(*) AS count,
              COALESCE(SUM(amount), 0) AS total,
              MAX(category) AS currentCategory
         FROM transactions
        WHERE pending = 0
          AND amount > 0
          AND date >= date('now', '-90 days')
          AND (category IS NULL OR category IN ('OTHER', 'GENERAL_MERCHANDISE'))
        GROUP BY COALESCE(merchant_name, enriched_name, name)
        ORDER BY count DESC, total DESC
        LIMIT 10`,
    )
    .all() as SuggestionRow[];
}

export default function CategoriesPage() {
  const rules = loadCategoryOverrides();
  const suggestions = loadSuggestions();

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <div className="mb-10 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Manage categories
            </h1>
            <p className="mt-1 text-xs text-neutral-500">
              <Link
                href="/settings"
                className="underline-offset-2 hover:text-neutral-800 hover:underline"
              >
                ← Back to settings
              </Link>
            </p>
          </div>
          <Link
            href="/settings/categories/new"
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm font-medium text-stone-50 hover:bg-neutral-900"
          >
            Add new rule
          </Link>
        </div>

        <section className="mb-12">
          <h2 className="mb-3 text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Current rules
          </h2>
          {rules.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No rules yet. Add a rule to override the automatic
              categorisation for merchants you recognise.
            </p>
          ) : (
            <ul className="overflow-hidden rounded-md border border-stone-200 bg-white">
              {rules.map((rule, i) => (
                <li
                  key={rule.id}
                  className={`flex items-baseline gap-4 px-5 py-4 ${
                    i === rules.length - 1 ? "" : "border-b border-stone-100"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-neutral-900">
                      <span className="tabular-nums">{rule.pattern}</span>
                      <span className="mx-2 text-neutral-400">→</span>
                      {rule.setCategory ? (
                        <>
                          {labelFor(rule.category)}
                          {rule.subcategory && (
                            <span className="text-neutral-500">
                              {" "}
                              / {rule.subcategory}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-neutral-400">(no category)</span>
                      )}
                      {rule.flowType && (
                        <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal tracking-wide text-neutral-600 uppercase">
                          {flowTypeLabelFor(rule.flowType)}
                        </span>
                      )}
                    </div>
                    {rule.note && (
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {rule.note}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <Link
                      href={`/settings/categories/${rule.id}/edit`}
                      className="text-sm text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
                    >
                      Edit
                    </Link>
                    <DeleteBillButton
                      action={deleteCategoryRule.bind(null, rule.id)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-1 text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Suggestions
          </h2>
          <p className="mb-3 text-xs text-neutral-500">
            Frequent merchants from the last 90 days that the categoriser
            didn't recognise. Click "Create rule" to add a rule pre-filled
            with the merchant pattern.
          </p>
          {suggestions.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Nothing to suggest — every frequent merchant in the last 90
              days already has a category.
            </p>
          ) : (
            <ul className="overflow-hidden rounded-md border border-stone-200 bg-white">
              {suggestions.map((s, i) => (
                <li
                  key={s.merchant}
                  className={`flex items-baseline gap-4 px-5 py-4 ${
                    i === suggestions.length - 1
                      ? ""
                      : "border-b border-stone-100"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-900">
                      {s.merchant}
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-500 tabular-nums">
                      {s.count}{" "}
                      {s.count === 1 ? "transaction" : "transactions"} ·{" "}
                      {moneyFormatter.format(s.total)} ·{" "}
                      <span className="text-neutral-400">
                        {labelFor(s.currentCategory ?? "OTHER")}
                      </span>
                    </div>
                  </div>
                  <Link
                    href={`/settings/categories/new?pattern=${encodeURIComponent(s.merchant)}`}
                    className="shrink-0 text-sm text-neutral-700 underline-offset-2 hover:text-neutral-900 hover:underline"
                  >
                    Create rule
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
