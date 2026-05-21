import { notFound } from "next/navigation";
import { getGoal } from "@ray/goals";
import { GoalForm } from "@/components/goal-form";
import type { GoalFormValues } from "@/app/actions";
import { updateGoalAction } from "../../../actions";
import { loadGoalFormContext } from "../../form-data";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditGoalPage({ params }: PageProps) {
  const { id: rawId } = await params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id)) notFound();

  const goal = getGoal(id);
  if (!goal) notFound();

  const { accounts, subscriptions } = loadGoalFormContext();

  const initialValues: GoalFormValues = {
    type: goal.type,
    mode: goal.mode,
    name: goal.name,
    targetAmount: String(goal.target_amount),
    targetDate: goal.target_date ?? "",
    accountId: goal.account_id ?? "",
    category: goal.category ?? "",
    includedBillIds: goal.included_bill_ids ?? [],
  };

  // Re-bind the action with the row id so the shared form doesn't need to
  // know it's an update vs. a create — same signature either way.
  const action = updateGoalAction.bind(null, id);

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-10 text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Edit goal
        </h1>
        <GoalForm
          action={action}
          initialValues={initialValues}
          submitLabel="Save changes"
          accounts={accounts}
          subscriptions={subscriptions}
        />
      </div>
    </main>
  );
}
