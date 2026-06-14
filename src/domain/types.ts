export type IssueType = "decline" | "missed_installment" | "dispute" | "refund_request";

export type IssueStatus =
  | "pending" // accepted, queued for processing
  | "processing" // worker picked it up, agent running
  | "awaiting_review" // agent confidence < 70% — held for human decision
  | "resolved" // terminal: action executed
  | "escalated" // terminal: handed to specialist team
  | "failed"; // terminal: processing failed after all retries

export type Recommendation = "auto_resolve" | "human_review" | "escalate";

export type Routing =
  | "auto_executed" // confidence >= 0.90
  | "executed_flagged_for_review" // 0.70 - 0.89
  | "queued_for_human"; // < 0.70

export type HumanVerdict = "agreed" | "modified" | "rejected";

export interface Issue {
  id: string;
  type: IssueType;
  customer_id: string;
  transaction_id: string | null;
  status: IssueStatus;
  /** Type-specific fields from the original submission (error_code, days_overdue, ...). */
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface StatusHistoryEntry {
  issue_id: string;
  from_status: IssueStatus | null;
  to_status: IssueStatus;
  reason: string | null;
  created_at: string;
}

export interface Decision {
  id: number;
  issue_id: string;
  actor: "agent" | "human";
  recommendation: Recommendation;
  confidence: number | null;
  reasoning: string;
  routing: Routing | null;
  reviews_decision_id: number | null;
  human_verdict: HumanVerdict | null;
  created_at: string;
}

export interface Job {
  id: number;
  job_key: string;
  issue_id: string;
  status: "pending" | "running" | "done" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  run_at: string;
  lease_expires_at: string | null;
  last_error: string | null;
}

/** Structured output the agent must produce for every issue. */
export interface AgentAssessment {
  recommendation: Recommendation;
  /** Agent's self-reported confidence, 0-1. Blended with deterministic checks — see confidence.ts. */
  confidence: number;
  reasoning: string;
  /** Policy clauses the agent relied on, for auditability. */
  policy_citations: string[];
}
