import { BasiqError } from "./auth.js";
import type { BasiqClient } from "./client.js";
import type { BasiqJob, BasiqJobStep } from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when one of the job's steps reports `status: "failed"`. The failing
 * step is attached so callers can surface its `result.code` / `result.detail`
 * in error messages or logs.
 */
export class JobFailedError extends BasiqError {
  constructor(
    message: string,
    public readonly jobId: string,
    public readonly failedStep: BasiqJobStep,
  ) {
    super(message);
    this.name = "JobFailedError";
  }
}

/** Thrown when a job has not reached a terminal state within `timeoutMs`. */
export class JobTimeoutError extends BasiqError {
  constructor(
    message: string,
    public readonly jobId: string,
  ) {
    super(message);
    this.name = "JobTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PollOptions {
  /** Delay between polls in milliseconds. Defaults to 1000. */
  intervalMs?: number;
  /**
   * Maximum total time to wait for the job to complete, in milliseconds.
   * Defaults to 90000 (90s). Throws `JobTimeoutError` if exceeded.
   */
  timeoutMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Poll `GET /jobs/{jobId}` until every step reaches `"success"`, or one
 * reaches `"failed"`, or `timeoutMs` elapses. Returns the final job.
 *
 * Logs a one-line summary of step states on every poll so the user can see
 * progress in the terminal — e.g.
 * `Job abc123: verify-credentials=success, retrieve-accounts=in-progress, retrieve-transactions=pending`.
 */
export async function pollJobUntilDone(
  client: BasiqClient,
  jobId: string,
  options: PollOptions = {},
): Promise<BasiqJob> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await client.get<BasiqJob>(`/jobs/${jobId}`);

    logJobProgress(job);

    const failed = job.steps.find((s) => s.status === "failed");
    if (failed) {
      const detail = failed.result?.detail ?? "no detail provided";
      throw new JobFailedError(
        `Basiq job ${jobId} failed at step "${failed.title}": ${detail}`,
        jobId,
        failed,
      );
    }

    const allSuccess =
      job.steps.length > 0 && job.steps.every((s) => s.status === "success");
    if (allSuccess) {
      return job;
    }

    if (Date.now() >= deadline) {
      throw new JobTimeoutError(
        `Basiq job ${jobId} did not complete within ${timeoutMs}ms.`,
        jobId,
      );
    }

    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logJobProgress(job: BasiqJob): void {
  const summary = job.steps
    .map((step) => `${step.title}=${step.status}`)
    .join(", ");
  console.log(`Job ${job.id}: ${summary}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
