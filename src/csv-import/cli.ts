// ---------------------------------------------------------------------------
// CLI entry point for CSV imports.
//
// Run with:
//   npx tsx src/csv-import/cli.ts \
//     --source st-george \
//     --bank "St George" \
//     --account "Joint Cheque" \
//     --type depository \
//     --subtype checking \
//     --file ~/Downloads/transactions.csv
//
// Optional: --currency AUD (default).
// ---------------------------------------------------------------------------

import path from "node:path";
import { runImport } from "./importer.js";
import type { ImportConfig, ImportSource, IntraDayOrder } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SOURCES: readonly ImportSource[] = ["st-george", "accesspay"];
const VALID_TYPES = [
  "depository",
  "credit",
  "loan",
  "investment",
  "other",
] as const;
const VALID_INTRA_DAY_ORDERS: readonly IntraDayOrder[] = [
  "newest-first",
  "oldest-first",
];

const USAGE = `
Usage: tsx src/csv-import/cli.ts [options]

Required:
  --source <st-george|accesspay>   CSV source format
  --bank <name>                    Institution display name (e.g. "St George")
  --account <name>                 Account nickname (e.g. "Joint Cheque")
  --type <type>                    Account type: ${VALID_TYPES.join(" | ")}
  --subtype <string>               Account subtype (e.g. "checking", "savings")
  --file <path>                    Path to the CSV file

Optional:
  --currency <code>                ISO 4217 currency code (default: AUD)
  --intra-day-order <order>        Same-day row ordering in the source file:
                                   "newest-first" (default, e.g. St George CSV)
                                   or "oldest-first" (e.g. AccessPay PDF)
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const missing = ["source", "bank", "account", "type", "subtype", "file"].filter(
    (key) => !args[key],
  );
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(", ")}`);
    console.error("");
    console.error(USAGE);
    process.exit(1);
  }

  const source = args.source as string;
  if (!VALID_SOURCES.includes(source as ImportSource)) {
    console.error(
      `Invalid --source "${source}". Expected one of: ${VALID_SOURCES.join(", ")}.`,
    );
    process.exit(1);
  }

  const accountType = args.type as string;
  if (!VALID_TYPES.includes(accountType as (typeof VALID_TYPES)[number])) {
    console.error(
      `Invalid --type "${accountType}". Expected one of: ${VALID_TYPES.join(", ")}.`,
    );
    process.exit(1);
  }

  const intraDayOrderArg = (args["intra-day-order"] ?? "newest-first") as string;
  if (!VALID_INTRA_DAY_ORDERS.includes(intraDayOrderArg as IntraDayOrder)) {
    console.error(
      `Invalid --intra-day-order "${intraDayOrderArg}". Expected one of: ${VALID_INTRA_DAY_ORDERS.join(", ")}.`,
    );
    process.exit(1);
  }

  const config: ImportConfig = {
    source: source as ImportSource,
    bankName: args.bank!,
    accountName: args.account!,
    accountType,
    accountSubtype: args.subtype!,
    currency: args.currency ?? "AUD",
    filePath: path.resolve(args.file!),
    intraDayOrder: intraDayOrderArg as IntraDayOrder,
  };

  const result = await runImport(config);

  console.log("");
  console.log("ImportResult:");
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Walk `argv` looking for `--key value` pairs. Unknown flags raise; values
 * that look like another flag (start with `--`) are treated as missing
 * values rather than silently absorbed.
 */
function parseArgs(argv: string[]): Record<string, string | undefined> {
  const known = new Set([
    "source",
    "bank",
    "account",
    "type",
    "subtype",
    "file",
    "currency",
  ]);
  const out: Record<string, string | undefined> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      console.error(`Unexpected positional argument: "${token}".`);
      console.error("");
      console.error(USAGE);
      process.exit(1);
    }
    const key = token.slice(2);
    if (!known.has(key)) {
      console.error(`Unknown option: --${key}.`);
      console.error("");
      console.error(USAGE);
      process.exit(1);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`Option --${key} requires a value.`);
      console.error("");
      console.error(USAGE);
      process.exit(1);
    }
    out[key] = value;
    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("CSV import failed:");
  console.error(err);
  if (err && typeof err === "object" && "body" in err) {
    console.error("Full error body:");
    console.error(JSON.stringify((err as { body: unknown }).body, null, 2));
  }
  process.exit(1);
});
