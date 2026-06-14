-- Payment Issue Processing System — SQLite schema
--
-- Design notes:
-- * issues.payload keeps the type-specific fields (error_code, days_overdue, ...)
--   as JSON; the columns we filter/join on are promoted to real columns.
-- * issue_status_history is append-only — the issues.status column is a
--   denormalized "current" pointer for cheap reads.
-- * decisions records both agent and human decisions in one table; a human
--   decision links back to the agent decision it reviews, which is how we
--   track agreed/modified/rejected.
-- * jobs lives in the same database so enqueue + issue insert commit in one
--   transaction (no dual-write problem). job_key UNIQUE gives idempotent
--   enqueue; lease_expires_at gives crash recovery (visibility timeout).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id                        TEXT PRIMARY KEY,
  email                     TEXT NOT NULL,
  name                      TEXT NOT NULL,
  account_created           TEXT NOT NULL,
  lifetime_transactions     INTEGER NOT NULL,
  lifetime_spend            REAL NOT NULL,
  successful_payments       INTEGER NOT NULL,
  failed_payments           INTEGER NOT NULL,
  disputes_filed            INTEGER NOT NULL,
  disputes_won              INTEGER NOT NULL,
  current_installment_plans INTEGER NOT NULL,
  risk_score                TEXT NOT NULL CHECK (risk_score IN ('low', 'medium', 'high')),
  notes                     TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  merchant    TEXT NOT NULL,
  amount      REAL NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  payload     TEXT NOT NULL  -- full original JSON (installment_plan, shipping, subscription, ...)
);

CREATE TABLE IF NOT EXISTS issues (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('decline', 'missed_installment', 'dispute', 'refund_request')),
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  transaction_id TEXT REFERENCES transactions(id),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'awaiting_review', 'resolved', 'escalated', 'failed')),
  payload        TEXT NOT NULL,  -- full original issue JSON, type-specific fields included
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

CREATE TABLE IF NOT EXISTS issue_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    TEXT NOT NULL REFERENCES issues(id),
  from_status TEXT,              -- NULL on creation
  to_status   TEXT NOT NULL,
  reason      TEXT,              -- e.g. 'agent auto_resolve (confidence 0.94)'
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_history_issue ON issue_status_history(issue_id);

CREATE TABLE IF NOT EXISTS decisions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id              TEXT NOT NULL REFERENCES issues(id),
  actor                 TEXT NOT NULL CHECK (actor IN ('agent', 'human')),
  recommendation        TEXT NOT NULL CHECK (recommendation IN ('auto_resolve', 'human_review', 'escalate')),
  confidence            REAL CHECK (confidence BETWEEN 0 AND 1),  -- agent decisions only
  reasoning             TEXT NOT NULL,
  routing               TEXT CHECK (routing IN ('auto_executed', 'executed_flagged_for_review', 'queued_for_human')),
  reviews_decision_id   INTEGER REFERENCES decisions(id),         -- human decision -> agent decision it reviews
  human_verdict         TEXT CHECK (human_verdict IN ('agreed', 'modified', 'rejected')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_issue ON decisions(issue_id);

CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key          TEXT NOT NULL UNIQUE,  -- 'process-issue:<issue_id>' — idempotent enqueue
  issue_id         TEXT NOT NULL REFERENCES issues(id),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  run_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- backoff scheduling
  lease_expires_at TEXT,                  -- set while running; expired lease => reclaimable after crash
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs(status, run_at);
