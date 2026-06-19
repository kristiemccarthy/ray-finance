import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";

// ---------------------------------------------------------------------------
// DB injection — same pattern as src/goals/index.test.ts.
// ---------------------------------------------------------------------------

let testDb: InstanceType<typeof Database>;

vi.mock("../db/connection.js", () => ({
  getDb: () => testDb,
}));

import { getRetrospective, RETROSPECTIVE_CATEGORY_ORDER } from "./index.js";

// Fixed reference: 2026-06-19. Completed calendar months are May, Apr, Mar …
const NOW = new Date("2026-06-19T12:00:00Z");

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  migrate(db);
  // Seed the FK chain: institution → account, so test transactions can insert.
  db.prepare(
    `INSERT INTO institutions (item_id, access_token, name) VALUES ('inst-test', 'tok', 'Test Bank')`,
  ).run();
  db.prepare(
    `INSERT INTO accounts (account_id, item_id, name, type) VALUES ('test', 'inst-test', 'Test', 'depository')`,
  ).run();
  return db;
}

let txCounter = 0;
function insertSpending(
  date: string,
  amount: number,
  category: string,
): void {
  txCounter += 1;
  testDb
    .prepare(
      `INSERT INTO transactions
         (transaction_id, account_id, name, amount, date, flow_type, category, pending)
       VALUES (?, 'test', ?, ?, ?, 'SPENDING', ?, 0)`,
    )
    .run(`tx-${txCounter}`, `Test ${category}`, amount, date, category);
}

beforeEach(() => {
  testDb = freshDb();
  txCounter = 0;
});

// ---------------------------------------------------------------------------
// categorySeriesMap tests
// ---------------------------------------------------------------------------

describe("getRetrospective — categorySeriesMap", () => {
  it("1: series length equals periods.length for a 3-period request", () => {
    insertSpending("2026-05-15", 100, "FOOD_AND_DRINK");
    insertSpending("2026-04-15", 120, "FOOD_AND_DRINK");
    insertSpending("2026-03-15", 90, "FOOD_AND_DRINK");

    const data = getRetrospective("calendar", 3, NOW);
    expect(data.notEnoughHistory).toBe(false);
    expect(data.periods).toHaveLength(3);

    for (const key of RETROSPECTIVE_CATEGORY_ORDER) {
      expect(data.categorySeriesMap[key]).toHaveLength(3);
    }
  });

  it("2: series is oldest-first — positions align with period order", () => {
    // $90 in Mar, $120 in Apr, $100 in May
    insertSpending("2026-03-15", 90, "FOOD_AND_DRINK");
    insertSpending("2026-04-15", 120, "FOOD_AND_DRINK");
    insertSpending("2026-05-15", 100, "FOOD_AND_DRINK");

    const data = getRetrospective("calendar", 3, NOW);
    // periods[] is most-recent-first: [May, Apr, Mar]
    expect(data.periods[0].window.startDate).toBe("2026-05-01");
    expect(data.periods[2].window.startDate).toBe("2026-03-01");

    const series = data.categorySeriesMap["FOOD_AND_DRINK"];
    // series[] is oldest-first: [Mar=$90, Apr=$120, May=$100]
    expect(series[0]).toBeCloseTo(90);
    expect(series[1]).toBeCloseTo(120);
    expect(series[2]).toBeCloseTo(100);
  });

  it("3: category with no transactions appears as all-zeros (not absent)", () => {
    insertSpending("2026-05-15", 100, "FOOD_AND_DRINK");
    insertSpending("2026-04-15", 120, "FOOD_AND_DRINK");
    insertSpending("2026-03-15", 90, "FOOD_AND_DRINK");

    const data = getRetrospective("calendar", 3, NOW);

    const vapeSeries = data.categorySeriesMap["VAPE"];
    expect(vapeSeries).toHaveLength(3);
    expect(vapeSeries.every((v) => v === 0)).toBe(true);

    // All keys are present in the map
    for (const key of RETROSPECTIVE_CATEGORY_ORDER) {
      expect(key in data.categorySeriesMap).toBe(true);
    }
  });

  it("4: notEnoughHistory path returns empty arrays for all keys", () => {
    // No transactions — nothing has data
    const data = getRetrospective("calendar", 3, NOW);

    expect(data.notEnoughHistory).toBe(true);
    expect(data.periods).toHaveLength(0);

    for (const key of RETROSPECTIVE_CATEGORY_ORDER) {
      expect(data.categorySeriesMap[key]).toEqual([]);
    }
  });

  it("5: series length is exactly N — hidden N+1 comparison period is excluded", () => {
    // Insert data across 4 months; the 4th (Feb) is the hidden comparison period
    insertSpending("2026-02-15", 80, "FOOD_AND_DRINK");  // hidden (N+1 for 3-period)
    insertSpending("2026-03-15", 90, "FOOD_AND_DRINK");  // visible[2] = oldest
    insertSpending("2026-04-15", 120, "FOOD_AND_DRINK"); // visible[1]
    insertSpending("2026-05-15", 100, "FOOD_AND_DRINK"); // visible[0] = most recent

    const data = getRetrospective("calendar", 3, NOW);
    expect(data.periods).toHaveLength(3);

    // Series must be exactly 3, not 4
    for (const key of RETROSPECTIVE_CATEGORY_ORDER) {
      expect(data.categorySeriesMap[key]).toHaveLength(3);
    }

    const series = data.categorySeriesMap["FOOD_AND_DRINK"];
    // Feb ($80) must not appear in the series
    expect(series).not.toContain(80);
    // The three visible months are present oldest-first
    expect(series[0]).toBeCloseTo(90);  // Mar
    expect(series[1]).toBeCloseTo(120); // Apr
    expect(series[2]).toBeCloseTo(100); // May
  });
});
