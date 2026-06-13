// ---------------------------------------------------------------------------
// End-to-end import tests driving the real parse → map → upsert pipeline
// against an in-memory DB. Covers the design's Tests A, B, C, D, F and H.
//
// The DB connection module is mocked so runImport (and the recurring
// detector / categoriser it transitively calls) all share one in-memory
// libsql instance per test.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "libsql";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrate } from "../db/schema.js";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../db/connection.js", () => ({
  getDb: () => h.db,
  closeAll: () => {
    h.db?.close?.();
  },
}));

import { runImport } from "./importer.js";
import type { ImportConfig } from "./types.js";

// ---- fixtures -------------------------------------------------------------

type Row = {
  date: string; // D/MM/YYYY
  desc: string;
  debit?: string;
  credit?: string;
  balance: string;
};

function sgCsv(rows: Row[]): string {
  const header = "Date,Description,Debit,Credit,Balance";
  // St George data rows carry a trailing comma the header doesn't — the
  // parser tolerates the extra empty cell via relax_column_count.
  const lines = rows.map(
    (r) => `${r.date},${r.desc},${r.debit ?? ""},${r.credit ?? ""},${r.balance},`,
  );
  return [header, ...lines].join("\n") + "\n";
}

let tmp: string;

function writeCsv(name: string, rows: Row[]): string {
  const p = join(tmp, name);
  writeFileSync(p, sgCsv(rows));
  return p;
}

function config(filePath: string): ImportConfig {
  return {
    source: "st-george",
    bankName: "St George",
    accountName: "Test",
    accountType: "depository",
    accountSubtype: "checking",
    currency: "AUD",
    filePath,
    intraDayOrder: "newest-first",
  };
}

function freshDb(): void {
  h.db = new Database(":memory:");
  h.db.pragma("foreign_keys = ON");
  migrate(h.db);
}

function txnCount(): number {
  return (h.db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get() as { n: number }).n;
}

function idsFor(date: string, amount: number): string[] {
  return (
    h.db
      .prepare(`SELECT transaction_id FROM transactions WHERE date=? AND amount=?`)
      .all(date, amount) as { transaction_id: string }[]
  ).map((r) => r.transaction_id);
}

beforeEach(() => {
  freshDb();
  tmp = mkdtempSync(join(tmpdir(), "ray-import-test-"));
});

// ---- tests ----------------------------------------------------------------

describe("CSV import — transaction identity (hash-function fix)", () => {
  it("A: two identical same-day rows import as two distinct transactions", async () => {
    const p = writeCsv("a.csv", [
      { date: "8/06/2026", desc: "PROVENDER AUSTRALIA SILVERWATER AUS", debit: "4.40", balance: "100.00" },
      { date: "8/06/2026", desc: "PROVENDER AUSTRALIA SILVERWATER AUS", debit: "4.40", balance: "95.60" },
    ]);
    const res = await runImport(config(p));
    expect(res.transactionsAdded).toBe(2);

    const ids = idsFor("2026-06-08", 4.4);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2); // ordinals 1 and 2 → distinct ids
  });

  it("B: re-importing the exact same file adds zero new rows", async () => {
    const rows: Row[] = [
      { date: "8/06/2026", desc: "PROVENDER AUSTRALIA", debit: "4.40", balance: "100.00" },
      { date: "7/06/2026", desc: "COLES 0924 ROUSE HILL", debit: "20.00", balance: "104.40" },
    ];
    expect((await runImport(config(writeCsv("b1.csv", rows)))).transactionsAdded).toBe(2);

    const second = await runImport(config(writeCsv("b2.csv", rows)));
    expect(second.transactionsAdded).toBe(0);
    expect(txnCount()).toBe(2);
  });

  it("C: re-importing the same statement with DRIFTED balances adds zero new rows", async () => {
    // Headline regression test for the exact bug this fix targets.
    const first = await runImport(
      config(
        writeCsv("c1.csv", [
          { date: "8/06/2026", desc: "PROVENDER AUSTRALIA", debit: "4.40", balance: "100.00" },
          { date: "7/06/2026", desc: "COLES 0924 ROUSE HILL", debit: "20.00", balance: "104.40" },
        ]),
      ),
    );
    expect(first.transactionsAdded).toBe(2);
    const before = txnCount();

    // Same logical rows; every running balance shifted, as happens when the
    // bank reissues a statement (pending settling / back-dated correction).
    // The old balance-in-hash design minted duplicates here; the new design
    // must produce zero new rows.
    const second = await runImport(
      config(
        writeCsv("c2.csv", [
          { date: "8/06/2026", desc: "PROVENDER AUSTRALIA", debit: "4.40", balance: "250.00" },
          { date: "7/06/2026", desc: "COLES 0924 ROUSE HILL", debit: "20.00", balance: "254.40" },
        ]),
      ),
    );
    expect(second.transactionsAdded).toBe(0);
    expect(txnCount()).toBe(before);
  });

  it("D: a singleton row gets a stable id across re-import", async () => {
    const rows: Row[] = [
      { date: "8/06/2026", desc: "AMAZON PRIME", debit: "9.99", balance: "100.00" },
    ];
    expect((await runImport(config(writeCsv("d1.csv", rows)))).transactionsAdded).toBe(1);
    const idBefore = idsFor("2026-06-08", 9.99);
    expect(idBefore.length).toBe(1);

    const second = await runImport(config(writeCsv("d2.csv", rows)));
    expect(second.transactionsAdded).toBe(0);
    expect(idsFor("2026-06-08", 9.99)).toEqual(idBefore);
  });

  it("F: reversing the file order of two identical rows yields the same id set", async () => {
    const a: Row = { date: "8/06/2026", desc: "PROVENDER AUSTRALIA", debit: "4.40", balance: "100.00" };
    const b: Row = { date: "8/06/2026", desc: "PROVENDER AUSTRALIA", debit: "4.40", balance: "95.60" };

    await runImport(config(writeCsv("f1.csv", [a, b])));
    const set1 = new Set(idsFor("2026-06-08", 4.4));

    freshDb();
    await runImport(config(writeCsv("f2.csv", [b, a]))); // reversed order
    const set2 = new Set(idsFor("2026-06-08", 4.4));

    expect(set2).toEqual(set1);
  });

  it("H: overlapping-date exports re-import shared days with zero new rows", async () => {
    // File 1 covers Jun 1–3.
    const first = await runImport(
      config(
        writeCsv("h1.csv", [
          { date: "1/06/2026", desc: "MERCHANT A", debit: "10.00", balance: "100.00" },
          { date: "2/06/2026", desc: "MERCHANT B", debit: "20.00", balance: "80.00" },
          { date: "3/06/2026", desc: "MERCHANT C", debit: "30.00", balance: "50.00" },
        ]),
      ),
    );
    expect(first.transactionsAdded).toBe(3);

    // File 2 covers Jun 2–4 (overlapping Jun 2–3), with drifted balances.
    // Only Jun 4 is genuinely new.
    const second = await runImport(
      config(
        writeCsv("h2.csv", [
          { date: "2/06/2026", desc: "MERCHANT B", debit: "20.00", balance: "999.00" },
          { date: "3/06/2026", desc: "MERCHANT C", debit: "30.00", balance: "969.00" },
          { date: "4/06/2026", desc: "MERCHANT D", debit: "40.00", balance: "929.00" },
        ]),
      ),
    );
    expect(second.transactionsAdded).toBe(1);
    expect(txnCount()).toBe(4);
  });
});
