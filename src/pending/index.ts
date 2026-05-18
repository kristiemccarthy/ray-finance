// ---------------------------------------------------------------------------
// Pending-transactions module.
//
// "Pending" is the bank's holding bucket — transactions that have been
// authorised but haven't cleared yet. They aren't in the normal
// `transactions` table (which is settled-only) and they don't sync via
// Plaid for this user's bank, so we read them from a screenshot of the
// online banking pending list and pipe the image through Claude vision.
//
// Strategy is deliberately destructive: every refresh wipes
// `pending_transactions` and re-inserts whatever the screenshot showed.
// We don't bother de-duplicating or matching against settled rows because
// the screenshot itself is authoritative — anything that was pending and
// has now cleared simply won't appear in the next snapshot.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "../db/connection.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PendingTransaction {
  description: string;
  /**
   * Sign follows the rest of the app (Plaid convention): positive = money
   * out (debit), negative = money in (refund). Bank pending screens
   * typically show debit rows as positive numbers, so the natural
   * extraction matches without sign-flipping.
   */
  amount: number;
  /** Request date from the bank in YYYY-MM-DD form. */
  date: string;
}

export interface PendingSummary {
  total: number;
  count: number;
}

/** Image MIME types Anthropic's vision API accepts. */
export type SupportedImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

// Claude Sonnet 4.6 — current generally-available Sonnet (per
// https://docs.claude.com/en/docs/about-claude/models, as of May 2026).
// All Claude 4 models support vision. The dateless `-4-6` ID is itself a
// pinned snapshot starting with the 4.6 generation, not an evergreen
// pointer that drifts under us. The previous `claude-sonnet-4-20250514`
// is deprecated and returns 404; the older `claude-3-5-sonnet-*` IDs are
// also retired. Bump to `claude-sonnet-5-X` (or whatever supersedes 4.6)
// when migrating in future.
const VISION_MODEL = "claude-sonnet-4-6";

/**
 * Exact prompt text — kept verbatim from the spec so prompt tweaks land
 * in version control with intent attached. If the model starts misreading
 * one column, edit here and commit the change.
 */
const EXTRACTION_PROMPT = `This is a screenshot of pending bank transactions from a bank statement. Extract each transaction row. Ignore header rows, summary rows, and the Total row. Return ONLY valid JSON in this exact format: [{"description": string, "amount": number, "date": "YYYY-MM-DD"}]. The date in the screenshot is in DD/MM/YYYY format; convert to YYYY-MM-DD. Do not include any markdown, code fences, or commentary.`;

// ---------------------------------------------------------------------------
// Vision extraction
// ---------------------------------------------------------------------------

/**
 * Send a base64-encoded screenshot to Claude and parse the JSON response
 * into a typed list of pending rows.
 *
 * Cost note: each invocation runs roughly 1500 input tokens (image) plus
 * a small text response — approximately 1–2 US cents per call at current
 * Sonnet 4 pricing. Worth knowing when reading the monthly invoice.
 *
 * Throws on any of: missing API key, network error, non-text response,
 * malformed JSON, or rows that don't satisfy the public shape. The caller
 * is expected to surface these as a user-facing error and skip the DB
 * write.
 */
export async function extractPendingFromImage(
  imageBytes: Buffer,
  mimeType: SupportedImageMimeType,
): Promise<PendingTransaction[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — the Next.js server needs it in its process environment.",
    );
  }

  const client = new Anthropic({ apiKey });
  const base64 = imageBytes.toString("base64");

  const response = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: base64 },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const textBlock = response.content.find(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  if (!textBlock) {
    throw new Error("Claude returned no text content in the response.");
  }

  const parsed = parseJsonArrayLoose(textBlock.text);
  return validateRows(parsed);
}

/**
 * Strict JSON parse with a small allowance for Claude occasionally wrapping
 * its output in ```json fences despite being told not to. Trims whitespace,
 * peels one layer of code fence if present, then hands off to `JSON.parse`.
 */
function parseJsonArrayLoose(raw: string): unknown {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  try {
    return JSON.parse(s);
  } catch (err) {
    const snippet = s.length > 200 ? `${s.slice(0, 200)}…` : s;
    throw new Error(
      `Couldn't parse JSON from Claude response. First 200 chars: ${snippet}`,
    );
  }
}

function validateRows(input: unknown): PendingTransaction[] {
  if (!Array.isArray(input)) {
    throw new Error(
      `Expected a JSON array of pending rows, got ${typeof input}.`,
    );
  }
  const rows: PendingTransaction[] = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (typeof row !== "object" || row === null) {
      throw new Error(`Row ${i} is not an object: ${JSON.stringify(row)}`);
    }
    const r = row as Record<string, unknown>;
    if (typeof r.description !== "string") {
      throw new Error(`Row ${i} is missing a string \`description\`.`);
    }
    if (typeof r.amount !== "number" || !Number.isFinite(r.amount)) {
      throw new Error(`Row ${i} is missing a finite \`amount\`.`);
    }
    if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      throw new Error(`Row ${i} has invalid \`date\` (expected YYYY-MM-DD).`);
    }
    rows.push({ description: r.description, amount: r.amount, date: r.date });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// DB ops
// ---------------------------------------------------------------------------

/**
 * Wipe `pending_transactions` and replace it with `rows`. Wrapped in a
 * single transaction so a half-finished write can't leave the table in
 * an inconsistent state.
 */
export function replacePending(rows: PendingTransaction[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO pending_transactions (description, amount, date) VALUES (?, ?, ?)`,
  );
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM pending_transactions`).run();
    for (const r of rows) {
      insert.run(r.description, r.amount, r.date);
    }
  });
  write();
}

/**
 * Aggregate sum + count for the fortnight view. Returns zeros when the
 * table is empty (sum of an empty set is NULL → coalesced to 0).
 */
export function getPendingSummary(): PendingSummary {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM pending_transactions`,
    )
    .get() as { total: number; count: number };
  return { total: row.total, count: row.count };
}
