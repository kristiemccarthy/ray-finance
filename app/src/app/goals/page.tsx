import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  listActiveGoals,
  listContributions,
  listLedgerAccountAllocations,
  type AccountAllocation,
  type GoalContribution,
} from "@ray/goals";
import { GoalCard } from "@/components/goal-card";
import {
  addGoalContribution,
  deleteGoalAction,
  deleteGoalContribution,
} from "../actions";

export const dynamic = "force-dynamic";

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

export default function GoalsPage() {
  const goals = listActiveGoals();

  // Pre-load contributions for every ledger savings goal in a single pass.
  // Keeping this in the page (rather than inside the card) lets us bind the
  // per-contribution delete action where the id is already known.
  const contributionsByGoal = new Map<number, GoalContribution[]>();
  for (const goal of goals) {
    if (goal.type === "savings" && goal.mode === "ledger") {
      contributionsByGoal.set(goal.id, listContributions(goal.id));
    }
  }

  const allocations = listLedgerAccountAllocations();
  const overAllocated = allocations.filter((a) => a.overallocated);

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <div className="mb-10 flex items-baseline justify-between gap-4">
          <h1 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
            Goals
          </h1>
          <Link
            href="/goals/new"
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm font-medium text-stone-50 hover:bg-neutral-900"
          >
            Add new goal
          </Link>
        </div>

        {overAllocated.length > 0 && (
          <OverAllocationBanner allocations={overAllocated} />
        )}

        {goals.length === 0 ? (
          <p className="mt-16 text-center text-sm text-neutral-500">
            Add your first goal to start tracking what you're working toward.
          </p>
        ) : (
          <div className="space-y-4">
            {goals.map((goal) => {
              const isLedger =
                goal.type === "savings" && goal.mode === "ledger";
              return (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  // Bind id at render so the form receives a parameterless
                  // server action — keeps the Card props serialisable across
                  // the server→client boundary.
                  deleteAction={deleteGoalAction.bind(null, goal.id)}
                  contributions={
                    isLedger ? contributionsByGoal.get(goal.id) : undefined
                  }
                  addContributionAction={
                    isLedger
                      ? addGoalContribution.bind(null, goal.id)
                      : undefined
                  }
                  deleteContributionAction={
                    isLedger ? deleteGoalContribution : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function OverAllocationBanner({
  allocations,
}: {
  allocations: AccountAllocation[];
}) {
  return (
    <div className="mb-6 space-y-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
          strokeWidth={2}
        />
        <div className="space-y-2">
          {allocations.map((a) => (
            <p key={a.account_id} className="leading-snug">
              <span className="font-medium">{a.account_name}</span> has{" "}
              <span className="tabular-nums">
                {moneyFormatter.format(a.balance)}
              </span>{" "}
              available but{" "}
              <span className="tabular-nums">
                {moneyFormatter.format(a.allocated)}
              </span>{" "}
              allocated across goals. You may not have enough to fully cover
              all goals.
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
