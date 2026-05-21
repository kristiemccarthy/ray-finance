import { getDb } from "@ray/db/connection";
import type {
  AccountOption,
  SubscriptionOption,
} from "@/components/goal-form";

// Shared loader for the goal form's dropdown contents. Pulled out of the
// page files so /new and /[id]/edit don't drift apart.

export interface GoalFormContext {
  accounts: AccountOption[];
  subscriptions: SubscriptionOption[];
}

export function loadGoalFormContext(): GoalFormContext {
  const db = getDb();

  const accountRows = db
    .prepare(
      `SELECT a.account_id,
              a.name,
              a.subtype,
              i.name AS bank_name
         FROM accounts a
         JOIN institutions i ON i.item_id = a.item_id
        WHERE a.hidden = 0
        ORDER BY a.current_balance DESC NULLS LAST`,
    )
    .all() as {
    account_id: string;
    name: string;
    subtype: string | null;
    bank_name: string;
  }[];

  const accounts: AccountOption[] = accountRows.map((a) => ({
    account_id: a.account_id,
    display: `${a.name} — ${a.bank_name}${a.subtype ? ` (${a.subtype})` : ""}`,
  }));

  const manualRows = db
    .prepare(
      `SELECT id, name, amount, frequency
         FROM recurring_bills
        ORDER BY name`,
    )
    .all() as {
    id: number;
    name: string;
    amount: number;
    frequency: string;
  }[];

  const streamRows = db
    .prepare(
      `SELECT stream_id, description, merchant_name, frequency, avg_amount, last_amount
         FROM recurring
        WHERE is_active = 1
          AND stream_type = 'outflow'
        ORDER BY COALESCE(merchant_name, description)`,
    )
    .all() as {
    stream_id: string;
    description: string;
    merchant_name: string | null;
    frequency: string;
    avg_amount: number;
    last_amount: number | null;
  }[];

  const subscriptions: SubscriptionOption[] = [
    ...manualRows.map((r) => ({
      key: `manual:${r.id}`,
      name: r.name,
      amount: r.amount,
      group: "manual" as const,
      frequency: r.frequency,
    })),
    ...streamRows.map((r) => ({
      key: `stream:${r.stream_id}`,
      name: r.merchant_name || r.description,
      amount: Math.abs(r.last_amount ?? r.avg_amount ?? 0),
      group: "recurring" as const,
      frequency: r.frequency,
    })),
  ];

  return { accounts, subscriptions };
}
