import { BasiqAuthError, BasiqError } from "./auth.js";
import { BasiqApiError } from "./client.js";
import type { BasiqClientToken } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://au-api.basiq.io/token";
const CONSENT_BASE_URL = "https://consent.basiq.io/home";
const BASIQ_VERSION = "3.0";

const MAX_RETRIES = 2;
const BACKOFF_MS = [500, 1000];

// ---------------------------------------------------------------------------
// Client token (CLIENT_ACCESS scope)
// ---------------------------------------------------------------------------

/**
 * Exchange a developer API key for a CLIENT_ACCESS token bound to a specific
 * Basiq userId. This token is what gets handed to the Consent UI in the
 * browser — it scopes the consent flow to that user only.
 *
 * Note: this deliberately does NOT go through `BasiqClient`. The token
 * endpoint uses Basic auth (not Bearer), a different content type, and is
 * the bootstrap that mints the tokens the client itself relies on. Mixing
 * the two would create a circular dependency on auth state.
 *
 * Retries on 429 / 5xx / network errors with backoff. Throws
 * `BasiqAuthError` on 401 (bad API key), `BasiqApiError` for other 4xx,
 * or the last transient error after retries are exhausted.
 */
export async function getClientToken(
  apiKey: string,
  userId: string,
): Promise<string> {
  if (!apiKey) {
    throw new BasiqAuthError("getClientToken called without an API key.");
  }
  if (!userId) {
    throw new BasiqError("getClientToken called without a userId.");
  }

  const body = new URLSearchParams({
    scope: "CLIENT_ACCESS",
    userId,
  }).toString();

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
        body,
      });
    } catch (err) {
      // Network-level failure — retry within budget.
      lastError = err;
      continue;
    }

    if (response.ok) {
      const token = (await response.json()) as BasiqClientToken;
      return token.access_token;
    }

    // 401 — bad API key. No point retrying.
    if (response.status === 401) {
      throw new BasiqAuthError(
        "Basiq client-token request failed (401). Check your API key.",
      );
    }

    // 429 / 5xx — transient, retry within budget.
    if (response.status === 429 || response.status >= 500) {
      const parsed = await safeReadBody(response);
      lastError = new BasiqApiError(
        `Basiq client-token request failed with status ${response.status}.`,
        response.status,
        parsed,
      );
      continue;
    }

    // Any other 4xx — terminal, surface body for inspection.
    const parsedBody = await safeReadBody(response);
    throw new BasiqApiError(
      `Basiq client-token request failed with status ${response.status}.`,
      response.status,
      parsedBody,
    );
  }

  // All retries exhausted — throw the last error we captured.
  throw lastError;
}

// ---------------------------------------------------------------------------
// Consent UI URL construction
// ---------------------------------------------------------------------------

export interface ConsentUrlOptions {
  /** CLIENT_ACCESS token from `getClientToken`. */
  clientToken: string;
  /** Where Basiq should redirect the user back to after consent completes. */
  redirectUrl: string;
  /**
   * Whether this is a fresh connection (`"connect"`) or a re-consent flow
   * for an existing invalid connection (`"reauthenticate"`). Defaults to
   * `"connect"`.
   */
  action?: "connect" | "reauthenticate";
  /**
   * Optional Basiq institution ID. When provided, the Consent UI skips
   * the institution-picker step and goes straight to that bank.
   */
  institutionId?: string;
}

/**
 * Build the URL to redirect a user to for the Basiq Consent UI.
 *
 * The Consent UI is hosted by Basiq; we construct the URL with a
 * userId-scoped client token plus the action and redirect target. All
 * parameter values are URL-encoded by `URLSearchParams`.
 */
export function buildConsentUrl(options: ConsentUrlOptions): string {
  const { clientToken, redirectUrl, action = "connect", institutionId } = options;

  if (!clientToken) {
    throw new BasiqError("buildConsentUrl requires a clientToken.");
  }
  if (!redirectUrl) {
    throw new BasiqError("buildConsentUrl requires a redirectUrl.");
  }

  const params = new URLSearchParams({
    token: clientToken,
    action,
    redirect: redirectUrl,
  });

  if (institutionId) {
    params.set("institutionId", institutionId);
  }

  return `${CONSENT_BASE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
