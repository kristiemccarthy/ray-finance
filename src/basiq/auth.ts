import type { BasiqServerToken } from "./types.js";

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

export class BasiqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BasiqError";
  }
}

export class BasiqAuthError extends BasiqError {
  constructor(message: string) {
    super(message);
    this.name = "BasiqAuthError";
  }
}

export class BasiqRateLimitError extends BasiqError {
  constructor(message: string) {
    super(message);
    this.name = "BasiqRateLimitError";
  }
}

export class BasiqServerError extends BasiqError {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "BasiqServerError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://au-api.basiq.io/token";
const BASIQ_VERSION = "3.0";

/** Subtract this many ms from the real expiry to avoid using a nearly-expired token. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

const MAX_RETRIES = 3;
const BACKOFF_MS = [500, 1000, 2000];

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let cachedExpiresAt: number = 0; // epoch ms
let currentRequest: Promise<BasiqServerToken> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a valid Basiq server access token, fetching and caching one
 * automatically when needed. Concurrent callers share a single in-flight
 * request to avoid duplicate token exchanges.
 */
export async function getServerToken(apiKey: string): Promise<string> {
  if (cachedToken && Date.now() < cachedExpiresAt) {
    return cachedToken;
  }

  // If another caller already kicked off a fetch, piggy-back on it.
  if (currentRequest) {
    const token = await currentRequest;
    return token.access_token;
  }

  // We're the first caller — start the fetch and store the promise so
  // concurrent callers can share it.
  currentRequest = fetchServerToken(apiKey);

  try {
    const token = await currentRequest;
    cachedToken = token.access_token;
    cachedExpiresAt = Date.now() + token.expires_in * 1000 - EXPIRY_SAFETY_MARGIN_MS;
    return cachedToken;
  } finally {
    currentRequest = null;
  }
}

/** Reset the internal token cache. Useful for testing. */
export function clearTokenCache(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  currentRequest = null;
}

// ---------------------------------------------------------------------------
// Token fetch with retry
// ---------------------------------------------------------------------------

async function fetchServerToken(apiKey: string): Promise<BasiqServerToken> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_MS[attempt - 1]);
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "basiq-version": BASIQ_VERSION,
          Accept: "application/json",
        },
        body: "scope=SERVER_ACCESS",
      });
    } catch (err) {
      // Network-level failure (DNS, socket, etc.) — retry.
      lastError = err;
      continue;
    }

    if (response.ok) {
      return (await response.json()) as BasiqServerToken;
    }

    // 401 — bad API key. No point retrying.
    if (response.status === 401) {
      throw new BasiqAuthError(
        `Basiq authentication failed (401). Check your API key.`,
      );
    }

    // 429 — rate limited. Retry.
    if (response.status === 429) {
      lastError = new BasiqRateLimitError(
        `Basiq rate limit hit (429). Attempt ${attempt + 1}/${MAX_RETRIES + 1}.`,
      );
      continue;
    }

    // 5xx — server error. Retry.
    if (response.status >= 500) {
      lastError = new BasiqServerError(
        `Basiq server error (${response.status}). Attempt ${attempt + 1}/${MAX_RETRIES + 1}.`,
        response.status,
      );
      continue;
    }

    // Any other status (4xx besides 401/429) — not retryable.
    throw new BasiqError(
      `Basiq token request failed with status ${response.status}.`,
    );
  }

  // All retries exhausted — throw the last error we captured.
  throw lastError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
