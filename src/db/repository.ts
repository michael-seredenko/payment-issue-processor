import type Database from "better-sqlite3";
import type {
  Decision,
  HumanVerdict,
  Issue,
  IssueStatus,
  Recommendation,
  Routing,
  StatusHistoryEntry,
} from "../domain/types.js";

/** Legal status transitions. Same-status transitions are treated as no-ops. */
const ALLOWED_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  pending: ["processing"],
  processing: ["awaiting_review", "resolved", "escalated", "failed"],
  awaiting_review: ["resolved", "escalated"],
  resolved: ["escalated"], // human override of a flagged auto-execution
  escalated: ["resolved"], // human override of a flagged auto-execution
  failed: ["pending"], // manual re-enqueue
};

export class IllegalTransitionError extends Error {
  constructor(issueId: string, from: IssueStatus, to: IssueStatus) {
    super(`illegal status transition for ${issueId}: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

type IssueRow = Omit<Issue, "payload"> & { payload: string };

/**
 * All DB access for issues/decisions/history lives here so the API and the
 * worker share one code path (and one set of invariants).
 */
export class IssueRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert the issue AND its processing job in a single transaction.
   * The UNIQUE job_key makes re-submitting the same issue id a no-op enqueue;
   * a duplicate issue id throws (SQLITE_CONSTRAINT_PRIMARYKEY) for the API
   * layer to map to 409.
   */
  createIssue(issue: {
    id: string;
    type: Issue["type"];
    customer_id: string;
    transaction_id?: string | null;
    payload: Record<string, unknown>;
  }): Issue {
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO issues (id, type, customer_id, transaction_id, payload)
           VALUES (@id, @type, @customer_id, @transaction_id, @payload)`,
        )
        .run({
          id: issue.id,
          type: issue.type,
          customer_id: issue.customer_id,
          transaction_id: issue.transaction_id ?? null,
          payload: JSON.stringify(issue.payload),
        });

      this.db
        .prepare(
          `INSERT INTO issue_status_history (issue_id, from_status, to_status, reason)
           VALUES (?, NULL, 'pending', 'issue submitted')`,
        )
        .run(issue.id);

      this.db
        .prepare(
          `INSERT OR IGNORE INTO jobs (job_key, issue_id) VALUES (?, ?)`,
        )
        .run(`process-issue:${issue.id}`, issue.id);
    });
    create();

    return this.mustGetIssueRow(issue.id);
  }

  getIssue(id: string): (Issue & { history: StatusHistoryEntry[]; decisions: Decision[] }) | null {
    const row = this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as IssueRow | undefined;
    if (!row) return null;

    const history = this.db
      .prepare(`SELECT issue_id, from_status, to_status, reason, created_at
                FROM issue_status_history WHERE issue_id = ? ORDER BY id`)
      .all(id) as StatusHistoryEntry[];

    const decisions = this.db
      .prepare(`SELECT * FROM decisions WHERE issue_id = ? ORDER BY id`)
      .all(id) as Decision[];

    return { ...parseIssue(row), history, decisions };
  }

  listIssues(filter?: { status?: IssueStatus }): Issue[] {
    const rows = (
      filter?.status
        ? this.db.prepare(`SELECT * FROM issues WHERE status = ? ORDER BY created_at`).all(filter.status)
        : this.db.prepare(`SELECT * FROM issues ORDER BY created_at`).all()
    ) as IssueRow[];
    return rows.map(parseIssue);
  }

  /**
   * Single choke point for status changes: updates issues.status and appends
   * to issue_status_history atomically. Transition to the current status is a
   * no-op (this is what makes worker re-runs after a crash safe).
   */
  transitionStatus(issueId: string, to: IssueStatus, reason?: string): void {
    const transition = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT status FROM issues WHERE id = ?`).get(issueId) as
        | { status: IssueStatus }
        | undefined;
      if (!row) throw new Error(`issue ${issueId} not found`);
      const from = row.status;
      if (from === to) return;
      if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new IllegalTransitionError(issueId, from, to);
      }

      this.db
        .prepare(
          `UPDATE issues SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        )
        .run(to, issueId);
      this.db
        .prepare(
          `INSERT INTO issue_status_history (issue_id, from_status, to_status, reason)
           VALUES (?, ?, ?, ?)`,
        )
        .run(issueId, from, to, reason ?? null);
    });
    transition();
  }

  recordAgentDecision(
    issueId: string,
    d: { recommendation: Recommendation; confidence: number; reasoning: string; routing: Routing },
  ): Decision {
    const result = this.db
      .prepare(
        `INSERT INTO decisions (issue_id, actor, recommendation, confidence, reasoning, routing)
         VALUES (?, 'agent', ?, ?, ?, ?)`,
      )
      .run(issueId, d.recommendation, d.confidence, d.reasoning, d.routing);
    return this.mustGetDecision(Number(result.lastInsertRowid));
  }

  /**
   * Records the human decision and computes the verdict vs. the agent's
   * latest recommendation: same recommendation => 'agreed', different =>
   * 'modified'. An explicit verdict (e.g. 'rejected') wins over the computed one.
   */
  recordHumanReview(
    issueId: string,
    d: { recommendation: Recommendation; reasoning: string; verdict?: HumanVerdict },
  ): Decision {
    const agentDecision = this.db
      .prepare(
        `SELECT * FROM decisions WHERE issue_id = ? AND actor = 'agent' ORDER BY id DESC LIMIT 1`,
      )
      .get(issueId) as Decision | undefined;
    if (!agentDecision) {
      throw new Error(`issue ${issueId} has no agent decision to review`);
    }

    const verdict: HumanVerdict =
      d.verdict ?? (d.recommendation === agentDecision.recommendation ? "agreed" : "modified");

    const result = this.db
      .prepare(
        `INSERT INTO decisions (issue_id, actor, recommendation, reasoning, reviews_decision_id, human_verdict)
         VALUES (?, 'human', ?, ?, ?, ?)`,
      )
      .run(issueId, d.recommendation, d.reasoning, agentDecision.id, verdict);
    return this.mustGetDecision(Number(result.lastInsertRowid));
  }

  // --- reference data (seeded from data/*.json) ---

  upsertCustomer(c: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO customers
           (id, email, name, account_created, lifetime_transactions, lifetime_spend,
            successful_payments, failed_payments, disputes_filed, disputes_won,
            current_installment_plans, risk_score, notes)
         VALUES (@id, @email, @name, @account_created, @lifetime_transactions, @lifetime_spend,
                 @successful_payments, @failed_payments, @disputes_filed, @disputes_won,
                 @current_installment_plans, @risk_score, @notes)`,
      )
      .run({ notes: null, ...c });
  }

  upsertTransaction(t: Record<string, unknown> & { id: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO transactions (id, customer_id, merchant, amount, status, created_at, payload)
         VALUES (@id, @customer_id, @merchant, @amount, @status, @created_at, @payload)`,
      )
      .run({
        id: t.id,
        customer_id: t.customer_id,
        merchant: t.merchant,
        amount: t.amount,
        status: t.status,
        created_at: t.created_at,
        payload: JSON.stringify(t),
      });
  }

  getCustomer(id: string): Record<string, unknown> | null {
    const row = this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ?? null;
  }

  getTransaction(id: string): Record<string, unknown> | null {
    const row = this.db.prepare(`SELECT payload FROM transactions WHERE id = ?`).get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
  }

  // --- internals ---

  private mustGetIssueRow(id: string): Issue {
    const row = this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as IssueRow;
    return parseIssue(row);
  }

  private mustGetDecision(id: number): Decision {
    return this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as Decision;
  }
}

function parseIssue(row: IssueRow): Issue {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}
