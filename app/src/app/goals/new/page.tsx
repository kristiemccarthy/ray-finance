import { GoalForm, EMPTY_GOAL_FORM_VALUES } from "@/components/goal-form";
import { createGoalAction } from "../../actions";
import { loadGoalFormContext } from "../form-data";

export const dynamic = "force-dynamic";

export default function NewGoalPage() {
  const { accounts, subscriptions } = loadGoalFormContext();

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-10 text-sm font-medium tracking-wide text-neutral-500 uppercase">
          New goal
        </h1>
        <GoalForm
          action={createGoalAction}
          initialValues={EMPTY_GOAL_FORM_VALUES}
          submitLabel="Create goal"
          accounts={accounts}
          subscriptions={subscriptions}
        />
      </div>
    </main>
  );
}
