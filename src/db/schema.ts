import type Database from "libsql";
// `recategoriseAllTransactions` is imported eagerly here — schema.ts is
// loaded from connection.ts, and recategorise.ts also re-imports
// connection.ts. ESM handles the cycle because nothing at module top
// level dereferences the cyclic bindings; the actual `getDb` call inside
// recategorise is bypassed by passing our own `db` instance through.
import { recategoriseAllTransactions } from "../csv-import/recategorise.js";

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS institutions (
      item_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      name TEXT NOT NULL,
      products TEXT NOT NULL DEFAULT '[]',
      cursor TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES institutions(item_id),
      name TEXT NOT NULL,
      official_name TEXT,
      type TEXT NOT NULL,
      subtype TEXT,
      mask TEXT,
      current_balance REAL,
      available_balance REAL,
      currency TEXT,
      hidden INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      raw_name TEXT,
      merchant_name TEXT,
      category TEXT,
      subcategory TEXT,
      pending INTEGER DEFAULT 0,
      iso_currency_code TEXT,
      payment_channel TEXT,
      logo_url TEXT,
      website TEXT,
      label TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS holdings (
      holding_id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      security_id TEXT,
      quantity REAL NOT NULL,
      cost_basis REAL,
      value REAL,
      price REAL,
      price_as_of TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(account_id, security_id)
    );

    CREATE TABLE IF NOT EXISTS securities (
      security_id TEXT PRIMARY KEY,
      name TEXT,
      ticker TEXT,
      type TEXT,
      close_price REAL,
      close_price_as_of TEXT
    );

    CREATE TABLE IF NOT EXISTS liabilities (
      liability_id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      type TEXT NOT NULL,
      interest_rate REAL,
      origination_date TEXT,
      original_balance REAL,
      current_balance REAL,
      minimum_payment REAL,
      next_payment_due TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(account_id, type)
    );

    CREATE TABLE IF NOT EXISTS net_worth_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_assets REAL NOT NULL,
      total_liabilities REAL NOT NULL,
      net_worth REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      monthly_limit REAL NOT NULL,
      period TEXT DEFAULT 'monthly',
      UNIQUE(category, period)
    );

    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'savings',
      mode TEXT NOT NULL DEFAULT 'balance',
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL DEFAULT 0,
      target_date TEXT,
      account_id TEXT,
      category TEXT,
      included_bill_ids TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (date('now')),
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS goal_contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      contribution_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (date('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goal_contributions_goal_id
      ON goal_contributions(goal_id);

    CREATE TABLE IF NOT EXISTS recurring (
      stream_id TEXT PRIMARY KEY,
      account_id TEXT,
      merchant_name TEXT,
      description TEXT NOT NULL,
      frequency TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      avg_amount REAL NOT NULL,
      last_amount REAL,
      first_date TEXT,
      last_date TEXT,
      is_active INTEGER DEFAULT 1,
      status TEXT,
      stream_type TEXT NOT NULL DEFAULT 'outflow',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      score INTEGER NOT NULL,
      restaurant_count INTEGER DEFAULT 0,
      shopping_count INTEGER DEFAULT 0,
      food_spend REAL DEFAULT 0,
      total_spend REAL DEFAULT 0,
      zero_spend INTEGER DEFAULT 0,
      no_restaurant_streak INTEGER DEFAULT 0,
      no_shopping_streak INTEGER DEFAULT 0,
      on_pace_streak INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      unlocked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recategorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_field TEXT NOT NULL,
      match_pattern TEXT NOT NULL,
      target_category TEXT NOT NULL,
      target_subcategory TEXT,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS recurring_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      day_of_month INTEGER,
      type TEXT,
      account_id TEXT,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      next_due_date TEXT,
      last_paid_date TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paypal_transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      merchant_name TEXT NOT NULL,
      type TEXT,
      currency TEXT,
      gross REAL,
      matched_transaction_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_paypal_date_amount
      ON paypal_transactions(date, gross);

    CREATE TABLE IF NOT EXISTS category_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      note TEXT,
      flow_type TEXT,
      set_category INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (date('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_category_overrides_pattern
      ON category_overrides(match_pattern);

    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_date TEXT,
      monthly_savings REAL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS investment_transactions (
      investment_transaction_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      security_id TEXT,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      quantity REAL,
      amount REAL NOT NULL,
      price REAL,
      fees REAL,
      type TEXT,
      subtype TEXT,
      iso_currency_code TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      input_params TEXT,
      result_summary TEXT,
      tokens_used INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add logo and primary_color to institutions
  const instCols = db.prepare(`PRAGMA table_info(institutions)`).all() as { name: string }[];
  if (!instCols.some(c => c.name === "logo")) {
    db.exec(`ALTER TABLE institutions ADD COLUMN logo TEXT`);
    db.exec(`ALTER TABLE institutions ADD COLUMN primary_color TEXT`);
  }

  // Migrate: rename goals.deadline -> target_date for existing databases
  const goalCols = db.prepare(`PRAGMA table_info(goals)`).all() as { name: string }[];
  if (goalCols.some(c => c.name === "deadline") && !goalCols.some(c => c.name === "target_date")) {
    db.exec(`ALTER TABLE goals RENAME COLUMN deadline TO target_date`);
  }

  // Migrate: extend goals with multi-type columns (savings / category-cap /
  // subscription-cap). Old single-type rows survive — `type` defaults to
  // 'savings', which matches their original semantics. `created_at` is
  // backfilled via UPDATE because SQLite can't put `(date('now'))` in a
  // column default added via ALTER TABLE.
  const goalCols2 = db.prepare(`PRAGMA table_info(goals)`).all() as { name: string }[];
  if (!goalCols2.some(c => c.name === "type")) {
    db.exec(`ALTER TABLE goals ADD COLUMN type TEXT NOT NULL DEFAULT 'savings'`);
  }
  if (!goalCols2.some(c => c.name === "account_id")) {
    db.exec(`ALTER TABLE goals ADD COLUMN account_id TEXT`);
  }
  if (!goalCols2.some(c => c.name === "category")) {
    db.exec(`ALTER TABLE goals ADD COLUMN category TEXT`);
  }
  if (!goalCols2.some(c => c.name === "included_bill_ids")) {
    db.exec(`ALTER TABLE goals ADD COLUMN included_bill_ids TEXT`);
  }
  if (!goalCols2.some(c => c.name === "created_at")) {
    db.exec(`ALTER TABLE goals ADD COLUMN created_at TEXT`);
    db.exec(`UPDATE goals SET created_at = date('now') WHERE created_at IS NULL`);
  }
  if (!goalCols2.some(c => c.name === "archived_at")) {
    db.exec(`ALTER TABLE goals ADD COLUMN archived_at TEXT`);
  }

  // Migrate: add `mode` to goals so savings can be tracked either against
  // an account balance (existing behaviour) or against an explicit ledger of
  // user-logged contributions. Pre-existing rows backfill to 'balance' which
  // preserves their meaning verbatim.
  if (!goalCols2.some(c => c.name === "mode")) {
    db.exec(`ALTER TABLE goals ADD COLUMN mode TEXT NOT NULL DEFAULT 'balance'`);
  }

  // Migrate: add balance_limit to accounts
  const acctCols = db.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[];
  if (!acctCols.some(c => c.name === "balance_limit")) {
    db.exec(`ALTER TABLE accounts ADD COLUMN balance_limit REAL`);
  }

  // Migrate: add vesting columns to holdings
  const holdCols = db.prepare(`PRAGMA table_info(holdings)`).all() as { name: string }[];
  if (!holdCols.some(c => c.name === "vested_value")) {
    db.exec(`ALTER TABLE holdings ADD COLUMN vested_value REAL`);
    db.exec(`ALTER TABLE holdings ADD COLUMN vested_quantity REAL`);
  }

  // Migrate: expand liabilities with type-specific columns
  const liabCols = db.prepare(`PRAGMA table_info(liabilities)`).all() as { name: string }[];
  if (!liabCols.some(c => c.name === "last_payment_amount")) {
    db.exec(`ALTER TABLE liabilities ADD COLUMN last_payment_amount REAL`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN last_payment_date TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN credit_limit REAL`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN last_statement_issue_date TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN is_overdue INTEGER`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN apr_type TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN maturity_date TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN loan_type TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN property_address TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN escrow_balance REAL`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN loan_status TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN loan_name TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN repayment_plan TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN expected_payoff_date TEXT`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN ytd_interest_paid REAL`);
    db.exec(`ALTER TABLE liabilities ADD COLUMN ytd_principal_paid REAL`);
  }

  // Migrate: add frequency + next_due_date to recurring_bills so bills can
  // be scheduled fortnightly or weekly from a known anchor date instead of
  // being limited to a day-of-month. Existing rows default to 'monthly',
  // which preserves day_of_month behaviour.
  const billCols = db.prepare(`PRAGMA table_info(recurring_bills)`).all() as { name: string }[];
  if (!billCols.some(c => c.name === "frequency")) {
    db.exec(`ALTER TABLE recurring_bills ADD COLUMN frequency TEXT NOT NULL DEFAULT 'monthly'`);
    db.exec(`ALTER TABLE recurring_bills ADD COLUMN next_due_date TEXT`);
  }
  if (!billCols.some(c => c.name === "last_paid_date")) {
    db.exec(`ALTER TABLE recurring_bills ADD COLUMN last_paid_date TEXT`);
  }

  // Migrate: add raw_name to transactions so the canonical (post-alias)
  // `name` and the original bank descriptor stay decoupled. transaction_id
  // will derive from raw_name in a follow-up change, so alias edits no
  // longer rehash the row and orphan it. Backfill existing rows from
  // `name` since that's the only signal we have for pre-migration data.
  const txCols = db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
  if (!txCols.some(c => c.name === "raw_name")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN raw_name TEXT`);
  }
  db.exec(`UPDATE transactions SET raw_name = name WHERE raw_name IS NULL`);

  // Migrate: add `enriched_name` to transactions for PayPal import. NULL
  // by default — display code falls back to `name` when this is missing,
  // so existing rows render exactly the same as before until they get
  // matched against an imported PayPal record.
  if (!txCols.some(c => c.name === "enriched_name")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN enriched_name TEXT`);
  }

  // Migrate: add flow_type + manual-override flags to transactions. NULL
  // flow_type means "not yet inferred" — the one-shot seed below
  // backfills these from the existing category column. The two manual
  // flags default to 0; the transaction inspector flips them to 1 when
  // the user pins a value so the recategoriser can't clobber it.
  const txCols2 = db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
  if (!txCols2.some(c => c.name === "flow_type")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN flow_type TEXT`);
  }
  if (!txCols2.some(c => c.name === "manual_category")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN manual_category INTEGER NOT NULL DEFAULT 0`);
  }
  if (!txCols2.some(c => c.name === "manual_flow_type")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN manual_flow_type INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate: extend category_overrides so rules can carry flow_type and
  // optionally skip the category write (e.g. a rule that only marks
  // certain descriptors as INTERNAL_TRANSFER without changing their
  // category). `set_category` defaults to 1 for existing rules — their
  // current semantics are preserved.
  const overrideCols = db.prepare(`PRAGMA table_info(category_overrides)`).all() as { name: string }[];
  if (!overrideCols.some(c => c.name === "flow_type")) {
    db.exec(`ALTER TABLE category_overrides ADD COLUMN flow_type TEXT`);
  }
  if (!overrideCols.some(c => c.name === "set_category")) {
    db.exec(`ALTER TABLE category_overrides ADD COLUMN set_category INTEGER NOT NULL DEFAULT 1`);
  }

  // Migrate: rebuild recurring table to use Plaid stream schema
  const recCols = db.prepare(`PRAGMA table_info(recurring)`).all() as { name: string }[];
  if (!recCols.some(c => c.name === "stream_id")) {
    db.exec(`DROP TABLE IF EXISTS recurring`);
    db.exec(`
      CREATE TABLE recurring (
        stream_id TEXT PRIMARY KEY,
        account_id TEXT,
        merchant_name TEXT,
        description TEXT NOT NULL,
        frequency TEXT NOT NULL,
        category TEXT,
        subcategory TEXT,
        avg_amount REAL NOT NULL,
        last_amount REAL,
        first_date TEXT,
        last_date TEXT,
        is_active INTEGER DEFAULT 1,
        status TEXT,
        stream_type TEXT NOT NULL DEFAULT 'outflow',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  seedCategoryOverrides(db);
  seedPetCareRules(db);
  seedExistingFlowTypes(db);
  seedFlowTypeRules(db);
}

// ---------------------------------------------------------------------------
// One-shot seed for category_overrides.
//
// Inserts well-known merchant rules (liquor stores → ALCOHOL, plus the
// medical providers we've explicitly identified) the first time this DB
// is migrated against the v1 seed list. A marker row in `settings` gates
// the seed so:
//   - re-running migrate() is a no-op (marker present)
//   - deleting a seeded rule sticks (marker present, no re-insert)
//   - the user can still edit a seeded rule's category without it being
//     reverted on next start
//
// Belt-and-suspenders: even with the marker missing (e.g. fresh DB), the
// loop skips any pattern that already exists, so concurrent first-runs
// or a manually-pre-populated table can't produce duplicates.
// ---------------------------------------------------------------------------
function seedCategoryOverrides(db: Database.Database): void {
  const MARKER_KEY = "seeded_category_overrides_v1";
  const marker = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(MARKER_KEY);
  if (marker) return;

  interface SeedRule {
    pattern: string;
    category: string;
    note: string;
  }
  const SEED: SeedRule[] = [
    { pattern: "DAN MURPHY", category: "ALCOHOL", note: "Liquor retailer" },
    { pattern: "BWS", category: "ALCOHOL", note: "Liquor retailer" },
    { pattern: "LIQUORLAND", category: "ALCOHOL", note: "Liquor retailer" },
    { pattern: "FIRST CHOICE LIQUOR", category: "ALCOHOL", note: "Liquor retailer" },
    { pattern: "CELLARBRATIONS", category: "ALCOHOL", note: "Liquor retailer" },
    { pattern: "VINTAGE CELLARS", category: "ALCOHOL", note: "Liquor retailer" },
    { pattern: "MOVE360", category: "MEDICAL", note: "Laura's psychiatrist" },
    { pattern: "SWIFT EMERGENCY", category: "MEDICAL", note: "Vet emergency clinic" },
  ];

  const checkExists = db.prepare(
    `SELECT 1 FROM category_overrides WHERE match_pattern = ? LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO category_overrides (match_pattern, category, subcategory, note)
     VALUES (?, ?, NULL, ?)`,
  );
  const setMarker = db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, date('now'))`,
  );

  const tx = db.transaction(() => {
    for (const s of SEED) {
      if (checkExists.get(s.pattern)) continue;
      insert.run(s.pattern, s.category, s.note);
    }
    setMarker.run(MARKER_KEY);
  });
  tx();
}

// ---------------------------------------------------------------------------
// One-shot seed for the PET_CARE category.
//
// Independent of `seedCategoryOverrides` — uses its own marker key so the
// alcohol/move360 seed's marker doesn't gate this one, and vice versa.
//
// Currently a single rule:
//   - PETSTOCK → PET_CARE         (inserted if no rule for the pattern
//                                  already exists)
//
// SWIFT EMERGENCY is intentionally *not* touched here. Despite the name,
// it's a human private emergency department, not a vet clinic — so it
// belongs in MEDICAL and stays managed by `seedCategoryOverrides`.
//
// After the rule writes complete, we run `recategoriseAllTransactions`
// against the same `db` so existing Petstock rows pick up PET_CARE
// immediately. Passing `db` directly side-steps the circular-import
// cycle (schema → recategorise → connection → schema) that would
// otherwise route through `getDb()` and recurse.
// ---------------------------------------------------------------------------
function seedPetCareRules(db: Database.Database): void {
  const MARKER_KEY = "seeded_pet_care_rules_v1";
  const marker = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(MARKER_KEY);
  if (marker) return;

  const existsByPattern = db.prepare(
    `SELECT id FROM category_overrides WHERE match_pattern = ? LIMIT 1`,
  );
  const insertRule = db.prepare(
    `INSERT INTO category_overrides (match_pattern, category, subcategory, note)
     VALUES (?, ?, NULL, ?)`,
  );
  const setMarker = db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, date('now'))`,
  );

  const tx = db.transaction(() => {
    if (!existsByPattern.get("PETSTOCK")) {
      insertRule.run("PETSTOCK", "PET_CARE", "Pet supplies retailer");
    }
    setMarker.run(MARKER_KEY);
  });
  tx();

  // Outside the rule-write transaction so the recategorise pass sees the
  // freshly-written rule. `recategoriseAllTransactions` runs its own
  // transaction internally.
  recategoriseAllTransactions(db);
}

// ---------------------------------------------------------------------------
// One-shot backfill of `flow_type` for existing rows.
//
// Maps:
//   INCOME                       → EARNED_INCOME
//   TRANSFER_IN / TRANSFER_OUT   → INTERNAL_TRANSFER
//   LOAN_PAYMENTS                → REPAYMENT
//   everything else              → SPENDING
//
// Only runs once (gated by a settings marker). After this seed, the
// flow-type rule seed below + `recategoriseAllTransactions` refine
// further via rules.
// ---------------------------------------------------------------------------
function seedExistingFlowTypes(db: Database.Database): void {
  const MARKER_KEY = "seeded_flow_types_v1";
  const marker = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(MARKER_KEY);
  if (marker) return;

  const setMarker = db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, date('now'))`,
  );

  const tx = db.transaction(() => {
    db.exec(`
      UPDATE transactions
         SET flow_type = CASE
           WHEN category = 'INCOME' THEN 'EARNED_INCOME'
           WHEN category = 'TRANSFER_IN' OR category = 'TRANSFER_OUT' THEN 'INTERNAL_TRANSFER'
           WHEN category = 'LOAN_PAYMENTS' THEN 'REPAYMENT'
           ELSE 'SPENDING'
         END
       WHERE flow_type IS NULL
    `);
    setMarker.run(MARKER_KEY);
  });
  tx();
}

// ---------------------------------------------------------------------------
// Seed default rules that match common internal-transfer descriptors and
// set flow_type only (set_category=0 — they don't touch the rule's
// category column, which is intentionally left as a generic "OTHER"
// placeholder).
//
// Why this exists: bank descriptors for internal transfers ("Internet
// Deposit From <account-number>") don't pattern-match cleanly via the
// PFC layer, and the import-time sign-flip can drift back to TRANSFER_OUT
// during recategorisation. Pinning these rows to INTERNAL_TRANSFER at the
// flow-type level keeps them out of the retrospective's income/outflow
// totals regardless of which side of the transfer they represent.
// ---------------------------------------------------------------------------
function seedFlowTypeRules(db: Database.Database): void {
  const MARKER_KEY = "seeded_flow_type_rules_v1";
  const marker = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(MARKER_KEY);
  if (marker) return;

  const existsByPattern = db.prepare(
    `SELECT id FROM category_overrides WHERE match_pattern = ? LIMIT 1`,
  );
  // set_category = 0: rule only sets flow_type. category column carries
  // a placeholder ('OTHER') because the schema requires NOT NULL — but
  // the categoriser will ignore it when set_category=0.
  const insertFlowOnlyRule = db.prepare(
    `INSERT INTO category_overrides
       (match_pattern, category, subcategory, note, flow_type, set_category)
     VALUES (?, 'OTHER', NULL, ?, ?, 0)`,
  );
  const setMarker = db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, date('now'))`,
  );

  interface SeedRule {
    pattern: string;
    flowType: string;
    note: string;
  }
  const SEED: SeedRule[] = [
    {
      pattern: "INTERNET DEPOSIT FROM",
      flowType: "INTERNAL_TRANSFER",
      note: "Internal transfer between own accounts",
    },
    {
      pattern: "TRANSFER FROM OWN ACCOUNT",
      flowType: "INTERNAL_TRANSFER",
      note: "Internal transfer (incoming side)",
    },
    {
      pattern: "TRANSFER TO OWN ACCOUNT",
      flowType: "INTERNAL_TRANSFER",
      note: "Internal transfer (outgoing side)",
    },
  ];

  const tx = db.transaction(() => {
    for (const s of SEED) {
      if (existsByPattern.get(s.pattern)) continue;
      insertFlowOnlyRule.run(s.pattern, s.note, s.flowType);
    }
    setMarker.run(MARKER_KEY);
  });
  tx();

  recategoriseAllTransactions(db);
}
