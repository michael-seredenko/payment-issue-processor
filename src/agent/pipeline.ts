import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IssueRepository } from "../db/repository.js";
import type { AgentAssessment, Issue, Routing } from "../domain/types.js";
import { buildAgentTools } from "./tools.js";
import { deriveConfidence, routeByConfidence, type ConfidenceAdjustment } from "./confidence.js";
import { config } from "../config.js";

const MAX_TURNS = 12;

const SYSTEM_PROMPT = `You are a payment-operations analyst for an e-commerce platform.

For each payment issue you receive:
1. Read the resolution policies (get_resolution_policies).
2. Gather context: the customer profile and the transaction details.
3. Apply the policies literally. When a policy says "escalate when X", and X
   holds, you must recommend escalate — do not weigh it against other factors.
4. Recommend exactly one of: auto_resolve, human_review, escalate.

Confidence guidance: reserve >0.9 for cases where a policy clause maps
unambiguously to the facts. If facts are missing, contradictory, or the case
sits near a policy boundary (amount, dates), lower your confidence and say why.

When you are done gathering context, respond with ONLY a single JSON object as
your entire final message — no markdown, no code fence, no prose before or after:
{"recommendation":"auto_resolve"|"human_review"|"escalate","confidence":<number 0..1>,"reasoning":"<2-4 sentences citing the specific policy clauses>","policy_citations":["<policy section names you relied on>"]}`;

/**
 * Single source of truth for the agent's output: validates the JSON the model
 * returns AND (via z.toJSONSchema) generates the schema we hand the model as
 * structured output. No markdown-fence stripping, no prompt-and-pray parsing.
 */
const assessmentSchema = z.object({
  recommendation: z.enum(["auto_resolve", "human_review", "escalate"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  policy_citations: z.array(z.string()),
});

/** The agent gets read-only lookup tools and nothing else (no fs/bash). */
const MCP_TOOLS = [
  "mcp__payment-context__get_customer_profile",
  "mcp__payment-context__get_transaction_details",
  "mcp__payment-context__get_resolution_policies",
];

/**
 * Runs the agent for one issue and persists the outcome. This is the function
 * the worker executes for each job — it must be safe to re-run (at-least-once
 * queue semantics; the worker also skips issues that already left 'processing').
 *
 * Architecture choice: a single investigator agent with lookup tools, rather
 * than a triage/investigation/resolution multi-agent chain. The policy doc is
 * small and the decision is one judgment call — splitting it would add
 * latency, cost, and failure modes without improving the decision.
 * (Trade-off discussed in the README's "Agent architecture" section.)
 */
export async function processIssueWithAgent(repo: IssueRepository, issue: Issue): Promise<void> {
  const assessment = await runAgent(repo, issue);
  finalizeDecision(repo, issue, assessment);
}

/**
 * Everything after the agent has produced an assessment: blend confidence,
 * route, record the decision, and execute the routing. Separated from runAgent
 * so it can be tested with fabricated assessments — no API key, no SDK.
 */
export function finalizeDecision(
  repo: IssueRepository,
  issue: Issue,
  assessment: AgentAssessment,
): { confidence: number; routing: Routing } {
  const { confidence, adjustments } = deriveConfidence(assessment, issue, repo);
  const routing = routeByConfidence(confidence);

  repo.recordAgentDecision(issue.id, {
    recommendation: assessment.recommendation,
    confidence,
    reasoning: assessment.reasoning,
    routing,
  });

  applyAssessment(repo, issue.id, assessment.recommendation, routing, confidence, adjustments);
  return { confidence, routing };
}

/**
 * Execute the routing decision as a status transition. "The model recommends;
 * the system acts" — this deterministic code, not the LLM, performs the move.
 */
export function applyAssessment(
  repo: IssueRepository,
  issueId: string,
  recommendation: AgentAssessment["recommendation"],
  routing: Routing,
  confidence: number,
  adjustments: ConfidenceAdjustment[] = [],
): void {
  // Record which deterministic caps fired, so the audit trail shows *why* an
  // overconfident agent was overridden (the agent's own reasoning stays in the
  // decision record, untouched).
  const caps = adjustments.length ? ` — capped by ${adjustments.map((a) => a.rule).join(", ")}` : "";
  const reason = `agent ${recommendation} (confidence ${confidence.toFixed(2)}, ${routing})${caps}`;

  // A recommendation to involve a human wins even at high confidence: a
  // confident "this needs a human" still means a human. And anything below the
  // auto-execute threshold is held until POST /issues/:id/review.
  if (recommendation === "human_review" || routing === "queued_for_human") {
    repo.transitionStatus(issueId, "awaiting_review", reason);
    return;
  }

  // auto_executed or executed_flagged_for_review: execute the terminal action.
  // Flagged (0.70–0.89) executions land in resolved/escalated like clean ones;
  // the decision row's routing field marks them for async review.
  const to = recommendation === "auto_resolve" ? "resolved" : "escalated";
  repo.transitionStatus(issueId, to, reason);
}

async function runAgent(repo: IssueRepository, issue: Issue): Promise<AgentAssessment> {
  // Include customer_id / transaction_id: the lookup tools take these as
  // arguments, so the agent can't gather context without them in its prompt.
  const prompt = `Analyze this payment issue and recommend an action:\n\n${JSON.stringify(
    {
      id: issue.id,
      type: issue.type,
      customer_id: issue.customer_id,
      transaction_id: issue.transaction_id,
      ...issue.payload,
    },
    null,
    2,
  )}`;

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "payment-context": buildAgentTools(repo) },
      tools: [], // no built-in tools — the agent can only use the lookup MCP tools below
      allowedTools: MCP_TOOLS,
      maxTurns: MAX_TURNS,
      model: config.agentModel,
    },
  })) {
    if (message.type !== "result") continue;

    // Any non-success outcome (max turns, execution error, ...) throws so the
    // queue's backoff/retry handles it. This is the "AI API down for an hour"
    // path: jobs fail, back off, retry, lose nothing.
    if (message.subtype !== "success") {
      throw new Error(`agent run failed for ${issue.id}: ${message.subtype}`);
    }
    return parseAssessment(message.result);
  }

  throw new Error(`agent produced no result for ${issue.id}`);
}

/**
 * This SDK/CLI version returns the agent's final answer as text in `result`
 * (the structured-output channel isn't populated), so we extract the JSON object
 * the system prompt asked for and validate it with the same schema. Malformed
 * output throws → the queue's backoff/retry handles it.
 */
function parseAssessment(resultText: string): AgentAssessment {
  const fenced = resultText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? resultText;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("agent output contained no JSON object");
  }
  return assessmentSchema.parse(JSON.parse(body.slice(start, end + 1)));
}
