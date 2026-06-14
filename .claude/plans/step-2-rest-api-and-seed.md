# Step 2: REST API, seed script, API tests

**Status: ✅ completed** (commits `f08b72c`, `5fb1307`, `65ee0c4`)
**Covers: Part 1.1 (REST API), rest of 1.4 (API tests), Part 1 deliverable (5 issues in via API), Part 2.4 endpoint (human review loop)**

## Goal

Implement the four endpoints over the Step 1 repository, a seed script that
pushes the 5 mock issues through the real ingestion path, and API tests —
completing Part 1 end-to-end (worker picks jobs up; the agent pipeline is
still stubbed and intentionally fails → retries, proving the queue behavior).

## Key decisions

- **`POST /issues`** validates with a zod `looseObject`: known fields are
  typed, type-specific extras (`error_code`, `days_overdue`, …) pass through
  into the JSON `payload` column. Server generates an id when absent; mock
  data ids are accepted as-is.
- **SQLite constraint → HTTP mapping**: duplicate id → 409 (and no second job,
  proven by test); unknown customer/transaction FK → 422. Submission errors
  are distinguishable from server bugs (500).
- **201 + Location**, status starts `pending` — processing is async by design
  (per 1.3: nothing synchronous in the request).
- **`POST /issues/:id/review`**: human decisions are terminal —
  `recommendation ∈ {auto_resolve, escalate}` only; a human picking
  "human_review" isn't a decision, the API rejects it. Verdict vs. the agent
  is computed (same → `agreed`, different → `modified`) with an explicit
  `rejected` override — covering the required agreed/modified/rejected
  tracking. Reviewable states: `awaiting_review`, plus `resolved`/`escalated`
  (flagged auto-executions, human can override); 409 otherwise, 409 if there
  is no agent decision to review.
- **API never touches the queue**: `buildServer(repo)` — enqueueing lives
  inside `createIssue`'s transaction. Router/Server signatures simplified.
- **Seed** upserts customers/transactions directly (reference data, no
  lifecycle) but submits issues via `POST /issues` so the seed exercises
  validation, transactional enqueue, and the history row. Idempotent: 409 →
  skip. Friendly error if the server isn't running.

## Files

| File | Role |
|---|---|
| `src/api/routes/issues.ts` | the four endpoints, zod schemas, error mapping |
| `src/api/server.ts` | `buildServer(repo)` factory for test injection |
| `src/seed.ts` | reference-data upserts + API-driven issue submission |
| `test/api.test.ts` | 14 tests via supertest + in-memory DB |

## Verification (done)

- 24/24 tests green (14 API + 9 queue + 1 routing), typecheck clean.
- Live smoke test: server + seed on a temp DB — all 5 issues accepted (201),
  re-seed skipped on 409, worker claimed and retried each job with backoff
  (`attempts: 4`, `last_error: "not implemented"` from the stubbed pipeline),
  statuses visible via `GET /issues`.
