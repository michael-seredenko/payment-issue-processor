import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/database.js";
import { IssueRepository } from "../src/db/repository.js";
import { buildServer } from "../src/api/server.js";

/**
 * API tests via supertest against buildServer() with an in-memory DB.
 * The agent is never invoked here — these test the HTTP + persistence layer.
 */

let db: Database.Database;
let repo: IssueRepository;
let app: Express;

const validIssue = {
  id: "iss_001",
  type: "decline",
  customer_id: "cust_042",
  error_code: "insufficient_funds",
  amount: 89.99,
};

function seedCustomer(id = "cust_042") {
  repo.upsertCustomer({
    id,
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
}

/** Walk an issue into the state the human-review endpoint expects. */
function setUpReviewableIssue(opts: { agentRecommendation: "auto_resolve" | "escalate" }) {
  seedCustomer();
  repo.createIssue({ id: "iss_rev", type: "dispute", customer_id: "cust_042", payload: {} });
  repo.transitionStatus("iss_rev", "processing");
  repo.recordAgentDecision("iss_rev", {
    recommendation: opts.agentRecommendation,
    confidence: 0.55,
    reasoning: "ambiguous facts",
    routing: "queued_for_human",
  });
  repo.transitionStatus("iss_rev", "awaiting_review", "confidence below threshold");
}

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = new IssueRepository(db);
  app = buildServer(repo);
});

function jobCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n;
}

describe("POST /issues", () => {
  it("accepts a valid issue, returns 201, and enqueues exactly one job", async () => {
    seedCustomer();
    const res = await request(app).post("/issues").send(validIssue);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe("/issues/iss_001");
    expect(res.body.status).toBe("pending");
    // type-specific fields survive the round trip into payload
    expect(res.body.payload).toMatchObject({ error_code: "insufficient_funds", amount: 89.99 });
    expect(jobCount()).toBe(1);
  });

  it("generates an id when the client does not provide one", async () => {
    seedCustomer();
    const { id: _omitted, ...withoutId } = validIssue;
    const res = await request(app).post("/issues").send(withoutId);

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^iss_/);
  });

  it("rejects an unknown issue type with 400", async () => {
    seedCustomer();
    const res = await request(app).post("/issues").send({ ...validIssue, type: "chargeback" });

    expect(res.status).toBe(400);
    expect(res.body.details.join()).toContain("type");
    expect(jobCount()).toBe(0);
  });

  it("re-submitting the same issue id returns 409 and does not enqueue a second job", async () => {
    seedCustomer();
    await request(app).post("/issues").send(validIssue);
    const res = await request(app).post("/issues").send(validIssue);

    expect(res.status).toBe(409);
    expect(jobCount()).toBe(1);
  });

  it("rejects an issue referencing an unknown customer with 422", async () => {
    const res = await request(app).post("/issues").send(validIssue); // no customer seeded

    expect(res.status).toBe(422);
    expect(jobCount()).toBe(0);
  });
});

describe("GET /issues", () => {
  it("lists issues and filters by status", async () => {
    seedCustomer();
    repo.createIssue({ id: "iss_a", type: "decline", customer_id: "cust_042", payload: {} });
    repo.createIssue({ id: "iss_b", type: "dispute", customer_id: "cust_042", payload: {} });
    repo.transitionStatus("iss_b", "processing");

    const all = await request(app).get("/issues");
    expect(all.body).toHaveLength(2);

    const pending = await request(app).get("/issues?status=pending");
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0].id).toBe("iss_a");
  });

  it("rejects an invalid status filter with 400", async () => {
    const res = await request(app).get("/issues?status=nonsense");
    expect(res.status).toBe(400);
  });
});

describe("GET /issues/:id", () => {
  it("returns the issue with its status history and decisions", async () => {
    setUpReviewableIssue({ agentRecommendation: "escalate" });

    const res = await request(app).get("/issues/iss_rev");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("awaiting_review");
    expect(res.body.history.map((h: { to_status: string }) => h.to_status)).toEqual([
      "pending",
      "processing",
      "awaiting_review",
    ]);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0]).toMatchObject({ actor: "agent", recommendation: "escalate" });
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).get("/issues/iss_nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /issues/:id/review", () => {
  it("records the human decision and marks verdict 'agreed' when it matches the agent", async () => {
    setUpReviewableIssue({ agentRecommendation: "escalate" });

    const res = await request(app)
      .post("/issues/iss_rev/review")
      .send({ recommendation: "escalate", reasoning: "agree — possible fraud pattern" });

    expect(res.status).toBe(200);
    expect(res.body.decision).toMatchObject({ actor: "human", human_verdict: "agreed" });
    expect(res.body.decision.reviews_decision_id).toBe(res.body.issue.decisions[0].id);
    expect(res.body.issue.status).toBe("escalated");
  });

  it("marks verdict 'modified' when the human picks a different action", async () => {
    setUpReviewableIssue({ agentRecommendation: "escalate" });

    const res = await request(app)
      .post("/issues/iss_rev/review")
      .send({ recommendation: "auto_resolve", reasoning: "customer history justifies goodwill refund" });

    expect(res.status).toBe(200);
    expect(res.body.decision.human_verdict).toBe("modified");
    expect(res.body.issue.status).toBe("resolved");
  });

  it("accepts an explicit 'rejected' verdict that overrides the computed one", async () => {
    setUpReviewableIssue({ agentRecommendation: "auto_resolve" });

    const res = await request(app)
      .post("/issues/iss_rev/review")
      .send({ recommendation: "escalate", reasoning: "agent missed the dispute policy", verdict: "rejected" });

    expect(res.status).toBe(200);
    expect(res.body.decision.human_verdict).toBe("rejected");
    expect(res.body.issue.status).toBe("escalated");
  });

  it("returns 409 when the issue is not in a reviewable state", async () => {
    seedCustomer();
    repo.createIssue({ id: "iss_new", type: "decline", customer_id: "cust_042", payload: {} });

    const res = await request(app)
      .post("/issues/iss_new/review")
      .send({ recommendation: "escalate", reasoning: "too early" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("pending");
  });

  it("returns 404 for an unknown issue", async () => {
    const res = await request(app)
      .post("/issues/iss_nope/review")
      .send({ recommendation: "escalate", reasoning: "n/a" });

    expect(res.status).toBe(404);
  });
});
