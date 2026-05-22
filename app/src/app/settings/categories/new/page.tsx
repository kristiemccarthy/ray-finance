import {
  CategoryRuleForm,
  EMPTY_CATEGORY_RULE_FORM_VALUES,
} from "@/components/category-rule-form";
import { addCategoryRule } from "../../../actions";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ pattern?: string }>;
}

/**
 * Add-rule page. Optional `?pattern=...` query param pre-fills the form,
 * which the "Create rule" links on the suggestions list use to seed the
 * pattern from a known merchant name.
 */
export default async function NewCategoryRulePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const initialValues = {
    ...EMPTY_CATEGORY_RULE_FORM_VALUES,
    pattern: sp.pattern ?? "",
  };

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-10 text-sm font-medium tracking-wide text-neutral-500 uppercase">
          New category rule
        </h1>
        <CategoryRuleForm
          action={addCategoryRule}
          initialValues={initialValues}
          submitLabel="Create rule"
        />
      </div>
    </main>
  );
}
