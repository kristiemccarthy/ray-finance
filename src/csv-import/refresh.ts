// ---------------------------------------------------------------------------
// Multi-source refresh orchestrator.
//
// Sits between `runImport` (one parser, one file) and a UI button that wants
// to suck the latest of *every* bank statement out of a single download
// directory. Knows the expected file mappings, finds matching files (exact
// names or glob patterns), runs each through `runImport` independently, and
// aggregates per-source success / failure counts into a single summary the
// UI can format into a toast.
//
// Failure isolation: each import is wrapped in its own try/catch so one
// malformed CSV doesn't take down the whole refresh. Missing files are
// skipped silently — the summary reports them as "skipped", not "failed".
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { runImport } from "./importer.js";
import type { ImportSource, IntraDayOrder } from "./types.js";

// ---------------------------------------------------------------------------
// Source specifications
// ---------------------------------------------------------------------------

interface SourceSpec {
  /** Display label shown in error messages and the UI summary. */
  label: string;
  source: ImportSource;
  bankName: string;
  accountName: string;
  accountType: string;
  accountSubtype: string;
  /** Same-day row-order convention — see `IntraDayOrder` in types.ts. */
  intraDayOrder: IntraDayOrder;
  /**
   * How to locate matching files in the download directory.
   *   - `exact`: a single file with this exact name (one occurrence).
   *   - `pattern`: every directory entry passing `matcher`, processed in
   *     order of file mtime (oldest first) so the freshest statement's
   *     balance lands last and wins on the account row.
   */
  match:
    | { kind: "exact"; fileName: string }
    | { kind: "pattern"; matcher: (name: string) => boolean };
}

const SOURCES: SourceSpec[] = [
  {
    label: "St George Personal",
    source: "st-george",
    bankName: "St George",
    accountName: "Personal",
    accountType: "depository",
    accountSubtype: "checking",
    intraDayOrder: "newest-first",
    match: { kind: "exact", fileName: "St George Personal.csv" },
  },
  {
    label: "St George Mojo",
    source: "st-george",
    bankName: "St George",
    accountName: "Mojo",
    accountType: "depository",
    accountSubtype: "savings",
    intraDayOrder: "newest-first",
    match: { kind: "exact", fileName: "St George Mojo.csv" },
  },
  {
    label: "Accesspay Salary Card",
    source: "accesspay",
    bankName: "Accesspay",
    accountName: "Salary Card",
    accountType: "depository",
    accountSubtype: "prepaid",
    intraDayOrder: "oldest-first",
    match: {
      kind: "pattern",
      // Accesspay statements come down as one PDF per financial year, with
      // a fixed leading reference number and "Expense" tag. Anchored on
      // both ends so we don't accidentally pick up an unrelated PDF.
      matcher: (name) =>
        /^1204396- Kristie Mccarthy- Expense .+\.pdf$/i.test(name),
    },
  },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RefreshSourceResult {
  /** Source spec label (e.g. "St George Personal"). */
  label: string;
  /** Absolute path of the imported file. */
  filePath: string;
  ok: boolean;
  transactionsAdded: number;
  transactionsUpdated: number;
  /** Set only on failure. */
  error?: string;
}

export interface RefreshSummary {
  /** ISO timestamp when the refresh ran (server time). */
  ranAt: string;
  /** Number of files actually fed to `runImport` (succeeded + failed). */
  filesAttempted: number;
  /** Source specs whose file wasn't present in the download directory. */
  sourcesSkipped: number;
  /** Files that imported cleanly. */
  filesSucceeded: number;
  /** Files that threw during parse / write. */
  filesFailed: number;
  /** Newly-inserted transactions across all successful imports. */
  transactionsAdded: number;
  /** Existing transactions whose rows were overwritten. */
  transactionsUpdated: number;
  /** Per-file outcome, in the order files were processed. */
  details: RefreshSourceResult[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Walk every configured source, import any matching files, and return a
 * single aggregate summary. Never throws — every error is captured in the
 * `details` array so the caller can render a useful message even when one
 * statement is corrupt.
 */
export async function refreshFromDirectory(dir: string): Promise<RefreshSummary> {
  const details: RefreshSourceResult[] = [];
  let filesAttempted = 0;
  let sourcesSkipped = 0;
  let filesSucceeded = 0;
  let filesFailed = 0;
  let transactionsAdded = 0;
  let transactionsUpdated = 0;

  for (const spec of SOURCES) {
    const matchedFiles = findFiles(dir, spec);
    if (matchedFiles.length === 0) {
      sourcesSkipped++;
      continue;
    }

    for (const filePath of matchedFiles) {
      filesAttempted++;
      try {
        const result = await runImport({
          source: spec.source,
          bankName: spec.bankName,
          accountName: spec.accountName,
          accountType: spec.accountType,
          accountSubtype: spec.accountSubtype,
          currency: "AUD",
          filePath,
          intraDayOrder: spec.intraDayOrder,
        });
        filesSucceeded++;
        transactionsAdded += result.transactionsAdded;
        transactionsUpdated += result.transactionsUpdated;
        details.push({
          label: spec.label,
          filePath,
          ok: true,
          transactionsAdded: result.transactionsAdded,
          transactionsUpdated: result.transactionsUpdated,
        });
      } catch (err) {
        filesFailed++;
        const message = err instanceof Error ? err.message : String(err);
        details.push({
          label: spec.label,
          filePath,
          ok: false,
          transactionsAdded: 0,
          transactionsUpdated: 0,
          error: message,
        });
      }
    }
  }

  return {
    ranAt: new Date().toISOString(),
    filesAttempted,
    sourcesSkipped,
    filesSucceeded,
    filesFailed,
    transactionsAdded,
    transactionsUpdated,
    details,
  };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Resolve a `SourceSpec` to zero or more concrete file paths.
 *
 *   - `exact`: a single existence check.
 *   - `pattern`: enumerate the directory once, filter by the matcher, and
 *     sort by mtime ascending so the most-recent statement is imported
 *     last. The account row's balance reflects whatever the latest file
 *     said, so import order matters.
 *
 * A missing or unreadable directory returns `[]` rather than throwing,
 * keeping refresh tolerant of fresh installs that haven't dropped files
 * in place yet.
 */
function findFiles(dir: string, spec: SourceSpec): string[] {
  if (spec.match.kind === "exact") {
    const full = path.join(dir, spec.match.fileName);
    return fs.existsSync(full) ? [full] : [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const matcher = spec.match.matcher;
  const candidates: { full: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!matcher(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      candidates.push({ full, mtime: stat.mtimeMs });
    } catch {
      // Skip entries we can't stat — they'll show up as a missing file
      // next pass, no need to abort the rest of the refresh.
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  return candidates.map((c) => c.full);
}
