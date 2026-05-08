// Throwaway diagnostic: see what's bucketed under GENERAL_SERVICES over
// the last ~3 months, with sample dates so we can tell recurring charges
// from one-offs at a glance.
//
// Run with:
//   npx tsx src/csv-import/test-services-breakdown.ts
//
// Read-only.

import { getDb } from "../db/connection.js";

interface Row {
  name: string;
  count: number;
  total: number;
}

const START_DATE = "2026-02-04";
const END_DATE = "2026-05-05";
const LIMIT = 40;
const SAMPLE_DATE_COUNT = 2;

function main(): void {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT name, COUNT(*) AS count, SUM(amount) AS total
         FROM transactions
        WHERE category = 'GENERAL_SERVICES'
          AND date >= ?
          AND date <= ?
          AND amount > 0
        GROUP BY name
        ORDER BY total DESC
        LIMIT ?`,
    )
    .all(START_DATE, END_DATE, LIMIT) as Row[];

  console.log(
    `GENERAL_SERVICES outflows ${START_DATE}..${END_DATE} (top ${LIMIT} by total spend):`,
  );
  console.log("");

  if (rows.length === 0) {
    console.log("  (no matching rows)");
    return;
  }

  // Second pass: for each name, fetch the most-recent N dates so the user
  // can spot recurring charges (consistent dates) vs one-offs.
  const datesStmt = db.prepare(
    `SELECT date FROM transactions
      WHERE category = 'GENERAL_SERVICES'
        AND date >= ?
        AND date <= ?
        AND amount > 0
        AND name = ?
      ORDER BY date DESC
      LIMIT ?`,
  );
  const sampleDatesByName = new Map<string, string>();
  for (const row of rows) {
    const dateRows = datesStmt.all(
      START_DATE,
      END_DATE,
      row.name,
      SAMPLE_DATE_COUNT,
    ) as { date: string }[];
    sampleDatesByName.set(row.name, dateRows.map((r) => r.date).join(", "));
  }

  const headers = ["count", "total", "sample_dates", "name"];
  const data = rows.map((r) => [
    String(r.count),
    formatAmount(r.total),
    sampleDatesByName.get(r.name) ?? "",
    truncate(r.name, 60),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );

  const fmtRow = (cols: string[]): string =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log("  " + fmtRow(headers));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) {
    console.log("  " + fmtRow(row));
  }

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  console.log("");
  console.log(`  Sum of top ${rows.length}: ${formatAmount(grandTotal)}`);
}

function formatAmount(n: number): string {
  return n.toFixed(2);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

try {
  main();
} catch (err) {
  console.error("Services-breakdown script failed:");
  console.error(err);
  process.exit(1);
}
