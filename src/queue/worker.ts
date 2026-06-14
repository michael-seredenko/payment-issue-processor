import type { IssueRepository } from "../db/repository.js";
import type { JobQueue } from "./queue.js";
import type { Job } from "../domain/types.js";

const POLL_INTERVAL_MS = 1_000;

/**
 * Polling worker loop. Runs in the same process as the API for this exercise
 * (it would be a separate process/deployment at real scale — see README).
 *
 * Stop/restart safety comes from the queue, not the worker: stop() just
 * finishes the in-flight job and exits; anything still leased is reclaimed
 * by another (or the next) worker when the lease expires.
 */
export class Worker {
  private running = false;

  constructor(
    private queue: JobQueue,
    private repo: IssueRepository,
    /** The actual work: run the agent pipeline for one issue. Injected so tests can fake it. */
    private processIssue: (issueId: string) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const job = this.queue.claim();
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await this.runJob(job);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Process one claimed job. Public so tests can drive it without the poll loop. */
  async runJob(job: Job): Promise<void> {
    try {
      // Crash recovery: a prior attempt may have finished the work (issue moved
      // to a terminal or awaiting_review state) but died before complete(). Don't
      // re-run it — just finish the job. Re-running would duplicate the agent
      // decision and hit an illegal transition (e.g. resolved -> processing).
      const issue = this.repo.getIssue(job.issue_id);
      if (issue && issue.status !== "pending" && issue.status !== "processing") {
        this.queue.complete(job.id);
        return;
      }

      // No-op if already 'processing' (re-run after a crash / expired lease).
      this.repo.transitionStatus(job.issue_id, "processing", `worker attempt ${job.attempts}`);
      await this.processIssue(job.issue_id);
      this.queue.complete(job.id);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const { willRetry } = this.queue.fail(job, error);
      if (!willRetry) {
        this.repo.transitionStatus(
          job.issue_id,
          "failed",
          `gave up after ${job.attempts} attempts: ${error.message}`,
        );
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
