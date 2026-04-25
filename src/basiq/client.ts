import {
  BasiqAuthError,
  BasiqError,
  clearTokenCache,
  getServerToken,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown for non-retryable 4xx responses (other than 401, which is handled
 * via token refresh). Carries the HTTP status code and the parsed JSON body
 * (or raw text fallback) so callers can branch on Basiq error codes.
 */
export class BasiqApiError extends BasiqError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "BasiqApiError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://au-api.basiq.io";
const BASIQ_VERSION = "3.0";

const MAX_TRANSIENT_RETRIES = 2;
const BACKOFF_MS = [1000, 2000];

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface BasiqClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class BasiqClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL }: BasiqClientOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Authenticated GET, optionally with URL-encoded query parameters. */
  async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(path, query);
    const response = await this.requestWithRetries("GET", url);
    return (await response.json()) as T;
  }

  /** Authenticated POST with optional JSON body. */
  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const response = await this.requestWithRetries("POST", url, body);
    // Some POSTs (e.g. job creation) return 202 with a body; others may
    // return 204. Parse JSON only when there's content to read.
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /** Authenticated DELETE. Expects 204 No Content (no body returned). */
  async delete(path: string): Promise<void> {
    const url = this.buildUrl(path);
    await this.requestWithRetries("DELETE", url);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildUrl(path: string, query?: Record<string, string>): string {
    const normalisedPath = path.startsWith("/") ? path : `/${path}`;
    let url = `${this.baseUrl}${normalisedPath}`;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        params.append(key, value);
      }
      url += `?${params.toString()}`;
    }
    return url;
  }

  private async buildHeaders(hasJsonBody: boolean): Promise<HeadersInit> {
    const token = await getServerToken(this.apiKey);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "basiq-version": BASIQ_VERSION,
      Accept: "application/json",
    };
    if (hasJsonBody) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Single HTTP attempt. Returns the raw `Response` on success so callers
   * can decide how to parse it. Throws on non-2xx; the retry loop above
   * decides whether to retry based on status code / error type.
   */
  private async sendOnce(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response> {
    const hasBody = body !== undefined;
    const headers = await this.buildHeaders(hasBody);

    const init: RequestInit = { method, headers };
    if (hasBody) {
      init.body = JSON.stringify(body);
    }

    return fetch(url, init);
  }

  /**
   * Drives retries for transient failures (429, 5xx, network) and a single
   * 401-triggered token refresh. Throws `BasiqApiError` for non-retryable
   * 4xx, `BasiqAuthError` if a refreshed token still 401s, or the last
   * captured error after retries are exhausted.
   */
  private async requestWithRetries(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response> {
    let transientAttempts = 0;
    let didRefreshToken = false;
    let lastError: unknown;

    // The loop terminates by `return` on success or `throw` on terminal
    // failure. The retry counters bound iterations.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response: Response;
      try {
        response = await this.sendOnce(method, url, body);
      } catch (err) {
        // Network-level failure (DNS, socket, etc.) — retry within budget.
        lastError = err;
        if (transientAttempts < MAX_TRANSIENT_RETRIES) {
          await sleep(BACKOFF_MS[transientAttempts]);
          transientAttempts++;
          continue;
        }
        throw err;
      }

      if (response.ok) {
        return response;
      }

      // 401 — token may be stale. Clear cache and retry once with a fresh
      // token. If we've already done that, escalate to BasiqAuthError.
      if (response.status === 401) {
        if (didRefreshToken) {
          throw new BasiqAuthError(
            `Basiq returned 401 after token refresh for ${method} ${url}.`,
          );
        }
        clearTokenCache();
        didRefreshToken = true;
        continue;
      }

      // 429 / 5xx — transient, retry within budget.
      if (response.status === 429 || response.status >= 500) {
        const parsed = await safeReadBody(response);
        lastError = new BasiqApiError(
          `Basiq ${method} ${url} failed with status ${response.status}.`,
          response.status,
          parsed,
        );
        if (transientAttempts < MAX_TRANSIENT_RETRIES) {
          await sleep(BACKOFF_MS[transientAttempts]);
          transientAttempts++;
          continue;
        }
        throw lastError;
      }

      // Any other 4xx — terminal, surface to caller with body for inspection.
      const parsedBody = await safeReadBody(response);
      throw new BasiqApiError(
        `Basiq ${method} ${url} failed with status ${response.status}.`,
        response.status,
        parsedBody,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a response body, preferring JSON. Falls back to raw text if the body
 * isn't valid JSON, and to `null` if the body can't be read at all. Used for
 * surfacing error detail without throwing while constructing an error.
 */
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
