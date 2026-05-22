import { notFound } from "next/navigation";
import { getDb } from "@ray/db/connection";
import {
  CategoryRuleForm,
} from "@/components/category-rule-form";
import type { CategoryRuleFormValues } from "@/app/actions";
import { updateCategoryRule } from "../../../../actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface RuleRow {
  id: number;
  match_pattern: string;
  category: string;
  subcategory: string | null;
  note: string | null;
  flow_type: string | null;
  set_category: number;
}

export default async function EditCategoryRulePage({ params }: PageProps) {
  const { id: rawId } = await params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id)) notFound();

  const db = getDb();
  const rule = db
    .prepare(
      `SELECT id, match_pattern, category, subcategory, note, flow_type, set_category
         FROM category_overrides
        WHERE id = ?`,
    )
    .get(id) as RuleRow | undefined;
  if (!rule) notFound();

  const initialValues: CategoryRuleFormValues = {
    pattern: rule.match_pattern,
    category: rule.category,
    subcategory: rule.subcategory ?? "",
    note: rule.note ?? "",
    flowType: rule.flow_type ?? "",
    setCategory: rule.set_category !== 0 ? "1" : "0",
  };

  // Bind id at render so the shared form sees a parameterless action.
  const action = updateCategoryRule.bind(null, id);

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-10 text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Edit category rule
        </h1>
        <CategoryRuleForm
          action={action}
          initialValues={initialValues}
          submitLabel="Save changes"
        />
      </div>
    </main>
  );
}
