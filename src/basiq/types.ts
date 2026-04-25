// ---------------------------------------------------------------------------
// Basiq API response types
// Reference: https://api.basiq.io/reference  (API v3.0)
// ---------------------------------------------------------------------------

// ---- Simple union types (status enums, literals) --------------------------

/** Scope used when requesting an auth token. */
export type BasiqTokenScope = "SERVER_ACCESS" | "CLIENT_ACCESS";

/** Connection health status. */
export type BasiqConnectionStatus = "active" | "pending" | "invalid";

/** Account availability status. */
export type BasiqAccountStatus = "available" | "unavailable";

/** Account ownership classification. */
export type BasiqAccountOwnership =
  | "ONE_PARTY"
  | "TWO_PARTY"
  | "MANY_PARTY"
  | "UNKNOWN"
  | "OTHER";

/**
 * Basiq account class type — the institution-level product type.
 * Maps to Ray's `type` / `subtype` columns via a conversion layer.
 */
export type BasiqAccountType =
  | "transaction"
  | "savings"
  | "credit-card"
  | "mortgage"
  | "loan"
  | "investment"
  | "term-deposit"
  | "insurance"
  | "foreign"
  | "unknown";

/** Whether a transaction has settled. */
export type BasiqTransactionStatus = "pending" | "posted";

/**
 * Direction of funds flow.
 * - `credit` — money in  (positive amount)
 * - `debit`  — money out (negative amount)
 */
export type BasiqTransactionDirection = "debit" | "credit";

/** High-level transaction classification assigned by the institution. */
export type BasiqTransactionClass =
  | "bank-fee"
  | "payment"
  | "cash-withdrawal"
  | "transfer"
  | "loan-interest"
  | "refund"
  | "direct-credit"
  | "interest"
  | "loan-repayment";

/** Overall status of an async job. */
export type BasiqJobStatus = "success" | "failed" | "in-progress" | "pending";


// ---- HATEOAS links (common pattern across Basiq responses) ----------------

/** HATEOAS self/related link. */
export interface BasiqLink {
  /** Fully-qualified URL to the resource. */
  self: string;
}

/** Links returned on the User resource. */
export interface BasiqUserLinks {
  /** URL to this user. */
  self: string;
  /** URL to this user's accounts list. */
  accounts: string;
  /** URL to this user's connections list. */
  connections: string;
  /** URL to this user's transactions list. */
  transactions: string;
}

// ---- Auth tokens ----------------------------------------------------------

/** Response from `POST /token` with `scope=SERVER_ACCESS`. */
export interface BasiqServerToken {
  /** JWT access token for server-to-server calls. */
  access_token: string;
  /** Always `"Bearer"`. */
  token_type: "Bearer";
  /** Token lifetime in seconds (typically 3600). */
  expires_in: number;
}

/** Response from `POST /token` with `scope=CLIENT_ACCESS`. */
export interface BasiqClientToken {
  /** JWT access token scoped to a specific user, for Consent UI. */
  access_token: string;
  /** Always `"Bearer"`. */
  token_type: "Bearer";
  /** Token lifetime in seconds (typically 3600). */
  expires_in: number;
}

// ---- User -----------------------------------------------------------------

/** Abbreviated resource pointer used inside embedded arrays (connections, accounts). */
export interface BasiqResourceRef {
  /** Resource type, e.g. `"connection"` or `"account"`. */
  type: string;
  /** Resource ID. */
  id: string;
  /** HATEOAS self link. */
  links: BasiqLink;
}

/** Container for embedded resource references on a User. */
export interface BasiqResourceList {
  /** Always `"list"`. */
  type: "list";
  /** Number of items. */
  count: number;
  /** Abbreviated resource pointers. */
  data: BasiqResourceRef[];
}

/** A Basiq user — the top-level entity that owns connections and accounts. */
export interface BasiqUser {
  /** Always `"user"`. */
  type: "user";
  /** Unique user identifier. */
  id: string;
  /** Email address (may be empty string if not provided). */
  email: string;
  /** Mobile number (may be empty string). */
  mobile: string;
  /** Full name (may be empty string). */
  name: string;
  /** First name (may be empty string). */
  firstName: string;
  /** Middle name (may be empty string). */
  middleName: string;
  /** Last name (may be empty string). */
  lastName: string;
  /** Embedded connection references for this user. */
  connections: BasiqResourceList;
  /** Embedded account references for this user. */
  accounts: BasiqResourceList;
  /** HATEOAS navigation links. */
  links: BasiqUserLinks;
  /** Official business name (business accounts only). */
  businessName?: string;
  /** ABN or ACN value (business accounts only). */
  businessIdNo?: string;
  /** Identifier type: `"ABN"` or `"ACN"`. */
  businessIdNoType?: string;
  /** Registered business address. */
  businessAddress?: BasiqBusinessAddress;
  /** Whether the business has been verified against the Australian Business Register. */
  verificationStatus?: boolean;
  /** ISO 8601 timestamp of last verification. */
  verificationDate?: string;
}

/** Business address sub-object on a User. */
export interface BasiqBusinessAddress {
  /** Street address line 1. */
  addressLine1: string;
  /** Street address line 2. */
  addressLine2?: string;
  /** Suburb / locality. */
  suburb: string;
  /** State or territory code (e.g. `"NSW"`). */
  state: string;
  /** Postal code. */
  postcode: string;
  /** ISO 3166-1 alpha-2 country code. */
  countryCode: string;
}

// ---- Connection -----------------------------------------------------------

/** A bank connection linking a user to an institution via CDR consent. */
export interface BasiqConnection {
  /** Always `"connection"`. */
  type: "connection";
  /** Unique connection identifier. */
  id: string;
  /**
   * Connection health.
   * - `active`  — data is flowing normally.
   * - `pending` — connection is being established.
   * - `invalid` — consent expired or credentials revoked; needs re-authentication.
   */
  status: BasiqConnectionStatus;
  /** Institution resource ID this connection targets. */
  institution: BasiqInstitutionRef;
  /** ISO 8601 timestamp when the connection was created. */
  createdDate: string;
  /** ISO 8601 timestamp of the last successful data refresh. */
  lastUsed: string;
  /** HATEOAS self link. */
  links: BasiqLink;
}

/** Abbreviated institution reference embedded in a Connection. */
export interface BasiqInstitutionRef {
  /** Always `"institution"`. */
  type: "institution";
  /** Institution ID. */
  id: string;
}

// ---- Account --------------------------------------------------------------

/** Classification of an account's product type. */
export interface BasiqAccountClass {
  /**
   * Institution-level product type.
   * E.g. `"transaction"`, `"savings"`, `"credit-card"`, `"mortgage"`.
   */
  type: BasiqAccountType;
  /** Product name as described by the institution. */
  product: string;
}

/** Date range for which transaction data is available. */
export interface BasiqTransactionInterval {
  /** ISO 8601 start date. */
  from: string;
  /** ISO 8601 end date. */
  to: string;
}

/** A bank account returned by Basiq. */
export interface BasiqAccount {
  /** Always `"account"`. */
  type: "account";
  /** Unique account identifier. */
  id: string;
  /** User-defined account nickname (mapped from CDR display name). */
  name: string;
  /** Institution-defined display name. */
  displayName: string;
  /**
   * BSB + account number combined.
   * Use the last 4 characters as the `mask` for Ray's schema.
   */
  accountNo: string;
  /** Account holder name from the institution, or `null` if unavailable. */
  accountHolder: string | null;
  /** Whether the authenticated user is an owner of this account. */
  isOwned: boolean;
  /** Ownership classification. */
  accountOwnership: BasiqAccountOwnership;
  /**
   * Current balance as a string-encoded decimal.
   * Excludes pending transactions. `null` if not available.
   */
  balance: string | null;
  /**
   * Funds available for withdrawal as a string-encoded decimal.
   * `null` if not available.
   */
  availableFunds: string | null;
  /**
   * Credit limit as a string-encoded decimal.
   * Applicable to credit-card, loan, and mortgage accounts.
   * `null` if not applicable or unavailable.
   */
  creditLimit: string | null;
  /** ISO 4217 currency code (e.g. `"AUD"`). */
  currency: string;
  /** Account product classification. */
  class: BasiqAccountClass;
  /** Connection resource ID that owns this account. */
  connection: string;
  /** Institution resource ID. */
  institution: string;
  /** ISO 8601 timestamp of the last data refresh. */
  lastUpdated: string;
  /** Whether the account is currently accessible. */
  status: BasiqAccountStatus;
  /** Date ranges for which transaction history is available. */
  transactionIntervals: BasiqTransactionInterval[];
  /** HATEOAS self link. */
  links: BasiqLink;
  /** Masked account or card number. */
  maskedNumber?: string;
  /** Unmasked BSB (digits only). */
  bsb?: string;
  /** Unmasked account number. */
  unmaskedAccNum?: string;
  /** ISO 8601 date the account was opened. */
  creationDate?: string;
  /** Current deposit interest rate as a string-encoded decimal. */
  depositRate?: string;
  /** Current lending interest rate as a string-encoded decimal. */
  lendingRate?: string;
  /** Bundle or package membership name. */
  bundleName?: string;
  /** Available limit amortised by schedule, as a string-encoded decimal. */
  amortisedLimit?: string;
}

// ---- Transaction ----------------------------------------------------------

/** Enriched merchant data attached to a transaction by Basiq. */
export interface BasiqMerchant {
  /** Registered business name of the merchant. */
  businessName: string;
  /** Merchant website URL, if known. */
  website?: string;
  /** URL to the merchant's logo image, if available. */
  logoUrl?: string;
  /** Australian Business Number, if resolved. */
  abn?: string;
  /** Merchant phone number, if available. */
  phone?: string;
}

/** Enrichment data Basiq attaches to transactions for categorisation. */
export interface BasiqTransactionEnrich {
  /** Cleaned / normalised description. */
  cleanDescription: string;
  /**
   * Key-value tags in `"key:value"` format.
   * E.g. `["card:4615", "income:salary"]`.
   */
  tags: string[];
  /** Basiq's own category label for this transaction. */
  category: string;
  /** Resolved merchant information. */
  merchant: BasiqMerchant;
  /** Location data, if resolved from the transaction description. */
  location?: BasiqTransactionLocation;
}

/** Geolocation data resolved from a transaction description. */
export interface BasiqTransactionLocation {
  /** ISO 3166-1 alpha-2 country code. */
  country?: string;
  /** Human-readable formatted address. */
  formattedAddress?: string;
  /** Latitude / longitude. */
  geometry?: { lat: number; lng: number };
  /** Postal / ZIP code. */
  postalCode?: string;
  /** Street name. */
  route?: string;
  /** State or territory. */
  state?: string;
  /** Suburb / locality. */
  suburb?: string;
}

/** Sub-classification for payment or fee transactions. */
export interface BasiqTransactionSubClass {
  /** Numeric sub-class code. */
  code: number;
  /** Human-readable sub-class title. */
  title: string;
}

/**
 * A single bank transaction returned by Basiq.
 *
 * **Sign convention — critical for mapping to Ray:**
 * Basiq uses accounting sign: positive `amount` = credit (money in),
 * negative `amount` = debit (money out).
 * Plaid (and therefore Ray's DB) uses the opposite convention:
 * positive = money out, negative = money in.
 * **You must negate `amount` when writing to Ray's transactions table.**
 */
export interface BasiqTransaction {
  /** Always `"transaction"`. */
  type: "transaction";
  /** Unique transaction identifier for this connection. */
  id: string;
  /** Whether the transaction has settled. */
  status: BasiqTransactionStatus;
  /** Raw transaction description from the institution. */
  description: string;
  /** Reference provided by the originating institution. */
  reference: string;
  /**
   * Transaction amount as a **string-encoded decimal** (e.g. `"-42.50"`).
   *
   * **Sign convention:** negative = debit (money out), positive = credit (money in).
   * This is the OPPOSITE of Plaid/Ray, so negate when mapping.
   *
   * Basiq uses strings (not numbers) for financial precision.
   */
  amount: string;
  /** ISO 4217 currency code (e.g. `"AUD"`). */
  currency: string;
  /** Account resource ID this transaction belongs to. */
  account: string;
  /** Direction of funds flow: `"debit"` (out) or `"credit"` (in). */
  direction: BasiqTransactionDirection;
  /** High-level classification assigned by the institution. */
  class: BasiqTransactionClass;
  /** Institution resource ID. */
  institution: string;
  /** Connection resource ID. */
  connection: string;
  /**
   * Date the transaction was posted (settled), in ISO 8601 / RFC 3339 format.
   * This is the primary date field — use as Ray's `date` column.
   */
  postDate: string;
  /** Enrichment data: cleaned description, category, merchant, tags. */
  enrich: BasiqTransactionEnrich;
  /** HATEOAS self link. */
  links: BasiqLink;
  /**
   * Date the user initiated the transaction, in ISO 8601 format.
   * `null` for pending transactions.
   */
  transactionDate?: string | null;
  /**
   * Account balance at the time this transaction completed.
   * Only available for web-sourced data. String-encoded decimal.
   */
  balance?: string;
  /** Sub-classification for payment or fee transactions. */
  subClass?: BasiqTransactionSubClass;
}

// ---- Job ------------------------------------------------------------------

/** A single step within an async Basiq job. */
export interface BasiqJobStep {
  /** Step name, e.g. `"verify-credentials"`, `"retrieve-accounts"`, `"retrieve-transactions"`. */
  title: string;
  /** Current status of this step. */
  status: BasiqJobStatus;
  /** Result detail (usually `null` on success, error object on failure). */
  result: BasiqJobStepResult | null;
}

/** Error detail attached to a failed job step. */
export interface BasiqJobStepResult {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error description. */
  detail: string;
  /** URL to relevant documentation. */
  url?: string;
}

/**
 * An async job returned when creating or refreshing a connection.
 * Poll `GET /jobs/{jobId}` until all steps reach `"success"` or one reaches `"failed"`.
 */
export interface BasiqJob {
  /** Always `"job"`. */
  type: "job";
  /** Unique job identifier — use this to poll status. */
  id: string;
  /** Timestamp when the job was created (ISO 8601). */
  createdDate: string;
  /** Timestamp when the job was last updated (ISO 8601). */
  updatedDate: string;
  /**
   * Ordered processing steps. Typical sequence:
   * 1. `verify-credentials`
   * 2. `retrieve-accounts`
   * 3. `retrieve-transactions`
   */
  steps: BasiqJobStep[];
  /** HATEOAS self link. */
  links: BasiqLink;
}

// ---- Institution ----------------------------------------------------------

// TODO: This type is incomplete. When we build the institution-filtering UI,
// expand it to cover institutionType, stage, status, and expanded features
// returned by /institutions. Leaving narrow for now to keep the smoke test
// honest about what we've actually verified.
/** A supported financial institution in Basiq's registry. */
export interface BasiqInstitution {
  /** Always `"institution"`. */
  type: "institution";
  /** Unique institution identifier. */
  id: string;
  /** Human-readable institution name. */
  name: string;
  /** Short code / abbreviation for the institution. */
  shortName: string;
  /**
   * Country name as a full string (e.g. `"Australia"`).
   * Note: this is NOT an ISO code despite plan documentation suggesting otherwise.
   */
  country: string;
  /**
   * How data is retrieved: `"open-banking"` (CDR), `"web"` (screen-scrape),
   * or `"hybrid"`.
   */
  serviceType: string;
  /** URL to the institution's logo. */
  logo: BasiqInstitutionLogo;
  /** HATEOAS self link. */
  links: BasiqLink;
  /** Current operational status of the institution's feed. */
  status?: string;
  /** Tier classification, if provided by Basiq. */
  tier?: string;
}

/** Institution logo URLs. */
export interface BasiqInstitutionLogo {
  /** URL to a square logo image. */
  links: {
    /** Square logo image URL. */
    square: string;
    /** Full-width logo image URL, if available. */
    full?: string;
  };
}

// ---- Paginated list wrapper -----------------------------------------------

/** Pagination cursor links returned on list endpoints. */
export interface BasiqPaginationLinks {
  /** URL to the current page. */
  self: string;
  /** URL to the first page. */
  first?: string;
  /** URL to the next page, or absent if this is the last page. */
  next?: string;
  /** URL to the previous page, or absent if this is the first page. */
  prev?: string;
}

/**
 * Generic wrapper for all paginated list responses from Basiq.
 * Basiq returns arrays under a `data` key with `links` for cursor pagination.
 */
export interface BasiqListResponse<T> {
  /** Always `"list"`. */
  type: "list";
  /** Total number of items matching the query (across all pages). */
  totalCount: number;
  /** Page size used for this response. */
  size: number;
  /** Array of resource objects for the current page. */
  data: T[];
  /** Pagination navigation links. */
  links: BasiqPaginationLinks;
}
