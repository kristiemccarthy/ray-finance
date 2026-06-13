// ---------------------------------------------------------------------------
// Pure-function tests for transaction identity.
//
// Covers the design's Test E (alias edits don't change identity) and Test G
// (deriveTransactionId is deterministic and ordinal-sensitive), plus the
// core invariant of the hash-function fix: balance is no longer part of the
// identity, so it can drift freely without minting duplicates.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { deriveTransactionId, mapTransactionRowFromImported } from "./mappers.js";
import type { ImportedRow } from "./types.js";

const ACCT = "csv:st-george:test";

function row(over: Partial<ImportedRow> = {}): ImportedRow {
  return {
    date: "2026-06-08",
    description: "Provender Australia",
    raw_description: "PROVENDER AUSTRALIA SILVERWATER AUS",
    amount: 4.4,
    balance: 1000,
    ...over,
  };
}

describe("deriveTransactionId (Test G — pure unit)", () => {
  it("is deterministic for identical inputs", () => {
    expect(deriveTransactionId(ACCT, row(), 1)).toBe(
      deriveTransactionId(ACCT, row(), 1),
    );
  });

  it("is ordinal-sensitive: ordinal n and n+1 hash differently", () => {
    expect(deriveTransactionId(ACCT, row(), 1)).not.toBe(
      deriveTransactionId(ACCT, row(), 2),
    );
  });

  it("returns exactly 32 lowercase hex chars", () => {
    expect(deriveTransactionId(ACCT, row(), 1)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is unaffected by balance (drift-proof — the headline property)", () => {
    expect(deriveTransactionId(ACCT, row({ balance: 1000 }), 1)).toBe(
      deriveTransactionId(ACCT, row({ balance: 9999.99 }), 1),
    );
  });

  it("is unaffected by a null balance", () => {
    expect(deriveTransactionId(ACCT, row({ balance: null }), 1)).toBe(
      deriveTransactionId(ACCT, row({ balance: 12.34 }), 1),
    );
  });

  it("changes with raw_description, amount, date, account and ordinal", () => {
    const base = deriveTransactionId(ACCT, row(), 1);
    expect(deriveTransactionId(ACCT, row({ raw_description: "COLES 0924" }), 1)).not.toBe(base);
    expect(deriveTransactionId(ACCT, row({ amount: 4.41 }), 1)).not.toBe(base);
    expect(deriveTransactionId(ACCT, row({ date: "2026-06-09" }), 1)).not.toBe(base);
    expect(deriveTransactionId("csv:st-george:other", row(), 1)).not.toBe(base);
    expect(deriveTransactionId(ACCT, row(), 2)).not.toBe(base);
  });
});

describe("alias edits don't change identity (Test E)", () => {
  it("same raw_description but different display description → same id", () => {
    // `description` is the post-alias display name; a merchant rename in the
    // alias map rewrites it on every prior row. Identity must ignore it.
    const a = mapTransactionRowFromImported(
      row({ description: "Provender" }),
      ACCT,
      "AUD",
      [],
      1,
    );
    const b = mapTransactionRowFromImported(
      row({ description: "Provender Cafe (renamed in alias map)" }),
      ACCT,
      "AUD",
      [],
      1,
    );
    expect(a.transaction_id).toBe(b.transaction_id);
  });
});
