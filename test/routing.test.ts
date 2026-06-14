import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/database.js";
import { IssueRepository } from "../src/db/repository.js";
import { deriveConfidence, routeByConfidence } from "../src/agent/confidence.js";
import type { AgentAssessment, Issue } from "../src/domain/types.js";

/**
 * The "interesting edge case" tests: confidence boundaries and the
 * deterministic guards that override agent self-confidence.
 */
describe("routeByConfidence", () => {
  it("routes the exact boundaries per the spec", () => {
    expect(routeByConfidence(0.9)).toBe("auto_executed"); // >= 90 auto
    expect(routeByConfidence(0.8999)).toBe("executed_flagged_for_review");
    expect(routeByConfidence(0.7)).toBe("executed_flagged_for_review"); // 70-89 flag
    expect(routeByConfidence(0.6999)).toBe("queued_for_human"); // < 70 hold
    expect(routeByConfidence(0)).toBe("queued_for_human");
    expect(routeByConfidence(1)).toBe("auto_executed");
  });
});

describe("deriveConfidence guards", () => {
  let db: Database.Database;
  let repo: IssueRepository;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new IssueRepository(db);
  });

  function seedCustomer(over: Record<string, unknown> = {}) {
    repo.upsertCustomer({
      id: "cust_x",
      email: "t@example.com",
      name: "Test",
      account_created: "2024-01-01",
      lifetime_transactions: 5,
      lifetime_spend: 100,
      successful_payments: 5,
      failed_payments: 0,
      disputes_filed: 0,
      disputes_won: 0,
      current_installment_plans: 0,
      risk_score: "low",
      ...over,
    });
  }

  function seedTransaction(over: Record<string, unknown> & { id: string }) {
    repo.upsertTransaction({
      customer_id: "cust_x",
      merchant: "M",
      amount: 100,
      status: "completed",
      created_at: "2025-01-01T00:00:00Z",
      ...over,
    });
  }

  function assessment(over: Partial<AgentAssessment> = {}): AgentAssessment {
    return {
      recommendation: "auto_resolve",
      confidence: 0.95,
      reasoning: "policy clause applies",
      policy_citations: [],
      ...over,
    };
  }

  function createIssue(over: Partial<Pick<Issue, "id" | "type" | "transaction_id">> & { payload: Record<string, unknown> }): Issue {
    return repo.createIssue({
      id: over.id ?? "iss_x",
      type: over.type ?? "decline",
      customer_id: "cust_x",
      transaction_id: over.transaction_id ?? null,
      payload: over.payload,
    });
  }

  it("caps confidence when the agent recommends auto_resolve on a never-auto-resolvable case", () => {
    seedCustomer();
    const issue = createIssue({ type: "decline", payload: { error_code: "insufficient_funds", amount: 50 } });

    const { confidence, adjustments } = deriveConfidence(assessment({ confidence: 0.95 }), issue, repo);

    expect(confidence).toBeLessThanOrEqual(0.3);
    expect(routeByConfidence(confidence)).toBe("queued_for_human");
    expect(adjustments.map((a) => a.rule)).toContain("decline-never-auto");
  });

  it("caps confidence for high-value customers (lifetime_spend > $2000)", () => {
    seedCustomer({ lifetime_spend: 4205 });
    // A legitimately auto-resolvable refund, so no hard guard fires — only the dampener.
    seedTransaction({ id: "txn_r", shipping: { status: "not_shipped" } });
    const issue = createIssue({
      type: "refund_request",
      transaction_id: "txn_r",
      payload: { reason: "changed_mind", days_since_purchase: 3, amount: 100 },
    });

    const { confidence, adjustments } = deriveConfidence(assessment({ confidence: 0.95 }), issue, repo);

    expect(confidence).toBe(0.85);
    expect(routeByConfidence(confidence)).toBe("executed_flagged_for_review");
    expect(adjustments.map((a) => a.rule)).toContain("high-value-customer");
  });

  it("an overconfident agent (0.99) still routes to human when a hard guard fires", () => {
    seedCustomer();
    const issue = createIssue({ type: "dispute", payload: { reason: "unauthorized", amount: 500 } });

    const { confidence } = deriveConfidence(assessment({ confidence: 0.99 }), issue, repo);

    expect(routeByConfidence(confidence)).toBe("queued_for_human");
  });

  it("does not cap a non-auto_resolve recommendation (a confident escalate still auto-executes)", () => {
    seedCustomer();
    const issue = createIssue({ type: "decline", payload: { error_code: "card_expired" } });

    const { confidence, adjustments } = deriveConfidence(
      assessment({ recommendation: "escalate", confidence: 0.95 }),
      issue,
      repo,
    );

    expect(confidence).toBe(0.95);
    expect(adjustments).toHaveLength(0);
    expect(routeByConfidence(confidence)).toBe("auto_executed");
  });

  it("leaves a legitimately auto-resolvable case uncapped (the iss_004 refund shape)", () => {
    seedCustomer({ lifetime_spend: 1847.5 });
    seedTransaction({ id: "txn_ok", shipping: { status: "not_shipped" } });
    const issue = createIssue({
      type: "refund_request",
      transaction_id: "txn_ok",
      payload: { reason: "changed_mind", days_since_purchase: 3, amount: 149 },
    });

    const { confidence, adjustments } = deriveConfidence(assessment({ confidence: 0.92 }), issue, repo);

    expect(adjustments).toHaveLength(0);
    expect(confidence).toBe(0.92);
    expect(routeByConfidence(confidence)).toBe("auto_executed");
  });

  it("blocks auto_resolve on item-not-received without confirmed delivery", () => {
    seedCustomer();
    seedTransaction({ id: "txn_inr", amount: 249, shipping: { status: "in_transit" } });
    const issue = createIssue({
      type: "dispute",
      transaction_id: "txn_inr",
      payload: { reason: "item_not_received", amount: 249 },
    });

    const { confidence, adjustments } = deriveConfidence(assessment({ confidence: 0.9 }), issue, repo);

    expect(adjustments.map((a) => a.rule)).toContain("dispute-inr-needs-confirmed-delivery");
    expect(routeByConfidence(confidence)).toBe("queued_for_human");
  });
});
