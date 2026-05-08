// ---------------------------------------------------------------------------
// CLI for managing manual recurring-bill entries in `recurring_bills`.
//
// Run with:
//   npx tsx src/csv-import/bill-cli.ts <add|list|remove> [options]
//
// `recurring_bills` is the bill-reminder table — distinct from `recurring`,
// which the auto-detector populates. This CLI is for known scheduled bills
// the user wants surfaced in `ray bills` regardless of whether the
// detector has seen them yet.
// ---------------------------------------------------------------------------

import { getDb } from "../db/connection.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set([
  "name",
  "amount",
  "day",
  "type",
  "account",
  "frequency",
  "next-due",
]);
const SUBCOMMANDS = ["add", "list", "remove"] as const;
const VALID_FREQUENCIES = new Set(["monthly", "fortnightly", "weekly"]);

const USAGE = `
Usage: tsx src/csv-import/bill-cli.ts <subcommand> [options]

Subcommands:
  add     Add a recurring bill
  list    List all recurring bills (grouped by frequency)
  remove  Remove a recurring bill by exact name

add options (all frequencies):
  --name <string>          Required
  --amount <num|range>     Required — single number (275) or range (250~300).
                           For a range we store the midpoint and annotate
                           the name with the range in parentheses.
  --frequency <freq>       Optional (default: monthly).
                           One of: monthly, fortnightly, weekly.
  --type <string>          Optional (default: "manual")
  --account <accountId>    Optional

add options (frequency=monthly):
  --day <1-31>             Required — day of month the bill falls on.

add options (frequency=fortnightly | weekly):
  --next-due <YYYY-MM-DD>  Required — date of the next occurrence; the
                           cadence repeats every 14 (or 7) days from there.

remove options:
  --name <exact-name>      Required
`.trim();

interface BillRow {
  id: number;
  name: string;
  amount: number;
  day_of_month: number | null;
  type: string | null;
  account_id: string | null;
  frequency: string;
  next_due_date: string | null;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  if (!subcommand) {
    fail("Missing subcommand.");
  }
  if (!SUBCOMMANDS.includes(subcommand as (typeof SUBCOMMANDS)[number])) {
    fail(`Unknown subcommand: "${subcommand}".`);
  }

  const args = parseArgs(argv.slice(1));

  switch (subcommand) {
    case "add":
      doAdd(args);
      return;
    case "list":
      doList();
      return;
    case "remove":
      doRemove(args);
      return;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: add
// ---------------------------------------------------------------------------

function doAdd(args: Record<string, string | undefined>): void {
  if (!args.name) fail("Missing required argument: --name.");
  if (!args.amount) fail("Missing required argument: --amount.");

  const frequency = args.frequency ?? "monthly";
  if (!VALID_FREQUENCIES.has(frequency)) {
    fail(
      `Invalid --frequency "${frequency}". Must be one of: monthly, fortnightly, weekly.`,
    );
  }

  // Schedule fields are mutually exclusive: monthly uses day_of_month;
  // fortnightly/weekly use next_due_date as the recurrence anchor.
  let dayOfMonth: number | null = null;
  let nextDueDate: string | null = null;

  if (frequency === "monthly") {
    if (!args.day) {
      fail("Missing required argument: --day (required when --frequency monthly).");
    }
    if (args["next-due"]) {
      fail("--next-due is only valid with --frequency fortnightly or weekly.");
    }
    const parsed = Number(args.day);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
      fail(`Invalid --day "${args.day}". Must be an integer 1–31.`);
    }
    dayOfMonth = parsed;
  } else {
    if (!args["next-due"]) {
      fail(
        `Missing required argument: --next-due (required when --frequency ${frequency}).`,
      );
    }
    if (args.day) {
      fail("--day is only valid with --frequency monthly.");
    }
    if (!isValidYMD(args["next-due"]!)) {
      fail(`Invalid --next-due "${args["next-due"]}". Must be YYYY-MM-DD.`);
    }
    nextDueDate = args["next-due"]!;
  }

  const { amount, displayName } = parseAmount(args.amount!, args.name!);
  if (amount <= 0) {
    fail(`Invalid --amount "${args.amount}". Must be > 0.`);
  }

  const type = args.type ?? "manual";
  const accountId = args.account ?? null;

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO recurring_bills (name, amount, day_of_month, type, account_id, frequency, next_due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(displayName, amount, dayOfMonth, type, accountId, frequency, nextDueDate);

  console.log(`Added bill (id=${result.lastInsertRowid}):`);
  printField("name", displayName);
  printField("amount", amount.toFixed(2));
  printField("frequency", frequency);
  if (frequency === "monthly") {
    printField("day_of_month", String(dayOfMonth));
  } else {
    printField("next_due_date", nextDueDate!);
  }
  printField("type", type);
  printField("account_id", accountId ?? "(none)");
}

/** Strict YYYY-MM-DD validator that also rejects impossible dates like 2026-02-30. */
function isValidYMD(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  return s === d.toISOString().slice(0, 10);
}

function printField(label: string, value: string): void {
  console.log(`  ${(label + ":").padEnd(15)} ${value}`);
}

interface ParsedAmount {
  amount: number;
  displayName: string;
}

/**
 * Resolve a `--amount` value plus the user-supplied `--name` into the
 * single number we store in `amount` and the (possibly annotated) name we
 * store in `name`. Range inputs become "Name ($lo-$hi)" with the midpoint
 * as the numeric amount.
 */
function parseAmount(raw: string, baseName: string): ParsedAmount {
  if (raw.includes("~")) {
    const parts = raw.split("~");
    if (parts.length !== 2) {
      fail(`Invalid --amount range "${raw}". Expected "min~max".`);
    }
    const a = Number.parseFloat(parts[0]);
    const b = Number.parseFloat(parts[1]);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      fail(`Invalid --amount range "${raw}". Both sides must be numeric.`);
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return {
      amount: (lo + hi) / 2,
      displayName: `${baseName} ($${formatBound(lo)}-$${formatBound(hi)})`,
    };
  }

  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) {
    fail(`Invalid --amount "${raw}". Expected a number.`);
  }
  return { amount: value, displayName: baseName };
}

/** Drop a trailing `.00` so whole-dollar bounds render as "$250", not "$250.00". */
function formatBound(n: number): string {
  const fixed = n.toFixed(2);
  return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed;
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

function doList(): void {
  const db = getDb();
  // Order: monthly first (sorted by day-of-month), then fortnightly and
  // weekly (sorted by next anchor date), then anything unrecognised.
  const rows = db
    .prepare(
      `SELECT id, name, amount, day_of_month, type, account_id, frequency, next_due_date
         FROM recurring_bills
        ORDER BY
          CASE frequency
            WHEN 'monthly' THEN 1
            WHEN 'fortnightly' THEN 2
            WHEN 'weekly' THEN 3
            ELSE 4
          END,
          day_of_month,
          next_due_date,
          name`,
    )
    .all() as BillRow[];

  console.log(`Recurring bills (${rows.length}):`);
  console.log("");

  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }

  const headers = ["schedule", "amount", "type", "name", "account_id"];
  const data = rows.map((r) => [
    formatSchedule(r),
    r.amount.toFixed(2),
    r.type ?? "-",
    r.name,
    r.account_id ?? "-",
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
}

/**
 * Render the bill's schedule as a single human-readable string for the
 * `list` view: "day 22", "fortnightly from 2026-05-14", "weekly from ...".
 * Falls back to the raw frequency value if the schedule is malformed.
 */
function formatSchedule(r: BillRow): string {
  if (r.frequency === "monthly") {
    return r.day_of_month !== null ? `day ${r.day_of_month}` : "monthly";
  }
  if (r.frequency === "fortnightly") {
    return r.next_due_date ? `fortnightly from ${r.next_due_date}` : "fortnightly";
  }
  if (r.frequency === "weekly") {
    return r.next_due_date ? `weekly from ${r.next_due_date}` : "weekly";
  }
  return r.frequency || "-";
}

// ---------------------------------------------------------------------------
// Subcommand: remove
// ---------------------------------------------------------------------------

function doRemove(args: Record<string, string | undefined>): void {
  if (!args.name) {
    fail("Missing required argument: --name.");
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, name, amount, day_of_month, type, account_id, frequency, next_due_date
         FROM recurring_bills
        WHERE name = ?`,
    )
    .get(args.name) as BillRow | undefined;

  if (!row) {
    fail(`No recurring bill found with name "${args.name}".`);
  }

  db.prepare(`DELETE FROM recurring_bills WHERE id = ?`).run(row.id);

  console.log(`Removed bill (id=${row.id}):`);
  printField("name", row.name);
  printField("amount", row.amount.toFixed(2));
  printField("schedule", formatSchedule(row));
  printField("type", row.type ?? "-");
  printField("account_id", row.account_id ?? "-");
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  console.error("bill-cli failed:");
  console.error(err);
  process.exit(1);
}
