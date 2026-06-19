import Link from "next/link";
import {
  computeGoalStatus,
  MIN_PACE_DAYS,
  type CategoryCapDetails,
  type Goal,
  type GoalContribution,
  type GoalStatus,
  type GoalStatusLabel,
  type SavingsGoalDetails,
  type SubscriptionCapDetails,
} from "@ray/goals";
import { Sparkline } from "./sparkline";
import { DeleteBillButton } from "./delete-bill-button";
import { AddContributionForm } from "./add-contribution-form";
import type { AddContributionResult } from "@/app/actions";

// ---------------------------------------------------------------------------
// One card per goal. Dispatches on `goal.type` to render the right body —
// the chrome (header, badge, footer actions) is shared across all three.
// Status compute happens here so the page doesn't have to know the shape.
// ---------------------------------------------------------------------------

const moneyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

const shortDateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

function typeLabel(goal: Goal): string {
  switch (goal.type) {
    case "savings":
      return goal.mode === "ledger" ? "Savings (ledger)" : "Savings (balance)";
    case "category-cap":
      return "Category cap";
    case "subscription-cap":
      return "Subscription cap";
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  FOOD_AND_DRINK: "Food & Drink",
  MEDICAL: "Medical",
  GENERAL_MERCHANDISE: "Shopping",
  ENTERTAINMENT: "Entertainment",
  ALCOHOL: "Alcohol",
  PET_CARE: "Pet Care",
};

const STATUS_STRIPE: Record<GoalStatusLabel, string> = {
  "on-track": "bg-emerald-500",
  tight: "bg-amber-500",
  "off-track": "bg-red-500",
  achieved: "bg-emerald-600",
  missed: "bg-stone-400",
};

const STATUS_BADGE_CLASS: Record<GoalStatusLabel, string> = {
  "on-track": "bg-emerald-50 text-emerald-700 border-emerald-200",
  tight: "bg-amber-50 text-amber-700 border-amber-200",
  "off-track": "bg-red-50 text-red-700 border-red-200",
  achieved: "bg-emerald-100 text-emerald-800 border-emerald-300",
  missed: "bg-stone-100 text-stone-600 border-stone-300",
};

const STATUS_TEXT: Record<GoalStatusLabel, string> = {
  "on-track": "On track ✓",
  tight: "Tight",
  "off-track": "Off track ✗",
  achieved: "Achieved",
  missed: "Missed",
};

interface GoalCardProps {
  goal: Goal;
  deleteAction: () => Promise<void>;
  /**
   * Ledger-mode savings extras. Both must be supplied together — the page
   * always loads them when the goal is ledger-mode, and never when it
   * isn't, so partial passes are a programmer error.
   */
  contributions?: GoalContribution[];
  addContributionAction?: (
    formData: FormData,
  ) => Promise<AddContributionResult>;
  deleteContributionAction?: (id: number) => Promise<void>;
}

export function GoalCard({
  goal,
  deleteAction,
  contributions,
  addContributionAction,
  deleteContributionAction,
}: GoalCardProps) {
  const status = computeGoalStatus(goal);
  return (
    <article className="flex overflow-hidden rounded-md border border-stone-200 bg-white">
      <span
        aria-hidden
        className={`w-1 shrink-0 ${STATUS_STRIPE[status.status]}`}
      />
      <div className="flex-1 px-5 py-5">
        <Header goal={goal} status={status} />
        <Body
          goal={goal}
          status={status}
          contributions={contributions}
          addContributionAction={addContributionAction}
          deleteContributionAction={deleteContributionAction}
        />
        <Footer goal={goal} deleteAction={deleteAction} />
      </div>
    </article>
  );
}

function Header({ goal, status }: { goal: Goal; status: GoalStatus }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-neutral-900">{goal.name}</h2>
        <div className="mt-0.5 text-xs tracking-wide text-neutral-500 uppercase">
          {typeLabel(goal)}
        </div>
      </div>
      <span
        className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_BADGE_CLASS[status.status]}`}
      >
        {STATUS_TEXT[status.status]}
      </span>
    </div>
  );
}

function Body({
  goal,
  status,
  contributions,
  addContributionAction,
  deleteContributionAction,
}: {
  goal: Goal;
  status: GoalStatus;
  contributions?: GoalContribution[];
  addContributionAction?: (
    formData: FormData,
  ) => Promise<AddContributionResult>;
  deleteContributionAction?: (id: number) => Promise<void>;
}) {
  switch (goal.type) {
    case "savings":
      if (goal.mode === "ledger") {
        return (
          <LedgerSavingsBody
            goal={goal}
            status={status}
            contributions={contributions ?? []}
            addContributionAction={addContributionAction}
            deleteContributionAction={deleteContributionAction}
          />
        );
      }
      return <SavingsBody goal={goal} status={status} />;
    case "category-cap":
      return <CategoryCapBody goal={goal} status={status} />;
    case "subscription-cap":
      return <SubscriptionCapBody goal={goal} status={status} />;
  }
}

// ---------------------------------------------------------------------------
// Savings body
// ---------------------------------------------------------------------------

function SavingsBody({ goal, status }: { goal: Goal; status: GoalStatus }) {
  const details = status.details as SavingsGoalDetails;
  const pct = Math.round(Math.max(0, Math.min(1, status.progress)) * 100);
  const gap = details.gapToTarget;
  const projectedAboveTarget = status.projected >= goal.target_amount;

  // Two points on the sparkline: where we are now, where we're projected
  // to be at the goal date. The dashed line marks the target.
  const sparkValues = [status.current, status.projected];

  return (
    <div className="mt-4 space-y-2">
      <div className="text-2xl font-semibold tabular-nums text-neutral-900">
        {moneyFormatter.format(status.current)}{" "}
        <span className="text-neutral-400">of</span>{" "}
        {moneyFormatter.format(goal.target_amount)}
      </div>
      <div className="text-sm text-neutral-600">
        {pct}% there.
        {goal.target_date && (
          <>
            {" "}
            Target:{" "}
            <span className="text-neutral-800">
              {dateFormatter.format(new Date(goal.target_date + "T00:00:00Z"))}
            </span>
          </>
        )}
      </div>
      <div className="text-sm text-neutral-600">
        Projected by deadline:{" "}
        <span className="tabular-nums text-neutral-800">
          {moneyFormatter.format(status.projected)}
        </span>{" "}
        {projectedAboveTarget ? (
          <span className="text-emerald-600">
            (overshoots by {moneyFormatter.format(status.projected - goal.target_amount)})
          </span>
        ) : (
          <span className="text-red-600">
            (gap of {moneyFormatter.format(Math.abs(gap))})
          </span>
        )}
      </div>
      {!projectedAboveTarget && details.savingsRateNeededMonthly > 0 && (
        <div className="text-sm text-neutral-600">
          Save{" "}
          <span className="font-medium text-neutral-800 tabular-nums">
            ~{moneyFormatter.format(details.savingsRateNeededMonthly)}/month
          </span>{" "}
          extra to close gap.
        </div>
      )}
      <div className="mt-4 text-slate-500">
        <Sparkline
          values={sparkValues}
          target={goal.target_amount}
          ariaLabel={`${goal.name} projection toward target`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ledger-mode savings body
// ---------------------------------------------------------------------------

function LedgerSavingsBody({
  goal,
  status,
  contributions,
  addContributionAction,
  deleteContributionAction,
}: {
  goal: Goal;
  status: GoalStatus;
  contributions: GoalContribution[];
  addContributionAction?: (
    formData: FormData,
  ) => Promise<AddContributionResult>;
  deleteContributionAction?: (id: number) => Promise<void>;
}) {
  const details = status.details as SavingsGoalDetails;
  const pct = Math.round(Math.max(0, Math.min(1, status.progress)) * 100);
  const projectedAboveTarget = status.projected >= goal.target_amount;

  // Pace is reliable with 2+ contributions, or 1 contribution that's at
  // least MIN_PACE_DAYS old — mirroring the logic in computeLedgerSavingsStatus.
  const paceEstablished =
    details.contributionCount >= 2 ||
    (details.contributionCount === 1 && details.daysSinceFirst >= MIN_PACE_DAYS);

  // Sparkline: cumulative contribution growth, plus a final projected point
  // and a dashed target line. Sort ascending by date for a left-to-right
  // trajectory; ties broken by id ascending so same-day contributions land
  // in their entry order.
  const ascending = [...contributions].sort((a, b) => {
    const d = a.contribution_date.localeCompare(b.contribution_date);
    return d !== 0 ? d : a.id - b.id;
  });
  const cumulative: number[] = [0];
  let running = 0;
  for (const c of ascending) {
    running += c.amount;
    cumulative.push(running);
  }
  // Only append the projection point when it's meaningfully different from
  // the latest cumulative — otherwise the line just hits the same y twice
  // and looks like a glitch.
  if (Math.abs(status.projected - running) > 1) {
    cumulative.push(status.projected);
  }

  return (
    <div className="mt-4 space-y-2">
      <div className="text-2xl font-semibold tabular-nums text-neutral-900">
        {moneyFormatter.format(status.current)}{" "}
        <span className="text-neutral-400">of</span>{" "}
        {moneyFormatter.format(goal.target_amount)}{" "}
        <span className="text-base font-normal text-neutral-500">
          contributed
        </span>
      </div>
      <div className="text-sm text-neutral-600">
        {pct}% there.
        {goal.target_date && (
          <>
            {" "}
            Target:{" "}
            <span className="text-neutral-800">
              {dateFormatter.format(new Date(goal.target_date + "T00:00:00Z"))}
            </span>
          </>
        )}
      </div>
      {details.accountName && (
        <div className="text-sm text-neutral-600">
          Held in:{" "}
          <span className="text-neutral-800">{details.accountName}</span>{" "}
          <span className="text-xs text-neutral-400">(informational)</span>
        </div>
      )}
      {paceEstablished ? (
        <div className="text-sm text-neutral-600">
          {details.contributionCount}{" "}
          {details.contributionCount === 1 ? "contribution" : "contributions"}{" "}
          over {details.daysSinceFirst}{" "}
          {details.daysSinceFirst === 1 ? "day" : "days"}, averaging{" "}
          <span className="tabular-nums text-neutral-800">
            {moneyFormatter.format(details.avgPerContribution)}
          </span>
          /contribution
        </div>
      ) : details.contributionCount > 0 ? (
        <div className="text-sm text-amber-700">
          Pace not yet established.{" "}
          {details.requiredMonthlyToHit > 0 && (
            <>
              Needs{" "}
              <span className="font-medium tabular-nums">
                {moneyFormatter.format(details.requiredMonthlyToHit)}/month
              </span>{" "}
              to hit target by deadline.
            </>
          )}
        </div>
      ) : (
        <div className="text-sm text-neutral-500">
          No contributions yet — log your first one below.
        </div>
      )}
      {paceEstablished && !projectedAboveTarget && details.requiredMonthlyToHit > 0 && (
        <div className="text-sm text-neutral-600">
          Required pace:{" "}
          <span className="font-medium text-neutral-800 tabular-nums">
            {moneyFormatter.format(details.requiredMonthlyToHit)}/month
          </span>{" "}
          to reach target on time
        </div>
      )}

      <div className="mt-4 text-slate-500">
        <Sparkline
          values={cumulative}
          target={goal.target_amount}
          ariaLabel={`${goal.name} contributions toward target`}
        />
      </div>

      {addContributionAction && (
        <div className="mt-4 flex flex-col gap-3">
          <AddContributionForm action={addContributionAction} />
          {contributions.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-sm text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline">
                View contributions ({contributions.length})
              </summary>
              <ContributionsList
                contributions={contributions}
                deleteContributionAction={deleteContributionAction}
              />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ContributionsList({
  contributions,
  deleteContributionAction,
}: {
  contributions: GoalContribution[];
  deleteContributionAction?: (id: number) => Promise<void>;
}) {
  return (
    <ul className="mt-3 divide-y divide-stone-100 rounded-md border border-stone-200 bg-stone-50">
      {contributions.map((c) => (
        <li
          key={c.id}
          className="flex items-baseline gap-3 px-3 py-2 text-sm"
        >
          <span className="shrink-0 text-xs tabular-nums text-neutral-500">
            {shortDateFormatter.format(
              new Date(c.contribution_date + "T00:00:00Z"),
            )}
          </span>
          {c.kind !== "contribution" && (
            <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
              {c.kind}
            </span>
          )}
          <span className="flex-1 truncate text-neutral-700">
            {c.note ?? <span className="text-neutral-400">No note</span>}
          </span>
          <span className="shrink-0 tabular-nums text-neutral-900">
            {moneyFormatter.format(c.amount)}
          </span>
          {deleteContributionAction && (
            <form
              action={deleteContributionAction.bind(null, c.id)}
              className="shrink-0"
            >
              <button
                type="submit"
                className="text-xs text-neutral-400 underline-offset-2 hover:text-red-600 hover:underline"
                aria-label={`Delete contribution of ${c.amount}`}
              >
                Delete
              </button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Category-cap body
// ---------------------------------------------------------------------------

function CategoryCapBody({ goal, status }: { goal: Goal; status: GoalStatus }) {
  const details = status.details as CategoryCapDetails;
  const categoryLabel = goal.category
    ? CATEGORY_LABEL[goal.category] ?? goal.category
    : "—";
  return (
    <div className="mt-4 space-y-1">
      <div className="text-xs tracking-wide text-neutral-500 uppercase">
        {categoryLabel} under {moneyFormatter.format(goal.target_amount)}/cycle
      </div>
      <div className="text-2xl font-semibold tabular-nums text-neutral-900">
        {moneyFormatter.format(status.current)}{" "}
        <span className="text-neutral-400">of</span>{" "}
        {moneyFormatter.format(goal.target_amount)}{" "}
        <span className="text-base font-normal text-neutral-500">
          this cycle
        </span>
      </div>
      <div className="text-sm text-neutral-600">
        Day {details.dayOfCycle} of {details.cycleLengthDays} — on pace for{" "}
        <span className="tabular-nums text-neutral-800">
          {moneyFormatter.format(status.projected)}
        </span>{" "}
        by end of cycle
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscription-cap body
// ---------------------------------------------------------------------------

function SubscriptionCapBody({
  goal,
  status,
}: {
  goal: Goal;
  status: GoalStatus;
}) {
  const details = status.details as SubscriptionCapDetails;
  const over = status.projected - goal.target_amount;
  // Show the ones expected to charge this month first — those drive the
  // projection. Past-charged-but-not-expected-again entries get dropped
  // from the inline list to keep it short.
  const visible = details.subscriptionsList.filter((s) => s.willHitThisMonth);

  return (
    <div className="mt-4 space-y-1">
      <div className="text-xs tracking-wide text-neutral-500 uppercase">
        Subscriptions under {moneyFormatter.format(goal.target_amount)}/month
      </div>
      <div className="text-2xl font-semibold tabular-nums text-neutral-900">
        Projected {moneyFormatter.format(status.projected)} this month
      </div>
      <div className="text-sm text-neutral-600">
        {over > 0 ? (
          <span className="text-red-600">
            ({moneyFormatter.format(over)} over)
          </span>
        ) : (
          <span className="text-emerald-600">
            ({moneyFormatter.format(Math.abs(over))} headroom)
          </span>
        )}
      </div>
      {visible.length > 0 && (
        <div className="mt-2 text-sm leading-relaxed text-neutral-600">
          <span className="text-neutral-500">Includes: </span>
          {visible.map((s, i) => (
            <span key={s.name + i}>
              {s.name}{" "}
              <span className="tabular-nums text-neutral-800">
                {moneyFormatter.format(s.amount)}
              </span>
              {i < visible.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer — edit + delete
// ---------------------------------------------------------------------------

function Footer({
  goal,
  deleteAction,
}: {
  goal: Goal;
  deleteAction: () => Promise<void>;
}) {
  return (
    <div className="mt-4 flex items-center justify-end gap-4">
      <Link
        href={`/goals/${goal.id}/edit`}
        className="text-sm text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
      >
        Edit
      </Link>
      <DeleteBillButton action={deleteAction} />
    </div>
  );
}
