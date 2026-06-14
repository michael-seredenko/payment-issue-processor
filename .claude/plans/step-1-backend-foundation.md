# Step 1: Backend foundation — repository, queue, worker

**Status: ✅ completed** (commits `98278cb`, `0af24de`, `851d77a`, `ec40723`, `1dc8268`)
**Covers: Part 1.2 (database), 1.3 (background processing), half of 1.4 (queue tests)**

## Goal

Build the reliability core everything else sits on: SQLite schema, the issue
repository, a DB-backed job queue with retry/backoff/crash-recovery, and the
worker loop — with real tests for the queue guarantees the brief names
(retries with backoff, idempotency, stop/restart without losing work).

## Key decisions

- **Queue in the same SQLite DB as the issues.** Issue INSERT + job enqueue
  commit in one transaction — no dual-write inconsistency. At this scale a
  separate broker buys nothing; at 10k/day the answer is Postgres + pg-boss
  (documented in README trade-offs).
- **Idempotent enqueue** via `UNIQUE(job_key)` (`process-issue:<issue_id>`) +
  `INSERT OR IGNORE` — submitting the same issue twice creates one job.
- **Atomic claim**: single `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING`,
  so two pollers can never win the same row (better-sqlite3 is synchronous,
  which makes this trivially race-free in-process).
- **Crash recovery by lease** (`lease_expires_at`): a worker that dies mid-job
  leaves an expired lease; the next `claim()` reclaims the job. At-least-once
  semantics — therefore processing must be re-run-safe.
- **Re-run safety**: `transitionStatus` is the single choke point, validates
  against an `ALLOWED_TRANSITIONS` table, and treats same-status transitions
  as no-ops — so a reclaimed job repeating `pending → processing` is harmless
  and produces no duplicate history rows.
- **Backoff + dead-letter**: `run_at = now + 2s · 2^attempts + jitter`; after
  `max_attempts` (5) the job goes `dead` and the worker marks the issue
  `failed` with the error in the history reason.
- **Append-only `issue_status_history`**; `issues.status` is a denormalized
  current pointer for cheap reads.
- **Testability**: `claim()`/`fail()` take an injectable `now`; `Worker.runJob`
  is public so tests drive it without the poll loop; `openDatabase(":memory:")`
  for isolated tests.

## Files

| File | Role |
|---|---|
| `src/db/schema.sql` | customers, transactions, issues, history, decisions, jobs |
| `src/db/database.ts` | open + migrate; `":memory:"` for tests |
| `src/db/repository.ts` | createIssue (txn: issue+history+job), transitionStatus, decisions |
| `src/queue/queue.ts` | enqueue / claim / complete / fail |
| `src/queue/worker.ts` | poll loop, runJob, final-failure handling |
| `src/domain/types.ts` | Issue, Job, Decision, AgentAssessment, enums |
| `test/queue.test.ts` | 9 tests (below) |

## Verification (done)

- `tsc --noEmit` clean.
- 9/9 queue tests: idempotent enqueue, claim marks running+lease, no double
  claim, backoff retry scheduling, dead-letter after max attempts, expired
  lease reclaim, worker completes job, issue `failed` + history on final
  attempt, crash re-run yields exactly one `processing` history entry.
