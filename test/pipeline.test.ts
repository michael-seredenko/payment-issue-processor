import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/database.js";
import { IssueRepository } from "../src/db/repository.js";
import { JobQueue } from "../src/queue/queue.js";
import { Worker } from "../src/queue/worker.js";
import { buildServer } from "../src/api/server.js";
import { finalizeDecision } from "../src/agent/pipeline.js";
import type { AgentAssessment, Issue } from "../src/domain/types.js";

/**
 * Routing-execution tests. The agent itself (runAgent) is never invoked — no
 * API key needed; we feed fabricated assessments into finalizeDecision, which
 * is the seam between "the model decided" and "the system acts".
 */

let db: Database.Database;
let repo: IssueRepository;
let queue: JobQueue;

function assessment(over: Partial<AgentAssessment> = {}): AgentAssessment {
  return {
    recommendation: "auto_resolve",
    confidence: 0.95,
    reasoning: "policy clause maps cleanly to the facts",
    policy_citations: ["Refund Requests / Changed Mind"],
    ...over,
  };
}

/**
 * An issue the worker has already picked up (pending -> processing). It's a
 * legitimately auto-resolvable refund (low-risk customer, within the 14-day
 * window, not yet shipped) so the confidence guards don't interfere — these
 * tests exercise routing, not the guards (those live in routing.test.ts).
 */
function processingIssue(id = "iss_p"): Issue {
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
  repo.upsertTransaction({
    id: "txn_p",
    customer_id: "cust_test",
    merchant: "HomeEssentials",
    amount: 100,
    status: "active_installment",
    created_at: "2025-01-01T00:00:00Z",
    shipping: { status: "not_shipped" },
  });
  const issue = repo.createIssue({
    id,
    type: "refund_request",
    customer_id: "cust_test",
    transaction_id: "txn_p",
    payload: { reason: "changed_mind", days_since_purchase: 3, amount: 100 },
  });
  repo.transitionStatus(id, "processing");
  return issue;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = new IssueRepository(db);
  queue = new JobQueue(db);
});

describe("finalizeDecision routing", () => {
  it("auto-executes a high-confidence auto_resolve (>= 0.90) to resolved", () => {
    const issue = processingIssue();

    const { routing } = finalizeDecision(repo, issue, assessment({ confidence: 0.95 }));

    expect(routing).toBe("auto_executed");
    const stored = repo.getIssue(issue.id)!;
    expect(stored.status).toBe("resolved");
    expect(stored.decisions[0]).toMatchObject({
      actor: "agent",
      recommendation: "auto_resolve",
      routing: "auto_executed",
    });
    // the audit trail carries the confidence that drove the decision
    expect(stored.history.at(-1)!.reason).toContain("0.95");
  });

  it("executes a mid-confidence escalate (0.70-0.89) but leaves it reviewable", async () => {
    const issue = processingIssue();

    const { routing } = finalizeDecision(repo, issue, assessment({ recommendation: "escalate", confidence: 0.8 }));

    expect(routing).toBe("executed_flagged_for_review");
    expect(repo.getIssue(issue.id)!.status).toBe("escalated");

    // 'escalated' is reviewable: a human can still override the flagged execution
    const app = buildServer(repo);
    const res = await request(app)
      .post(`/issues/${issue.id}/review`)
      .send({ recommendation: "auto_resolve", reasoning: "customer history justifies goodwill refund" });

    expect(res.status).toBe(200);
    expect(res.body.decision.human_verdict).toBe("modified");
    expect(res.body.issue.status).toBe("resolved");
  });

  it("holds a low-confidence decision (< 0.70) for a human, taking no action", () => {
    const issue = processingIssue();

    const { routing } = finalizeDecision(repo, issue, assessment({ confidence: 0.5 }));

    expect(routing).toBe("queued_for_human");
    expect(repo.getIssue(issue.id)!.status).toBe("awaiting_review");
  });

  it("routes a confident human_review recommendation to a human anyway", () => {
    const issue = processingIssue();

    // Confidence alone would auto-execute; the recommendation to involve a
    // human must win.
    finalizeDecision(repo, issue, assessment({ recommendation: "human_review", confidence: 0.95 }));

    expect(repo.getIssue(issue.id)!.status).toBe("awaiting_review");
  });
});

describe("Worker crash recovery with terminal states", () => {
  it("does not re-run an issue that already reached a terminal state", async () => {
    const issue = processingIssue();
    // A prior attempt resolved the issue but crashed before complete().
    repo.transitionStatus(issue.id, "resolved", "prior attempt resolved it");

    const job = queue.claim()!; // the in-flight job from that crashed attempt
    db.prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), job.id); // lease expired

    let processed = 0;
    const worker = new Worker(queue, repo, async () => {
      processed++;
    });

    await worker.runJob(queue.claim()!); // reclaim + run

    expect(processed).toBe(0); // work was NOT re-run
    expect(queue.getJob(job.job_key)!.status).toBe("done"); // job finished cleanly
    expect(repo.getIssue(issue.id)!.status).toBe("resolved"); // unchanged
  });
});
