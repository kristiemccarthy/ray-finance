import express from "express";
import type { Request, Response } from "express";
import type { Server } from "http";
import { BasiqClient } from "./client.js";
import { buildConsentUrl, getClientToken } from "./consent.js";
import { pollJobUntilDone, type PollOptions } from "./jobs.js";
import type { BasiqJob } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConsentFlowOptions {
  /** Basiq developer API key. */
  apiKey: string;
  /** Basiq userId we're connecting a bank for. */
  userId: string;
  /**
   * Local port for the callback listener. Must match what's reflected back
   * in the consent URL. Defaults to 9876.
   */
  port?: number;
  /**
   * Optional Basiq institution ID. When provided, the Consent UI skips the
   * bank-picker step and goes straight to that bank.
   */
  institutionId?: string;
  /** Override defaults for the post-callback job poll. */
  pollOptions?: PollOptions;
}

export interface ConsentFlowResult {
  /** The Basiq jobId returned in the callback, used for polling. */
  jobId: string;
  /** The completed job object after polling. */
  job: BasiqJob;
  /**
   * The Basiq connectionId that resulted from the consent flow. Extracted
   * from the completed job — see `extractConnectionId` for the field paths
   * tried; if none matched, the full job is logged and this is empty.
   */
  connectionId: string;
}

const DEFAULT_PORT = 9876;
const CALLBACK_PATH = "/basiq/callback";

/**
 * Run the full Basiq consent flow:
 *   1. Mint a CLIENT_ACCESS token for `userId`.
 *   2. Print the Consent UI URL to the console.
 *   3. Spin up a local Express server on `port` to catch Basiq's redirect.
 *   4. When the redirect fires with a jobId, poll the job to completion.
 *   5. Extract the connectionId from the completed job and return it.
 *
 * Rejects on missing jobId in callback, job failure, poll timeout, or
 * server bind errors. Always tears down the Express server before settling.
 */
export async function runConsentFlow(
  options: ConsentFlowOptions,
): Promise<ConsentFlowResult> {
  const { apiKey, userId, port = DEFAULT_PORT, institutionId, pollOptions } =
    options;

  const clientToken = await getClientToken(apiKey, userId);
  const redirectUrl = `http://localhost:${port}${CALLBACK_PATH}`;
  const consentUrl = buildConsentUrl({ clientToken, redirectUrl, institutionId });

  const client = new BasiqClient({ apiKey });

  // The outer promise is settled by the callback handler (after polling)
  // or by the server-bind error handler.
  return new Promise<ConsentFlowResult>((resolve, reject) => {
    const app = express();
    let server: Server | null = null;
    let settled = false;

    const settle = (
      action: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      // Close the server before resolving/rejecting the outer promise so
      // the caller can re-bind the same port if they retry.
      if (server) {
        server.close(() => action());
      } else {
        action();
      }
    };

    app.get(CALLBACK_PATH, (req: Request, res: Response) => {
      const jobId =
        typeof req.query.jobId === "string" ? req.query.jobId : undefined;

      if (!jobId) {
        res
          .status(400)
          .send(errorPage("Missing jobId in Basiq callback query parameters."));
        // Don't settle — Basiq sometimes hits the redirect with extra
        // navigations. Wait for a real jobId or for the user to abort.
        return;
      }

      res.send(progressPage(jobId));

      // Kick off polling in the background. When it resolves (or rejects),
      // settle the outer promise.
      void (async () => {
        try {
          const job = await pollJobUntilDone(client, jobId, pollOptions);
          const connectionId = extractConnectionId(job);
          if (!connectionId) {
            console.warn(
              "Could not locate connectionId in completed job. Full job for inspection:",
            );
            console.warn(JSON.stringify(job, null, 2));
          }
          settle(() => resolve({ jobId, job, connectionId }));
        } catch (err) {
          settle(() => reject(err));
        }
      })();
    });

    server = app.listen(port, () => {
      printConsentPrompt(consentUrl, port);
    });

    server.on("error", (err) => {
      settle(() => reject(err));
    });
  });
}

// ---------------------------------------------------------------------------
// Connection ID extraction
// ---------------------------------------------------------------------------

/**
 * Pull the connectionId out of a completed job. Basiq's job shape isn't
 * fully nailed down for our purposes yet, so we try several known field
 * paths in order. If none match, return an empty string and let the caller
 * dump the full job for empirical inspection.
 */
function extractConnectionId(job: BasiqJob): string {
  // Common shape: each step's `result` carries a URL/href to the resource
  // it created. The verify-credentials step typically points at a connection.
  for (const step of job.steps) {
    const result = step.result as unknown;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      // Direct id field.
      if (typeof r.id === "string" && looksLikeConnectionId(r)) {
        return r.id;
      }
      // url / href pointing at /connections/{id}.
      for (const key of ["url", "href"]) {
        const value = r[key];
        if (typeof value === "string") {
          const match = value.match(/\/connections\/([^/?#]+)/);
          if (match) return match[1];
        }
      }
    }
  }

  // Fallback: scan the job's self link.
  const selfLink = job.links?.self;
  if (typeof selfLink === "string") {
    const match = selfLink.match(/\/connections\/([^/?#]+)/);
    if (match) return match[1];
  }

  return "";
}

function looksLikeConnectionId(record: Record<string, unknown>): boolean {
  return record.type === "connection" || record.resourceType === "connection";
}

// ---------------------------------------------------------------------------
// Console + HTML helpers
// ---------------------------------------------------------------------------

function printConsentPrompt(url: string, port: number): void {
  const bar = "─".repeat(72);
  console.log("");
  console.log(bar);
  console.log("Basiq consent flow ready.");
  console.log(`Listening for callback on http://localhost:${port}${CALLBACK_PATH}`);
  console.log("");
  console.log("Open this URL in your browser to connect a bank:");
  console.log("");
  console.log(`  ${url}`);
  console.log("");
  console.log(bar);
  console.log("");
}

function progressPage(jobId: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Basiq — Connection in progress</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 64px auto; line-height: 1.5;">
    <h1>Connection in progress</h1>
    <p>Basiq is syncing your bank data. You can close this tab — Ray will pick up from here.</p>
    <p style="color:#666;font-size:0.85em;">Job: <code>${escapeHtml(jobId)}</code></p>
  </body>
</html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Basiq — Error</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 64px auto; line-height: 1.5;">
    <h1>Something went wrong</h1>
    <p>${escapeHtml(message)}</p>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
