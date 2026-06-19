import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";

// ---------------------------------------------------------------------------
// DB injection: mock getDb so computeLedgerSavingsStatus uses a fresh
// in-memory database per test rather than the singleton production file.
// ---------------------------------------------------------------------------

let testDb: InstanceType<typeof Database>;

vi.mock("../db/connection.js", () => ({
  getDb: () => testDb,
}));

import {
  computeGoalStatus,
  addContribution,
  listContributions,
  MIN_PACE_DAYS,
  type Goal,
  type ContributionKind,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Fixed reference date: 2026-06-19 */
const NOW = new Date("2026-06-19T12:00:00Z");

/** Days before NOW */
function daysAgo(n: number): string {
  const d = new Date(NOW.getTime() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function makeGoal(opts: {
  target?: number;
  targetDate?: string;
}): Goal {
  const id = testDb
    .prepare(
      `INSERT INTO goals (type, mode, name, target_amount, target_date, created_at)
       VALUES ('savings', 'ledger', 'Test Goal', ?, ?, date('now'))`,
    )
    .run(opts.target ?? 5000, opts.targetDate ?? "2026-12-31").lastInsertRowid;

  return {
    id: Number(id),
    type: "savings",
    mode: "ledger",
    name: "Test Goal",
    target_amount: opts.target ?? 5000,
    target_date: opts.targetDate ?? "2026-12-31",
    account_id: null,
    category: null,
    included_bill_ids: null,
    created_at: "2026-01-01",
    archived_at: null,
  };
}

function addRow(
  goalId: number,
  amount: number,
  date: string,
  kind: ContributionKind = "contribution",
): void {
  testDb
    .prepare(
      `INSERT INTO goal_contributions (goal_id, amount, contribution_date, note, kind)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(goalId, amount, date, kind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDb = freshDb();
});

describe("computeLedgerSavingsStatus — pace exclusion", () => {
  it("1: opening only — projected equals current, no pace", () => {
    const goal = makeGoal({});
    addRow(goal.id, 882.44, daysAgo(30), "opening");

    const s = computeGoalStatus(goal, NOW);
    expect(s.current).toBeCloseTo(882.44);
    expect(s.projected).toBeCloseTo(882.44);
    expect(s.status).toBe("off-track");
    const d = s.details as any;
    expect(d.contributionCount).toBe(0);
    expect(d.daysSinceFirst).toBe(0);
  });

  it("2: opening + allocation — still no pace", () => {
    const goal = makeGoal({});
    addRow(goal.id, 882.44, daysAgo(30), "opening");
    addRow(goal.id, 800.00, daysAgo(14), "allocation");

    const s = computeGoalStatus(goal, NOW);
    expect(s.current).toBeCloseTo(1682.44);
    expect(s.projected).toBeCloseTo(1682.44);
    expect(s.status).toBe("off-track");
    const d = s.details as any;
    expect(d.contributionCount).toBe(0);
  });

  it("3: opening + contribution same-day — daysSinceFirst=0, no pace yet", () => {
    const goal = makeGoal({});
    addRow(goal.id, 882.44, daysAgo(30), "opening");
    addRow(goal.id, 200.00, daysAgo(0), "contribution");   // today

    const s = computeGoalStatus(goal, NOW);
    expect(s.current).toBeCloseTo(1082.44);
    expect(s.projected).toBeCloseTo(1082.44);  // no extrapolation
    const d = s.details as any;
    expect(d.contributionCount).toBe(1);
    expect(d.daysSinceFirst).toBe(0);
  });

  it("4: opening + 1 contribution 5 days ago — below MIN_PACE_DAYS, no extrapolation", () => {
    const goal = makeGoal({});
    addRow(goal.id, 882.44, daysAgo(30), "opening");
    addRow(goal.id, 200.00, daysAgo(5), "contribution");

    const s = computeGoalStatus(goal, NOW);
    expect(s.current).toBeCloseTo(1082.44);
    expect(s.projected).toBeCloseTo(1082.44);
    const d = s.details as any;
    expect(d.contributionCount).toBe(1);
    expect(d.daysSinceFirst).toBe(5);
  });

  it(`5: opening + 1 contribution exactly ${MIN_PACE_DAYS} days ago — pace enabled`, () => {
    const goal = makeGoal({});
    addRow(goal.id, 882.44, daysAgo(30), "opening");
    addRow(goal.id, 200.00, daysAgo(MIN_PACE_DAYS), "contribution");

    const s = computeGoalStatus(goal, NOW);
    // avgPerDay = 200 / 14 ≈ 14.29; daysRemaining ≈ 195 (to 2026-12-31)
    const d = s.details as any;
    expect(d.contributionCount).toBe(1);
    expect(d.daysSinceFirst).toBe(MIN_PACE_DAYS);
    // Projection must be strictly greater than current (pace is positive)
    expect(s.projected).toBeGreaterThan(s.current);
    // current = 882.44 + 200 = 1082.44; opening excluded from pace
    expect(s.current).toBeCloseTo(1082.44);
  });

  it("6: opening + 2 contributions over 14 days — pace from contributions only", () => {
    const goal = makeGoal({});
    addRow(goal.id, 882.44, daysAgo(30), "opening");
    addRow(goal.id, 200.00, daysAgo(14), "contribution");
    addRow(goal.id, 200.00, daysAgo(0),  "contribution");

    const s = computeGoalStatus(goal, NOW);
    // paceSum=400, daysSinceFirst=14, avgPerDay=400/14≈28.57
    const d = s.details as any;
    expect(d.contributionCount).toBe(2);
    expect(d.daysSinceFirst).toBe(14);
    expect(d.avgPerContribution).toBeCloseTo(200.00);
    // current = 882.44 + 400 = 1282.44
    expect(s.current).toBeCloseTo(1282.44);
    // projection should be well above target (28.57/day × ~195 days ≈ +5571)
    expect(s.projected).toBeGreaterThan(5000);
    expect(s.status).toBe("on-track");
  });

  it("7: opening + allocation + 1 contribution — both excluded from pace", () => {
    const goal = makeGoal({});
    addRow(goal.id, 882.44, daysAgo(30), "opening");
    addRow(goal.id, 800.00, daysAgo(14), "allocation");
    addRow(goal.id, 200.00, daysAgo(14), "contribution");

    const s = computeGoalStatus(goal, NOW);
    // paceSum=$200, daysSinceFirst=14 (from contribution not allocation)
    const d = s.details as any;
    expect(d.contributionCount).toBe(1);
    expect(d.daysSinceFirst).toBe(14);
    // current includes all three: 882.44 + 800 + 200 = 1882.44
    expect(s.current).toBeCloseTo(1882.44);
    // pace from contribution only: 200/14 ≈ 14.29/day; projection < 5000
    expect(s.projected).toBeLessThan(5000);
    expect(s.status).toBe("off-track");
  });

  it("8: current >= target — achieved regardless of pace", () => {
    const goal = makeGoal({ target: 1000 });
    addRow(goal.id, 500.00, daysAgo(30), "opening");
    addRow(goal.id, 600.00, daysAgo(10), "contribution");  // total 1100 > 1000

    const s = computeGoalStatus(goal, NOW);
    expect(s.current).toBeCloseTo(1100);
    expect(s.status).toBe("achieved");
  });

  it("9: regression — all-contribution goal computes identically to old behaviour", () => {
    // Two contributions with no opening/allocation: pace = sum/days as before
    const goal = makeGoal({});
    addRow(goal.id, 300.00, daysAgo(28), "contribution");
    addRow(goal.id, 300.00, daysAgo(14), "contribution");

    const s = computeGoalStatus(goal, NOW);
    // paceSum=600, daysSinceFirst=28, avgPerDay=600/28≈21.43
    const d = s.details as any;
    expect(d.contributionCount).toBe(2);
    expect(d.daysSinceFirst).toBe(28);
    expect(d.avgPerContribution).toBeCloseTo(300.00);
    expect(s.current).toBeCloseTo(600);
    expect(s.projected).toBeGreaterThan(600);
  });
});

describe("addContribution — kind parameter", () => {
  it("10: defaults to 'contribution' when kind is omitted", () => {
    const goal = makeGoal({});
    addContribution(goal.id, 100, "2026-06-19");

    const rows = listContributions(goal.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("contribution");
  });

  it("11: explicit 'opening' kind is stored and excluded from pace", () => {
    const goal = makeGoal({});
    addContribution(goal.id, 882.44, "2026-05-20", "Opening backfill", "opening");

    const rows = listContributions(goal.id);
    expect(rows[0].kind).toBe("opening");

    // Verify it's excluded from pace: no pace contributions → projected = current
    const s = computeGoalStatus(goal, NOW);
    expect(s.projected).toBeCloseTo(s.current);
    const d = s.details as any;
    expect(d.contributionCount).toBe(0);
  });
});
