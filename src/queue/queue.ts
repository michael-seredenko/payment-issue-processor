import type Database from "better-sqlite3";
import type { Job } from "../domain/types.js";

const LEASE_MS = 5 * 60 * 1000; // generous: one agent run can take minutes
const BASE_BACKOFF_MS = 2_000;

/**
 * SQLite-backed job queue.
 *
 * Guarantees:
 * - Idempotent enqueue: UNIQUE(job_key) — submitting the same issue twice
 *   creates one job.
 * - At-most-one worker per job: claim is a single atomic
 *   UPDATE ... WHERE id = (SELECT ...) RETURNING, so two pollers can't both
 *   win the same row.
 * - Crash recovery: a claimed job holds a lease (lease_expires_at). If the
 *   process dies mid-run, the lease expires and the job becomes claimable
 *   again — work is never lost, at-least-once execution. The processing step
 *   itself must therefore be safe to re-run (it is: re-deciding an issue
 *   overwrites nothing, and same-status transitions are no-ops).
 * - Retries with exponential backoff + jitter: run_at = now + base * 2^attempts.
 *   After max_attempts the job goes 'dead'; the worker marks the issue 'failed'.
 */
export class JobQueue {
  constructor(private db: Database.Database) {}

  enqueue(issueId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO jobs (job_key, issue_id) VALUES (?, ?)`)
      .run(`process-issue:${issueId}`, issueId);
  }

  /** Atomically claim the next runnable job (pending & due, or running with an expired lease). */
  claim(now: Date = new Date()): Job | null {
    const nowIso = now.toISOString();
    const leaseIso = new Date(now.getTime() + LEASE_MS).toISOString();

    const row = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             attempts = attempts + 1,
             lease_expires_at = @lease,
             updated_at = @now
         WHERE id = (
           SELECT id FROM jobs
           WHERE (status = 'pending' AND run_at <= @now)
              OR (status = 'running' AND lease_expires_at < @now)
           ORDER BY run_at
           LIMIT 1
         )
         RETURNING *`,
      )
      .get({ now: nowIso, lease: leaseIso }) as Job | undefined;

    return row ?? null;
  }

  complete(jobId: number): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'done', lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(jobId);
  }

  /** Schedule a retry with backoff, or kill the job if attempts are exhausted. */
  fail(job: Job, error: Error, now: Date = new Date()): { willRetry: boolean } {
    const willRetry = job.attempts < job.max_attempts;

    if (willRetry) {
      const runAt = new Date(now.getTime() + backoffMs(job.attempts)).toISOString();
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'pending', run_at = ?, lease_expires_at = NULL, last_error = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(runAt, error.message, job.id);
    } else {
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'dead', lease_expires_at = NULL, last_error = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(error.message, job.id);
    }

    return { willRetry };
  }

  /** Test/ops helper. */
  getJob(jobKey: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE job_key = ?`).get(jobKey) as Job | undefined;
    return row ?? null;
  }
}

export function backoffMs(attempts: number): number {
  const jitter = Math.random() * 1_000;
  return BASE_BACKOFF_MS * 2 ** attempts + jitter;
}
