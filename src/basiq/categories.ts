/**
 * Basiq → Plaid Personal Finance Category (PFC) mapping.
 *
 * Ray's scoring, budgeting, and achievement code (Kitchen Hero, shopping
 * streaks, food/shopping budgets, transfer exclusions, etc.) hard-codes
 * Plaid PFC strings as its internal category vocabulary. To keep that code
 * unchanged when swapping the provider layer to Basiq, every transaction
 * pulled from Basiq must be translated into the equivalent Plaid PFC pair
 * (`category` + `subcategory`) at the sync boundary.
 *
 * This table is intentionally narrow at first — it covers the categories
 * that Ray's scoring logic actually keys off of. As real sandbox and
 * production data flows through, expect to see Basiq category strings that
 * aren't in `CATEGORY_MAP` yet; those will fall through to `DEFAULT_CATEGORY`
 * and should be added here once we know what they represent.
 *
 * Note on transfers: `transfer` and `internal-transfer` default to
 * `TRANSFER_OUT`. The actual direction (in vs out) depends on the
 * transaction's sign and must be resolved by the transaction sync layer,
 * not here.
 */

export type PlaidCategory = {
  category: string;
  subcategory: string;
};

export const DEFAULT_CATEGORY: PlaidCategory = {
  category: "GENERAL_SERVICES",
  subcategory: "OTHER",
};

export const CATEGORY_MAP: Record<string, PlaidCategory> = {
  // --- Food & drink ----------------------------------------------------
  "restaurants-and-cafes": { category: "FOOD_AND_DRINK", subcategory: "RESTAURANT" },
  "takeaway": { category: "FOOD_AND_DRINK", subcategory: "FAST_FOOD" },
  "fast-food": { category: "FOOD_AND_DRINK", subcategory: "FAST_FOOD" },
  "coffee-shops": { category: "FOOD_AND_DRINK", subcategory: "COFFEE" },
  "groceries": { category: "FOOD_AND_DRINK", subcategory: "GROCERIES" },
  "supermarkets": { category: "FOOD_AND_DRINK", subcategory: "GROCERIES" },
  "bars-and-pubs": { category: "FOOD_AND_DRINK", subcategory: "ALCOHOL" },

  // --- General merchandise --------------------------------------------
  "clothing-and-accessories": { category: "GENERAL_MERCHANDISE", subcategory: "CLOTHING" },
  "department-stores": { category: "GENERAL_MERCHANDISE", subcategory: "DEPARTMENT_STORES" },
  "electronics": { category: "GENERAL_MERCHANDISE", subcategory: "ELECTRONICS" },
  "online-shopping": { category: "GENERAL_MERCHANDISE", subcategory: "ONLINE_MARKETPLACES" },
  "home-improvement": { category: "GENERAL_MERCHANDISE", subcategory: "HOME_IMPROVEMENT" },
  "toys-and-games": { category: "GENERAL_MERCHANDISE", subcategory: "TOYS" },

  // --- Transportation -------------------------------------------------
  "petrol": { category: "TRANSPORTATION", subcategory: "GAS" },
  "fuel": { category: "TRANSPORTATION", subcategory: "GAS" },
  "public-transport": { category: "TRANSPORTATION", subcategory: "PUBLIC_TRANSIT" },
  "taxi-and-rideshare": { category: "TRANSPORTATION", subcategory: "TAXIS_AND_RIDE_SHARES" },
  "parking": { category: "TRANSPORTATION", subcategory: "PARKING" },

  // --- Transfers ------------------------------------------------------
  // Default to OUT; the sync layer must flip to TRANSFER_IN based on sign.
  "transfer": { category: "TRANSFER_OUT", subcategory: "ACCOUNT_TRANSFER" },
  "internal-transfer": { category: "TRANSFER_OUT", subcategory: "ACCOUNT_TRANSFER" },
  "bpay": { category: "TRANSFER_OUT", subcategory: "OTHER_TRANSFER_OUT" },

  // --- Loan payments --------------------------------------------------
  "loan-repayment": { category: "LOAN_PAYMENTS", subcategory: "PERSONAL_LOAN" },
  "mortgage-payment": { category: "LOAN_PAYMENTS", subcategory: "MORTGAGE" },
  "credit-card-payment": { category: "LOAN_PAYMENTS", subcategory: "CREDIT_CARD" },

  // --- Entertainment & personal care ----------------------------------
  "entertainment": { category: "ENTERTAINMENT", subcategory: "OTHER_ENTERTAINMENT" },
  "streaming-services": { category: "ENTERTAINMENT", subcategory: "TV_AND_MOVIES" },
  "gyms-and-fitness": { category: "PERSONAL_CARE", subcategory: "GYMS_AND_FITNESS" },

  // --- Bills & services -----------------------------------------------
  "utilities": { category: "RENT_AND_UTILITIES", subcategory: "OTHER_UTILITIES" },
  "telecommunications": { category: "RENT_AND_UTILITIES", subcategory: "TELEPHONE" },
  "internet": { category: "RENT_AND_UTILITIES", subcategory: "INTERNET_AND_CABLE" },
  "insurance": { category: "GENERAL_SERVICES", subcategory: "INSURANCE" },
  "rent": { category: "RENT_AND_UTILITIES", subcategory: "RENT" },

  // --- Income ---------------------------------------------------------
  "salary": { category: "INCOME", subcategory: "WAGES" },
  "wages": { category: "INCOME", subcategory: "WAGES" },
  "government-benefit": { category: "INCOME", subcategory: "OTHER_INCOME" },
};

/**
 * Translate a Basiq category string into the Plaid PFC pair Ray expects.
 *
 * - Case-insensitive (input is normalised to lowercase before lookup).
 * - Returns `DEFAULT_CATEGORY` for `null`, `undefined`, empty string, or
 *   any value not present in `CATEGORY_MAP`.
 */
export function mapBasiqCategory(
  basiqCategory: string | null | undefined,
): PlaidCategory {
  if (!basiqCategory) {
    return DEFAULT_CATEGORY;
  }

  const key = basiqCategory.trim().toLowerCase();
  if (!key) {
    return DEFAULT_CATEGORY;
  }

  return CATEGORY_MAP[key] ?? DEFAULT_CATEGORY;
}

// ---------------------------------------------------------------------------
// Description-based fallback
// ---------------------------------------------------------------------------

/**
 * Hand-curated description-matching rules for Australian merchants. Used
 * when Basiq's enrichment is disabled (sandbox) or simply absent on a given
 * transaction. Order is significant — rules are evaluated top-to-bottom and
 * the first match wins, so more-specific patterns must precede broader
 * ones (e.g. `"UBER EATS"` must come before `"UBER "`).
 *
 * Patterns are uppercase substring matches against a normalised
 * description (uppercased, internal whitespace collapsed). Trailing spaces
 * in patterns like `"BP "`, `"UBER "`, `"OLA "`, `"AGL "`, `"TARGET "` are
 * deliberate — they prevent false matches against unrelated words that
 * start with the same letters.
 */
interface DescriptionRule {
  patterns: string[];
  result: PlaidCategory;
}

const DESCRIPTION_RULES: DescriptionRule[] = [
  // --- Income (most specific first) -----------------------------------
  {
    patterns: ["SALARY", "WAGE", "DEPOSIT-SALARY", "PAYG"],
    result: { category: "INCOME", subcategory: "WAGES" },
  },
  {
    patterns: ["CENTRELINK", "GOVERNMENT BENEFIT"],
    result: { category: "INCOME", subcategory: "OTHER_INCOME" },
  },
  {
    patterns: ["INTEREST PAID", "INTEREST CREDIT"],
    result: { category: "INCOME", subcategory: "INTEREST_EARNED" },
  },
  {
    patterns: ["CREDIT INTEREST"],
    result: { category: "INCOME", subcategory: "INTEREST_EARNED" },
  },

  // --- Transfers ------------------------------------------------------
  // Direction (TRANSFER_OUT vs TRANSFER_IN) is resolved at the mapper
  // layer based on the transaction's sign, not here.
  {
    patterns: ["TRANSFER TO", "TRANSFER FROM", "INTERNAL TRANSFER", "TFR"],
    result: { category: "TRANSFER_OUT", subcategory: "ACCOUNT_TRANSFER" },
  },
  {
    patterns: ["BPAY"],
    result: { category: "TRANSFER_OUT", subcategory: "OTHER_TRANSFER_OUT" },
  },
  {
    patterns: ["PAYMENT RECEIVED"],
    result: { category: "TRANSFER_IN", subcategory: "ACCOUNT_TRANSFER" },
  },

  // --- Loan payments --------------------------------------------------
  {
    patterns: ["LOAN REPAYMENT", "LOAN PAYMENT"],
    result: { category: "LOAN_PAYMENTS", subcategory: "PERSONAL_LOAN" },
  },
  {
    patterns: ["MORTGAGE"],
    result: { category: "LOAN_PAYMENTS", subcategory: "MORTGAGE" },
  },
  {
    patterns: ["CREDIT CARD PMT", "CREDIT CARD PAYMENT"],
    result: { category: "LOAN_PAYMENTS", subcategory: "CREDIT_CARD" },
  },

  // --- Food & drink (Australian merchants) ----------------------------
  {
    patterns: ["WOOLWORTHS", "WOOLIES", "COLES", "ALDI", "IGA", "HARRIS FARM"],
    result: { category: "FOOD_AND_DRINK", subcategory: "GROCERIES" },
  },
  {
    patterns: [
      "MCDONALDS",
      "KFC",
      "HUNGRY JACK",
      "DOMINO",
      "PIZZA HUT",
      "RED ROOSTER",
      "SUBWAY",
      "GUZMAN",
      "OPORTO",
      "GRILL'D",
    ],
    result: { category: "FOOD_AND_DRINK", subcategory: "FAST_FOOD" },
  },
  {
    // UBER EATS must precede the bare "UBER " transport rule below.
    // Card processors mangle the merchant string with asterisks (e.g.
    // "UBER *EATS Sydney AUS"), so we list every observed punctuation
    // variant here rather than reaching for regex.
    patterns: [
      "UBER EATS",
      "UBEREATS",
      "UBER *EATS",
      "UBER* EATS",
      "UBER*EATS",
      "MENULOG",
      "DELIVEROO",
      "DOORDASH",
    ],
    result: { category: "FOOD_AND_DRINK", subcategory: "FAST_FOOD" },
  },
  {
    patterns: ["STARBUCKS", "GLORIA JEAN", "CAFE", "ESPRESSO"],
    result: { category: "FOOD_AND_DRINK", subcategory: "COFFEE" },
  },
  {
    patterns: ["BWS", "DAN MURPHY", "LIQUORLAND", "FIRST CHOICE"],
    result: { category: "FOOD_AND_DRINK", subcategory: "ALCOHOL" },
  },
  {
    patterns: ["7-ELEVEN", "AMPOL", "BP ", "CALTEX", "SHELL", "UNITED PETROLEUM"],
    result: { category: "TRANSPORTATION", subcategory: "GAS" },
  },

  // --- Transport ------------------------------------------------------
  {
    patterns: ["UBER ", "DIDI", "OLA "],
    result: { category: "TRANSPORTATION", subcategory: "TAXIS_AND_RIDE_SHARES" },
  },
  {
    patterns: ["OPAL", "MYKI", "GO CARD", "TRANSPORT FOR NSW"],
    result: { category: "TRANSPORTATION", subcategory: "PUBLIC_TRANSIT" },
  },
  {
    patterns: ["WILSON PARKING", "CARE PARK", "SECURE PARKING"],
    result: { category: "TRANSPORTATION", subcategory: "PARKING" },
  },

  // --- Entertainment --------------------------------------------------
  {
    patterns: [
      "NETFLIX",
      "STAN",
      "DISNEY+",
      "DISNEY PLUS",
      "PRIME VIDEO",
      "BINGE",
      "FOXTEL",
    ],
    result: { category: "ENTERTAINMENT", subcategory: "TV_AND_MOVIES" },
  },
  {
    // AMZNPRIMEA is the merchant string Amazon Prime AU prints on cards.
    // Sits in the entertainment block ahead of the AMAZON.COM.AU rule
    // below so a Prime renewal isn't miscategorised as shopping.
    patterns: ["AMZNPRIMEA", "AMAZON PRIME"],
    result: { category: "ENTERTAINMENT", subcategory: "TV_AND_MOVIES" },
  },
  {
    patterns: ["AUDIBLE"],
    result: { category: "ENTERTAINMENT", subcategory: "TV_AND_MOVIES" },
  },
  {
    patterns: ["SPOTIFY", "APPLE MUSIC", "YOUTUBE PREMIUM", "YOUTUBE MUSIC"],
    result: { category: "ENTERTAINMENT", subcategory: "MUSIC" },
  },
  {
    patterns: ["EB GAMES", "STEAM", "PLAYSTATION", "NINTENDO", "XBOX"],
    result: { category: "ENTERTAINMENT", subcategory: "VIDEO_GAMES" },
  },

  // --- Medical / pharmacy ---------------------------------------------
  {
    patterns: [
      "TERRYWHITE",
      "TERRY WHITE",
      "CHEMMART",
      "CHEMIST WAREHOUSE",
      "PRICELINE PHARMACY",
      "BLOOMS THE CHEMIST",
    ],
    result: { category: "MEDICAL", subcategory: "PHARMACIES_AND_SUPPLEMENTS" },
  },
  {
    patterns: ["MOVE360"],
    result: { category: "MEDICAL", subcategory: "OTHER_MEDICAL" },
  },
  {
    // Vet bills land in MEDICAL — Plaid PFC has no separate pet-medical
    // category, so we route them through the general medical bucket.
    patterns: ["SWIFT EMERGENCY", "VET CLINIC", "VETERINARY"],
    result: { category: "MEDICAL", subcategory: "OTHER_MEDICAL" },
  },

  // --- General merchandise --------------------------------------------
  {
    patterns: ["KMART", "BIG W", "TARGET ", "MYER", "DAVID JONES"],
    result: { category: "GENERAL_MERCHANDISE", subcategory: "DEPARTMENT_STORES" },
  },
  {
    patterns: [
      "JB HI-FI",
      "JB HIFI",
      "OFFICEWORKS",
      "HARVEY NORMAN",
      "THE GOOD GUYS",
    ],
    result: { category: "GENERAL_MERCHANDISE", subcategory: "ELECTRONICS" },
  },
  {
    patterns: ["BUNNINGS", "MITRE 10"],
    result: { category: "GENERAL_MERCHANDISE", subcategory: "HOME_IMPROVEMENT" },
  },
  {
    patterns: ["PETSTOCK", "PETBARN", "PET STOCK", "PET BARN"],
    result: { category: "GENERAL_MERCHANDISE", subcategory: "OTHER_GENERAL_MERCHANDISE" },
  },
  {
    // PayPal Pay-in-4 instalments — the underlying purchase is unknown,
    // so OTHER_GENERAL_MERCHANDISE is the most honest bucket.
    patterns: ["PYPL PAYIN4", "PAYPAL PAY IN 4"],
    result: { category: "GENERAL_MERCHANDISE", subcategory: "OTHER_GENERAL_MERCHANDISE" },
  },
  {
    patterns: ["AMAZON.COM.AU", "AMAZON AU", "EBAY"],
    result: { category: "GENERAL_MERCHANDISE", subcategory: "ONLINE_MARKETPLACES" },
  },

  // --- Bills & services -----------------------------------------------
  {
    patterns: ["TELSTRA", "OPTUS", "VODAFONE", "TPG", "BELONG", "AUSSIE BROADBAND"],
    result: { category: "RENT_AND_UTILITIES", subcategory: "TELEPHONE" },
  },
  {
    // OCCOM is a small AU ISP; `EZI*` is the BPAY intermediary's prefix.
    patterns: ["EZI*OCCOM", "OCCOM"],
    result: { category: "RENT_AND_UTILITIES", subcategory: "INTERNET_AND_CABLE" },
  },
  {
    patterns: ["AGL ", "ORIGIN ENERGY", "ENERGY AUSTRALIA"],
    result: { category: "RENT_AND_UTILITIES", subcategory: "GAS_AND_ELECTRICITY" },
  },
  {
    // Card-processor mangling of Arc Energy (`EZI*` prefix is the BPAY
    // intermediary's tag).
    patterns: ["EZI*ARC ENERGY", "ARC ENERGY"],
    result: { category: "RENT_AND_UTILITIES", subcategory: "GAS_AND_ELECTRICITY" },
  },
  {
    patterns: ["SYDNEY WATER", "MELBOURNE WATER"],
    result: { category: "RENT_AND_UTILITIES", subcategory: "WATER" },
  },
  {
    patterns: ["VERA LIVING"],
    result: { category: "RENT_AND_UTILITIES", subcategory: "RENT" },
  },

  // --- Insurance ------------------------------------------------------
  {
    patterns: ["YOUI", "PET INSURANCE"],
    result: { category: "GENERAL_SERVICES", subcategory: "INSURANCE" },
  },

  // --- Digital services / AI tools ------------------------------------
  {
    patterns: ["OPENAI", "CHATGPT", "CLAUDE.AI", "ANTHROPIC"],
    result: { category: "GENERAL_SERVICES", subcategory: "OTHER_GENERAL_SERVICES" },
  },

  // --- Cash withdrawals -----------------------------------------------
  // Cash is genuinely uncategorisable — we don't know what it was for.
  // OTHER_GENERAL_SERVICES is the most honest bucket.
  {
    patterns: ["ATM WITHDRAWAL", "CASH WITHDRAWAL"],
    result: { category: "GENERAL_SERVICES", subcategory: "OTHER_GENERAL_SERVICES" },
  },

  // --- Bank fees ------------------------------------------------------
  {
    patterns: [
      "FOREIGN CURRENCY CONVERSN FEE",
      "INTERNATIONAL TRANSACTION FEE",
      "FOREIGN TRANSACTION FEE",
      "ATM FEE",
      "ACCOUNT FEE",
      "ACCOUNT KEEPING FEE",
    ],
    result: { category: "BANK_FEES", subcategory: "OTHER_BANK_FEES" },
  },

  // --- Generic bank-transfer fallback ---------------------------------
  // These patterns describe HOW money moved (Osko, internet banking)
  // rather than WHO it went to, so they're intentionally evaluated AFTER
  // every merchant-specific rule above. An Osko payment to "VERA LIVING"
  // will match the rent rule first; only payments with no merchant
  // signal fall through to here.
  {
    patterns: [
      "INTERNET DEPOSIT",
      "INTERNET WITHDRAWAL",
      "OSKO DEPOSIT",
      "OSKO WITHDRAWAL",
    ],
    result: { category: "TRANSFER_OUT", subcategory: "ACCOUNT_TRANSFER" },
  },
  {
    // VLT001574 is the user's specific Vera Living tenant reference.
    // It appears on the credit/receiving side of monthly rent
    // transactions (e.g. "Kristie Mccarthy Vlt001574"). Categorising
    // these as Transfer keeps them out of the rent total — the outgoing
    // payment to "VERA LIVING" already counts as Rent above. Sits with
    // the bottom-tier transfer fallbacks so a description containing
    // both "VERA LIVING" and "VLT001574" still hits the rent rule first.
    patterns: ["VLT001574"],
    result: { category: "TRANSFER_OUT", subcategory: "ACCOUNT_TRANSFER" },
  },
];

/**
 * Best-effort categorisation from a raw transaction description, used as
 * a fallback when Basiq's enrichment is unavailable.
 *
 * Returns `null` if the description is missing/empty or no rule matches —
 * callers decide what to do with the miss (typically: fall back to
 * `DEFAULT_CATEGORY`).
 */
export function categoriseFromDescription(
  description: string | null | undefined,
): PlaidCategory | null {
  if (!description) return null;

  const normalised = description.toUpperCase().replace(/\s+/g, " ").trim();
  if (!normalised) return null;

  for (const rule of DESCRIPTION_RULES) {
    for (const pattern of rule.patterns) {
      if (normalised.includes(pattern)) {
        return rule.result;
      }
    }
  }

  return null;
}
