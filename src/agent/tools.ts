import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync } from "node:fs";
import type { IssueRepository } from "../db/repository.js";

/**
 * Context-gathering tools exposed to the agent as an in-process MCP server.
 *
 * Design: the agent is given *lookup* tools only — it can read customer
 * history, transaction details, and the policy document, but it cannot
 * mutate anything. Execution of the recommendation (refund, retry, escalate)
 * stays in deterministic application code, gated by the confidence router.
 * The model recommends; the system acts.
 */
export function buildAgentTools(repo: IssueRepository) {
  const getCustomerProfile = tool(
    "get_customer_profile",
    "Look up a customer's profile and payment history. Call this for every issue — risk_score and lifetime_spend drive several policy rules.",
    { customer_id: z.string() },
    async ({ customer_id }) => {
      const customer = repo.getCustomer(customer_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(customer ?? { error: "not found" }) }],
      };
    },
  );

  const getTransactionDetails = tool(
    "get_transaction_details",
    "Look up a transaction, including installment plan, shipping/tracking, and subscription details. Call this when the issue references a transaction — shipping status and installment state drive dispute and refund policies.",
    { transaction_id: z.string() },
    async ({ transaction_id }) => {
      const txn = repo.getTransaction(transaction_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(txn ?? { error: "not found" }) }],
      };
    },
  );

  const getPolicies = tool(
    "get_resolution_policies",
    "Read the full payment-issue resolution policy document. Call this once per issue before deciding.",
    {},
    async () => {
      const policies = readFileSync(new URL("../../data/policies.md", import.meta.url), "utf-8");
      return { content: [{ type: "text" as const, text: policies }] };
    },
  );

  return createSdkMcpServer({
    name: "payment-context",
    version: "1.0.0",
    tools: [getCustomerProfile, getTransactionDetails, getPolicies],
  });
}
