import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IssueRepository } from "../../db/repository.js";
import type { IssueStatus } from "../../domain/types.js";

const submitIssueSchema = z.looseObject({
  id: z.string().optional(), // accept client ids (matches mock data); generate if absent
  type: z.enum(["decline", "missed_installment", "dispute", "refund_request"]),
  customer_id: z.string(),
  transaction_id: z.string().optional(),
}); // type-specific fields (error_code, days_overdue, ...) pass through into payload

const listQuerySchema = z.object({
  status: z
    .enum(["pending", "processing", "awaiting_review", "resolved", "escalated", "failed"])
    .optional(),
});

const reviewSchema = z.object({
  // A human review is a final decision, so 'human_review' is not an option here:
  // the reviewer either executes the resolution or escalates.
  recommendation: z.enum(["auto_resolve", "escalate"]),
  reasoning: z.string().min(1),
  // Verdict vs. the agent is computed (same recommendation => agreed, different
  // => modified); an explicit 'rejected' lets the reviewer record that the
  // agent's call was wrong, not merely different.
  verdict: z.enum(["agreed", "modified", "rejected"]).optional(),
});

/** Issues in these states have an agent decision a human can act on or override. */
const REVIEWABLE_STATUSES: IssueStatus[] = ["awaiting_review", "resolved", "escalated"];

export function issuesRouter(repo: IssueRepository): Router {
  const router = Router();

  // POST /issues — submit a new payment issue; processing is async (status starts 'pending')
  router.post("/", (req, res) => {
    const parsed = submitIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation failed", details: formatZodError(parsed.error) });
    }

    const { id, type, customer_id, transaction_id, ...payload } = parsed.data;
    const issueId = id ?? `iss_${randomUUID()}`;

    try {
      const issue = repo.createIssue({ id: issueId, type, customer_id, transaction_id, payload });
      return res.status(201).location(`/issues/${issue.id}`).json(issue);
    } catch (err) {
      if (isSqliteConstraint(err, "PRIMARYKEY")) {
        return res.status(409).json({ error: `issue ${issueId} already exists` });
      }
      if (isSqliteConstraint(err, "FOREIGNKEY")) {
        return res.status(422).json({ error: "unknown customer_id or transaction_id" });
      }
      throw err;
    }
  });

  // GET /issues — list, with ?status= filter
  router.get("/", (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation failed", details: formatZodError(parsed.error) });
    }
    return res.json(repo.listIssues(parsed.data));
  });

  // GET /issues/:id — issue + status history + decisions
  router.get("/:id", (req, res) => {
    const issue = repo.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: `issue ${req.params.id} not found` });
    return res.json(issue);
  });

  // POST /issues/:id/review — submit human review decision
  router.post("/:id/review", (req, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation failed", details: formatZodError(parsed.error) });
    }

    const issue = repo.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: `issue ${req.params.id} not found` });

    if (!REVIEWABLE_STATUSES.includes(issue.status)) {
      return res.status(409).json({
        error: `issue is '${issue.status}' — only issues awaiting review or already executed (flagged) can be reviewed`,
      });
    }
    if (!issue.decisions.some((d) => d.actor === "agent")) {
      return res.status(409).json({ error: "issue has no agent decision to review" });
    }

    // better-sqlite3 is synchronous, so the record + transition below cannot
    // interleave with another request — effectively atomic within the process.
    const decision = repo.recordHumanReview(issue.id, parsed.data);
    const to: IssueStatus = parsed.data.recommendation === "auto_resolve" ? "resolved" : "escalated";
    repo.transitionStatus(issue.id, to, `human review (${decision.human_verdict}): ${parsed.data.reasoning}`);

    return res.json({ decision, issue: repo.getIssue(issue.id) });
  });

  return router;
}

function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** better-sqlite3 throws SqliteError with codes like SQLITE_CONSTRAINT_PRIMARYKEY. */
function isSqliteConstraint(err: unknown, kind: "PRIMARYKEY" | "FOREIGNKEY"): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === `SQLITE_CONSTRAINT_${kind}`
  );
}
