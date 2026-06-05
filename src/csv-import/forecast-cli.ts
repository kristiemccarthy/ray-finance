// ---------------------------------------------------------------------------
// CLI for the pay-cycle balance forecast.
//
// Run with:
//   npx tsx src/csv-import/forecast-cli.ts --account <accountId> [options]
//
// Read-only: prints projected per-cycle income, bills, and balances, plus
// the worst projected point across the whole window. Recurring bills only —
// see the footer caveat about discretionary spend.
// ---------------------------------------------------------------------------

import {
  forecastBalance,
  type CycleProjection,
  type ForecastResult,
} from "./balance-forecast.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set(["account", "cycles", "anchor"]);

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const USAGE = `
Usage: tsx src/csv-import/forecast-cli.ts --account <accountId> [options]

Required:
  --account <accountId>    Account to forecast (e.g. csv:st-george:personal).

Optional:
  --cycles <N>             Number of pay cycles to project (default: 4).
  --anchor <day-name>      Cycle start day, e.g. wednesday, friday
                           (default: wednesday).
`.trim();

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.account) {
    fail("Missing required argument: --account.");
  }

  const numberOfCycles = args.cycles ? parseCount(args.cycles) : undefined;
  const cycleAnchorDayOfWeek = args.anchor ? parseAnchor(args.anchor) : undefined;

  const result = forecastBalance({
    // CLI forecasts a single account passed via --account.
    accountIds: [args.account!],
    ...(numberOfCycles !== undefined ? { numberOfCycles } : {}),
    ...(cycleAnchorDayOfWeek !== undefined ? { cycleAnchorDayOfWeek } : {}),
  });

  printReport(result);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(result: ForecastResult): void {
  console.log(`Balance forecast: ${result.accountId}`);
  console.log(`Current balance:  ${formatMoney(result.currentBalance)}`);
  console.log("");

  for (let i = 0; i < result.cycles.length; i++) {
    printCycle(i + 1, result.cycles[i]);
  }

  console.log(
    `Lowest projected point: ${formatMoney(result.lowestPoint.balance)} on ${result.lowestPoint.date}`,
  );
  console.log(`  Reason: ${result.lowestPoint.reason}`);
  console.log("");
  console.log(
    "Forecast counts recurring bills and salary only. Subtract your typical",
  );
  console.log(
    "fortnightly grocery + discretionary spend (~$700-1,000/cycle) for the",
  );
  console.log("realistic picture.");
}

function printCycle(index: number, cycle: CycleProjection): void {
  console.log(
    `--- Cycle ${index}: ${cycle.startDate} -> ${cycle.endDate} ----------------`,
  );
  console.log(`  Starting balance: ${formatMoney(cycle.startingBalance)}`);

  if (cycle.incomingItems.length > 0) {
    console.log(`  Income (+${formatMoney(cycle.totalIncome)}):`);
    for (const item of cycle.incomingItems) {
      console.log(
        `    ${item.date}  +${formatMoney(item.amount).padStart(12)}  ${item.description}`,
      );
    }
  } else {
    console.log(`  Income: (none)`);
  }

  if (cycle.outgoingItems.length > 0) {
    console.log(`  Bills (-${formatMoney(cycle.totalBills)}):`);
    for (const item of cycle.outgoingItems) {
      const tag = item.source === "manual" ? " [manual]" : "";
      console.log(
        `    ${item.date}  -${formatMoney(item.amount).padStart(12)}  ${item.description}${tag}`,
      );
    }
  } else {
    console.log(`  Bills: (none)`);
  }

  console.log(`  Ending balance:   ${formatMoney(cycle.endingBalance)}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: "${token}".`);
    }
    const key = token.slice(2);
    if (!KNOWN_FLAGS.has(key)) {
      fail(`Unknown option: --${key}.`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Option --${key} requires a value.`);
    }
    out[key] = value;
    i++;
  }
  return out;
}

function parseAnchor(raw: string): number {
  const dow = DAY_NAMES[raw.toLowerCase()];
  if (dow === undefined) {
    fail(
      `Invalid --anchor "${raw}". Expected one of: ${Object.keys(DAY_NAMES).join(", ")}.`,
    );
  }
  return dow;
}

function parseCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    fail(`Invalid --cycles "${raw}". Expected a positive integer.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return (
    sign +
    "$" +
    abs.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function fail(message: string): never {
  console.error(message);
  console.error("");
  console.error(USAGE);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

try {
  main();
} catch (err) {
  console.error("forecast-cli failed:");
  console.error(err);
  process.exit(1);
}
