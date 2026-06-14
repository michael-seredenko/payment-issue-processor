import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { IssueRepository } from "../src/db/repository.js";
import { seedReferenceData, loadIssues, toSubmission, type RawIssue } from "../src/data.js";

describe("data helpers", () => {
  it("seedReferenceData loads the reference tables (idempotently)", () => {
    const repo = new IssueRepository(openDatabase(":memory:"));

    const first = seedReferenceData(repo);
    expect(first).toEqual({ customers: 4, transactions: 5 });
    expect(repo.getCustomer("cust_042")).not.toBeNull();
    expect(repo.getTransaction("txn_5521")).not.toBeNull();

    // re-running upserts, doesn't error or duplicate
    expect(seedReferenceData(repo)).toEqual({ customers: 4, transactions: 5 });
  });

  it("loadIssues returns the 5 mock issues", () => {
    const issues = loadIssues();
    expect(issues).toHaveLength(5);
    expect(issues[0]!.id).toBe("iss_001");
  });

  it("toSubmission splits top-level fields from type-specific payload", () => {
    const raw = {
      id: "iss_x",
      type: "decline",
      customer_id: "cust_x",
      transaction_id: "txn_x",
      error_code: "insufficient_funds",
      amount: 50,
    } as RawIssue;

    const sub = toSubmission(raw);

    expect(sub).toMatchObject({
      id: "iss_x",
      type: "decline",
      customer_id: "cust_x",
      transaction_id: "txn_x",
    });
    expect(sub.payload).toEqual({ error_code: "insufficient_funds", amount: 50 });
  });

  it("toSubmission defaults a missing transaction_id to null", () => {
    const sub = toSubmission({ id: "i", type: "dispute", customer_id: "c" } as RawIssue);
    expect(sub.transaction_id).toBeNull();
  });
});
