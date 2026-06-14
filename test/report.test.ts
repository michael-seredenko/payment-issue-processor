import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { IssueRepository } from "../src/db/repository.js";
import { renderReport } from "../src/report.js";

describe("renderReport", () => {
  it("renders a summary row and reasoning for each processed issue", () => {
    const repo = new IssueRepository(openDatabase(":memory:"));
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
    repo.createIssue({ id: "iss_z", type: "decline", customer_id: "cust_test", payload: {} });
    repo.transitionStatus("iss_z", "processing");
    repo.recordAgentDecision("iss_z", {
      recommendation: "escalate",
      confidence: 0.78,
      reasoning: "insufficient-funds policy mandates escalation once retries are exhausted",
      routing: "executed_flagged_for_review",
    });
    repo.transitionStatus("iss_z", "escalated", "agent escalate (confidence 0.78, executed_flagged_for_review)");

    const report = renderReport(repo);

    expect(report).toMatch(/^# Payment Issue Processing/); // doc title for the .md artifact
    expect(report).toContain("| Issue | Type | Agent rec |"); // table header
    expect(report).toContain("iss_z");
    expect(report).toContain("escalate");
    expect(report).toContain("0.78");
    expect(report).toContain("insufficient-funds policy mandates escalation");
  });

  it("marks issues with no agent decision rather than crashing", () => {
    const repo = new IssueRepository(openDatabase(":memory:"));
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
    repo.createIssue({ id: "iss_pending", type: "decline", customer_id: "cust_test", payload: {} });

    const report = renderReport(repo);

    expect(report).toContain("iss_pending");
    expect(report).toContain("No agent decision recorded");
  });
});
