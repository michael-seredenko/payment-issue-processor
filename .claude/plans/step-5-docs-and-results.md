# Step 5: Documentation prose + per-issue results

**Status: ✅ completed**

> Execution note: the planned `outputFormat`/`structured_output` path is not
> populated by this SDK/CLI version — the live smoke returned the answer as text
> in `result`. Switched to a strict JSON-only system prompt + parsing `result`
> with the same zod schema. The live run also surfaced a real bug the unit tests
> couldn't: the agent prompt omitted `customer_id`/`transaction_id`, so the
> lookup tools had no IDs to use — fixed. Live run done on `claude-sonnet-4-6`.
**Covers: Part 3 (Documentation, 15%) + the Part 2 deliverable "output showing how each of the 5 issues was processed (recommendation, confidence, routing)"**

## Context

The system is built and tested (steps 1–4, 35 tests green). Two graded
deliverables remain and they're both about *communicating* the work, not new
machinery: the Part 3 written answers (trade-offs, what I'd do differently) and
a per-issue results table proving the pipeline runs end-to-end. The design
decisions already exist in code and the earlier plan docs — this step writes
them up honestly and produces the results table from a live agent run. The
rubric weights "clear reasoning, honest trade-offs, good prioritization" here,
so substance and candor matter more than length.

One dependency: the results table needs a live run, which needs
`ANTHROPIC_API_KEY`. The reproducible tooling is built and tested without a key;
populating the table requires the key (contingency below).

## Part A — Results tooling + live run

### A1. `src/report.ts` + `npm run report` (new)

A small, reproducible reporter so "how each issue was processed" isn't a manual
curl exercise. Reads the DB directly (no key needed to *run* it — it just
formats whatever state exists) and prints a markdown table:

| Issue | Type | Agent rec | Confidence | Routing | Final status | Caps fired |
|---|---|---|---|---|---|---|

Plus, per issue, the agent's `reasoning` and `policy_citations` and any human
review verdict. Implementation: open `openDatabase()`, `repo.listIssues()`, and
for each issue pull its latest agent decision + human decision from
`repo.getIssue(id)` (already returns `decisions` + `history`). Derive "caps
fired" from the matching status-history reason (the `— capped by …` suffix
applyAssessment writes). Pure formatting over existing repository reads.

Add to `package.json`: `"report": "tsx src/report.ts"`.

### A2. Live run procedure (needs API key)

```bash
cp .env.example .env          # set ANTHROPIC_API_KEY (AGENT_MODEL optional; defaults to claude-opus-4-8)
npm start                     # API + worker
npm run seed                  # submit the 5 issues
# worker processes them through the real agent; then:
npm run report                # capture the table + reasoning
```

Capture the output into README §Results.

### A3. Contingency if no key is available

Build + test the report script regardless. If the live run can't be done in this
session, populate README §Results from the **deterministic guard preview**
already verified in step 4 (each issue fed a stress-case `auto_resolve` @ 0.95):
iss_001/002/003/005 → `queued_for_human` (guards fire), iss_004 → `auto_executed`.
Mark the table clearly as "guard preview (deterministic), pending live agent
run" so it's honest, and leave a one-line note that the live recommendations
come from the agent's own judgment, not a forced auto_resolve.

## Part B — README prose (fill every TODO)

Substance is already decided (code + plan docs); writing only. Each Part 3.2
answer is 2–3 paragraphs as the brief asks.

1. **§agent-architecture expand TODO** + **Part 3.2 Q3 (agent architecture)** —
   single investigator agent with read-only lookup tools. Why: the policy doc is
   small enough for one context, the decision is a single judgment call, and one
   agent = one audit record. The colleague's "just use a single agent" is in
   fact what we chose — so answer the inverse honestly: when *would* we split?
   Per-domain policy corpora too large for one context window; distinct tool
   permissions per phase; parallel fan-out of independent sub-questions;
   different models per role for cost. None apply at 5 issue types / one small
   policy file. Reinforce "the model recommends; the system acts" (tools are
   read-only; execution is deterministic code gated by the confidence router).

2. **Part 3.2 Q1 (database schema)** — trade-offs: hybrid storage (queryable
   columns promoted, type-specific fields kept as JSON `payload` so one schema
   serves all four issue types); append-only `issue_status_history` with a
   denormalized `issues.status` pointer for cheap reads; one `decisions` table
   for both actors with a self-reference linking a human review to the agent
   decision it judges; queue-in-DB for transactional enqueue. At 10k/day: move
   to Postgres; lift the queue out of the table into a real broker
   (pg-boss/SQS/Redis); partition or archive history; add read replicas for the
   GET endpoints; JSONB + GIN if we start querying inside `payload`.

3. **Part 3.2 Q2 (queue design)** — crash mid-processing: the lease expires and
   the job is reclaimed (at-least-once); the worker's idempotency guard skips
   issues that already left `processing`, the same-status transition is a no-op,
   and decisions are append-only, so a re-run is safe. AI API down for an hour:
   the agent call throws → `queue.fail` schedules an exponential backoff + jitter
   retry → after `max_attempts` (5) the job goes `dead` and the issue is marked
   `failed` (re-enqueueable); nothing is lost, issues simply stay
   pending/processing meanwhile. Note why polling beats LISTEN/NOTIFY at this
   scale and when that flips.

4. **Part 3.3 (what I'd do differently, prioritized)** — 1) calibration loop:
   feed human verdicts (agreed/modified/rejected) back to tune confidence
   thresholds per issue type; 2) idempotent execution side-effects (real
   refund/retry calls need idempotency keys — today we only transition status);
   3) stricter agent output handling (few-shot, structured-output retry budget);
   4) dead-letter visibility + manual requeue endpoint and ops metrics
   (auto-resolution rate, agent↔human agreement); 5) observability
   (per-decision tracing, cost/latency); 6) scale-out: queue out of SQLite,
   multiple workers, Postgres; 7) API hardening: authN/Z, rate limiting,
   pagination on `GET /issues`.

5. **§confidence accuracy pass** — the section already describes guards +
   dampeners; reconcile it with the implemented rule IDs and the
   "caps recorded in status history" detail so the prose matches the code.

6. **§Results (new)** — insert the table from A2/A3 + a short narrative on why
   each issue routed the way it did (ties the run back to the policies).

## Files

| File | Change |
|---|---|
| `src/report.ts` | new — DB → markdown results table + per-issue detail |
| `package.json` | add `report` script |
| `README.md` | fill all Part 3.2/3.3 TODOs, agent-architecture expansion, confidence accuracy pass, new §Results |
| `test/report.test.ts` | new (light) — formatting over a seeded in-memory DB, no key |
| `.env.example` | optional: note `AGENT_MODEL` |

## Verification

- `npm run typecheck` && `npm test` stay green (report test added).
- `npm run report` against a seeded DB prints a well-formed table.
- With a key: live run populates §Results with real agent recommendations,
  confidence, routing, and reasoning; without one, §Results carries the labeled
  deterministic guard preview pending the live run.
- README has no remaining `TODO` markers; all four Part 3 questions answered.

## Out of scope

Anything in the Part 3.3 list itself (that's the "with more time" backlog, not
this step). Commit-trailer cleanup is a separate housekeeping task.
