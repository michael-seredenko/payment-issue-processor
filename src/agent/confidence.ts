import type { IssueRepository } from "../db/repository.js";
import type { AgentAssessment, Issue, Routing } from "../domain/types.js";

/**
 * Confidence design (the README's "Confidence design" section has the full rationale):
 *
 * The agent's self-reported confidence is a useful signal but not a
 * trustworthy one on its own — LLMs are poorly calibrated and tend to be
 * overconfident. So the routed score is min(self_report, ...caps), where the
 * caps come from deterministic checks we can run independent of the model:
 *
 *   1. Hard guards — policy rules from policies.md where auto-resolution is
 *      forbidden. They fire ONLY against an `auto_resolve` recommendation
 *      (escalating or holding is always safe) and cap the score to 0.30, which
 *      routes the issue to a human. Example: the agent says auto_resolve on an
 *      unauthorized-transaction dispute, which the policy says is never
 *      auto-resolvable.
 *   2. Risk dampeners — conditions where the policy says to take extra care
 *      (high-value customer, non-low risk score). They cap to 0.85, which
 *      denies *silent* auto-execution (demotes auto_executed to
 *      executed_flagged_for_review) so a human still sees the case async.
 *
 * Caps (not subtractions) keep the behavior explainable: each applied cap is
 * returned in `adjustments` and recorded on the issue's status history.
 */

const AUTO_RESOLVE_FORBIDDEN_CAP = 0.3; // -> queued_for_human
const RISK_DAMPENER_CAP = 0.85; // -> executed_flagged_for_review (never silent auto-execute)
const HIGH_VALUE_SPEND_THRESHOLD = 2000;

export interface ConfidenceAdjustment {
  rule: string;
  cappedTo: number;
  reason: string;
}

export interface ConfidenceResult {
  confidence: number;
  adjustments: ConfidenceAdjustment[];
}

interface PolicyContext {
  issue: Issue;
  customer: Record<string, unknown> | null;
  transaction: Record<string, unknown> | null;
}

interface HardGuard {
  id: string;
  reason: string;
  /** True if the policy forbids auto-resolving this issue. */
  forbidsAutoResolve: (ctx: PolicyContext) => boolean;
}

interface RiskDampener {
  id: string;
  reason: string;
  applies: (ctx: PolicyContext) => boolean;
}

export function deriveConfidence(
  assessment: AgentAssessment,
  issue: Issue,
  repo: IssueRepository,
): ConfidenceResult {
  let confidence = clamp01(assessment.confidence);
  const adjustments: ConfidenceAdjustment[] = [];

  const ctx: PolicyContext = {
    issue,
    customer: repo.getCustomer(issue.customer_id),
    transaction: issue.transaction_id ? repo.getTransaction(issue.transaction_id) : null,
  };

  // Hard guards only constrain the dangerous direction: auto-resolving
  // something the policy says must not be auto-resolved.
  if (assessment.recommendation === "auto_resolve") {
    for (const guard of HARD_GUARDS) {
      if (guard.forbidsAutoResolve(ctx)) {
        confidence = Math.min(confidence, AUTO_RESOLVE_FORBIDDEN_CAP);
        adjustments.push({ rule: guard.id, cappedTo: AUTO_RESOLVE_FORBIDDEN_CAP, reason: guard.reason });
      }
    }
  }

  // Dampeners apply regardless of recommendation; 0.85 >= 0.70 so escalations
  // still execute (just flagged), but a confident auto_resolve can no longer
  // fire silently.
  for (const dampener of RISK_DAMPENERS) {
    if (dampener.applies(ctx)) {
      confidence = Math.min(confidence, RISK_DAMPENER_CAP);
      adjustments.push({ rule: dampener.id, cappedTo: RISK_DAMPENER_CAP, reason: dampener.reason });
    }
  }

  return { confidence, adjustments };
}

/** The routing table (confidence band → action). Boundary cases are covered in test/routing.test.ts. */
export function routeByConfidence(confidence: number): Routing {
  if (confidence >= 0.9) return "auto_executed";
  if (confidence >= 0.7) return "executed_flagged_for_review";
  return "queued_for_human";
}

const HARD_GUARDS: HardGuard[] = [
  {
    id: "decline-never-auto",
    reason: "declined payments are never auto-resolvable (policy: Declined Payments)",
    forbidsAutoResolve: ({ issue }) => issue.type === "decline",
  },
  {
    id: "unauthorized-never-auto",
    reason:
      "unauthorized-transaction disputes always require human review (policy: Disputes / Unauthorized)",
    forbidsAutoResolve: ({ issue }) =>
      issue.type === "dispute" && payloadStr(issue, "reason") === "unauthorized",
  },
  {
    id: "dispute-inr-needs-confirmed-delivery",
    // Policy: auto-resolve only when tracking shows delivered (3+ days) AND
    // amount <= $200. We approximate "3+ days since delivery" with a confirmed
    // 'delivered' status; a production system would compare the delivery date.
    reason:
      "item-not-received auto-resolves only with confirmed delivery and amount <= $200 (policy: Disputes / Item Not Received)",
    forbidsAutoResolve: ({ issue, transaction }) => {
      if (issue.type !== "dispute" || payloadStr(issue, "reason") !== "item_not_received") return false;
      const delivered = shippingStatus(transaction) === "delivered";
      const amount = payloadNum(issue, "amount") ?? Infinity;
      return !(delivered && amount <= 200);
    },
  },
  {
    id: "installment-needs-low-risk-and-recent",
    reason:
      "missed installments auto-resolve only when <=3 days overdue and low risk (policy: Missed Installments)",
    forbidsAutoResolve: ({ issue, customer }) => {
      if (issue.type !== "missed_installment") return false;
      const overdue = payloadNum(issue, "days_overdue") ?? Infinity;
      return overdue > 3 || riskScore(customer) !== "low";
    },
  },
  {
    id: "refund-needs-window-and-unshipped",
    reason:
      "changed-mind refunds auto-resolve only within 14 days and before shipping (policy: Refund Requests)",
    forbidsAutoResolve: ({ issue, transaction }) => {
      if (issue.type !== "refund_request") return false;
      const days = payloadNum(issue, "days_since_purchase") ?? Infinity;
      // "When in doubt, escalate": only a confirmed not-yet-shipped state clears this guard.
      const confirmedUnshipped = shippingStatus(transaction) === "not_shipped";
      return days > 14 || !confirmedUnshipped;
    },
  },
];

const RISK_DAMPENERS: RiskDampener[] = [
  {
    id: "high-value-customer",
    reason:
      "high-value customer (lifetime spend > $2000): flagged for review even if auto-resolvable (policy: General Guidelines)",
    applies: ({ customer }) => (lifetimeSpend(customer) ?? 0) > HIGH_VALUE_SPEND_THRESHOLD,
  },
  {
    id: "non-low-risk-customer",
    reason: "customer risk score is not low: extra caution (policy: General Guidelines)",
    applies: ({ customer }) => {
      const risk = riskScore(customer);
      return risk !== undefined && risk !== "low";
    },
  },
];

// --- typed accessors over the loosely-typed payload / reference rows ---

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function payloadNum(issue: Issue, key: string): number | undefined {
  const v = issue.payload[key];
  return typeof v === "number" ? v : undefined;
}

function payloadStr(issue: Issue, key: string): string | undefined {
  const v = issue.payload[key];
  return typeof v === "string" ? v : undefined;
}

function shippingStatus(transaction: Record<string, unknown> | null): string | undefined {
  const shipping = transaction?.["shipping"] as { status?: unknown } | undefined;
  return typeof shipping?.status === "string" ? shipping.status : undefined;
}

function lifetimeSpend(customer: Record<string, unknown> | null): number | undefined {
  const v = customer?.["lifetime_spend"];
  return typeof v === "number" ? v : undefined;
}

function riskScore(customer: Record<string, unknown> | null): string | undefined {
  const v = customer?.["risk_score"];
  return typeof v === "string" ? v : undefined;
}
