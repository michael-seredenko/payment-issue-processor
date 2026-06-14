import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/database.js";
import { IssueRepository } from "../src/db/repository.js";
import { JobQueue } from "../src/queue/queue.js";
import { Worker } from "../src/queue/worker.js";

/**
 * Queue behavior tests (the queue's retry/failure handling):
 * all run against an in-memory SQLite DB — no mocks of the queue itself.
 */

let db: Database.Database;
let repo: IssueRepository;
let queue: JobQueue;

function seedIssue(id = "iss_test") {
  repo.upsertCustomer({
    id: "cust_test",
    email: "t@example.com",
    name: "Test",
    account_created: "2024-01-01",
    lifetime_transactions: 1,
    lifetime_spend: 100,
    successful_payments: 1,
    failed_payments: 0,
    disputes_filed: 0,
    disputes_won: 0,
    current_installment_plans: 0,
    risk_score: "low",
  });
  return repo.createIssue({
    id,
    type: "decline",
    customer_id: "cust_test",
    payload: { error_code: "insufficient_funds", amount: 10 },
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = new IssueRepository(db);
  queue = new JobQueue(db);
});

describe("JobQueue", () => {
  it("enqueue is idempotent: enqueueing the same issue twice creates one job", () => {
    seedIssue(); // createIssue already enqueues
    queue.enqueue("iss_test"); // second explicit enqueue
    const count = db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("claim returns pending jobs and marks them running with a lease", () => {
    seedIssue();
    const job = queue.claim();
    expect(job).not.toBeNull();
    expect(job!.issue_id).toBe("iss_test");
    expect(job!.status).toBe("running");
    expect(job!.attempts).toBe(1);
    expect(job!.lease_expires_at).not.toBeNull();
  });

  it("claim never hands the same job to two callers", () => {
    seedIssue();
    expect(queue.claim()).not.toBeNull();
    expect(queue.claim()).toBeNull(); // already running with a live lease
  });

  it("fail() schedules a retry with exponential backoff (run_at moves into the future)", () => {
    seedIssue();
    const job = queue.claim()!;
    const now = new Date();

    const { willRetry } = queue.fail(job, new Error("AI API timed out"), now);

    expect(willRetry).toBe(true);
    const stored = queue.getJob(job.job_key)!;
    expect(stored.status).toBe("pending");
    expect(stored.last_error).toBe("AI API timed out");
    expect(new Date(stored.run_at).getTime()).toBeGreaterThan(now.getTime());

    // Not due yet -> not claimable now, claimable once its run_at has passed.
    expect(queue.claim(now)).toBeNull();
    const afterBackoff = new Date(new Date(stored.run_at).getTime() + 1);
    const retried = queue.claim(afterBackoff);
    expect(retried).not.toBeNull();
    expect(retried!.attempts).toBe(2);
  });

  it("fail() marks the job dead once attempts are exhausted", () => {
    seedIssue();
    db.prepare(`UPDATE jobs SET max_attempts = 1`).run();
    const job = queue.claim()!;

    const { willRetry } = queue.fail(job, new Error("still broken"));

    expect(willRetry).toBe(false);
    expect(queue.getJob(job.job_key)!.status).toBe("dead");
    expect(queue.claim()).toBeNull(); // dead jobs are never claimable
  });

  it("a running job with an expired lease is reclaimable (crash recovery)", () => {
    seedIssue();
    const job = queue.claim()!;
    expect(queue.claim()).toBeNull(); // lease held

    // Simulate a crashed worker: lease expires without complete()/fail().
    db.prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    const reclaimed = queue.claim();
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(2);
  });
});

describe("Worker", () => {
  it("completes the job and leaves the issue 'processing' for the pipeline to resolve", async () => {
    seedIssue();
    const worker = new Worker(queue, repo, async () => {
      /* pipeline succeeds; it owns the terminal transition */
    });

    await worker.runJob(queue.claim()!);

    expect(queue.getJob("process-issue:iss_test")!.status).toBe("done");
    expect(repo.getIssue("iss_test")!.status).toBe("processing");
  });

  it("marks the issue 'failed' with a history entry after the final attempt", async () => {
    seedIssue();
    db.prepare(`UPDATE jobs SET max_attempts = 2`).run();
    const worker = new Worker(queue, repo, async () => {
      throw new Error("model unavailable");
    });

    await worker.runJob(queue.claim()!); // attempt 1 -> retry scheduled
    let issue = repo.getIssue("iss_test")!;
    expect(issue.status).toBe("processing"); // still in flight from the issue's perspective

    db.prepare(`UPDATE jobs SET run_at = ?`).run(new Date(Date.now() - 1).toISOString());
    await worker.runJob(queue.claim()!); // attempt 2 -> dead

    issue = repo.getIssue("iss_test")!;
    expect(issue.status).toBe("failed");
    expect(queue.getJob("process-issue:iss_test")!.status).toBe("dead");
    const last = issue.history.at(-1)!;
    expect(last.to_status).toBe("failed");
    expect(last.reason).toContain("model unavailable");
  });

  it("re-running a job after a crash is safe (same-status transition is a no-op)", async () => {
    seedIssue();
    const worker = new Worker(queue, repo, async () => {});

    const job = queue.claim()!;
    // Crash simulation: first run claimed + transitioned to 'processing', then died.
    repo.transitionStatus("iss_test", "processing");
    db.prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    await worker.runJob(queue.claim()!); // reclaim + re-run

    const issue = repo.getIssue("iss_test")!;
    expect(issue.status).toBe("processing");
    // exactly one pending->processing history entry despite two runs
    const processingEntries = issue.history.filter((h) => h.to_status === "processing");
    expect(processingEntries).toHaveLength(1);
  });
});
