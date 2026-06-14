# Payment Issue Processing System

A service that processes payment issues. The backend is built to be reliable (a REST API, SQLite, and a job queue that lives inside the database). An AI agent (the Anthropic Agent SDK) reads the policy and decides what to do, and a confidence score decides whether the system acts on its own or asks a human first.

## Quick start

**You need:** Node 20.12 or newer (for `process.loadEnvFile`) and an Anthropic API key with some credits.

```bash
npm install
cp .env.example .env          # put your ANTHROPIC_API_KEY here (AGENT_MODEL defaults to claude-sonnet-4-6)
npm run demo                  # runs the whole thing in one command
```

`npm run demo` is the easy way to see everything. It clears the database, loads the reference data, submits the 5 issues, and then processes them through the real worker and agent. You see the progress for each issue as it happens, and `results.md` is written at the end, once all 5 are done. One command, and it stops by itself:

```
Resetting database…
Seeding reference data… 4 customers, 5 transactions.
Submitting 5 issues…
Processing 5 issues (model: claude-sonnet-4-6):
  iss_001 decline            … analyzing → awaiting_review (human_review @ 0.65)
  iss_002 missed_installment … analyzing → awaiting_review (human_review @ 0.78)
  ...
Done in 143s. Wrote results.md.
```

It uses the same repository, queue, worker, and agent that the service uses. It just runs them in one process, one issue at a time, so you can watch. Run it on its own (stop `npm start` first if it is running, because the demo owns the database file).

### Run it as a live service instead

This runs the real async HTTP API and the human-review loop. Every step is an `npm` script, so there is nothing to hand-write and no extra tools to install.

```bash
# terminal 1 - the service (this blocks, so leave it running):
npm start

# terminal 2 - drive it, one step at a time:
npm run db:seed                       # load reference data (customers + transactions)
npm run submit                        # send the 5 issues to the API; the worker starts processing them
npm run report                        # see how each issue was handled (reads the DB, so it works while the server runs)
curl localhost:3000/issues/iss_004    # or read status straight from the API (GET /issues/:id; GET /issues lists all)
npm run review -- iss_002 escalate    # submit a human decision on an issue that is awaiting_review
npm run report:md                     # write the final report to ./results.md
```

Processing takes a couple of minutes (about 30s per issue). Run `npm run report` again any time to check progress, and pick the id for `review` from its output - any issue in `awaiting_review`. The endpoints are plain HTTP, so curl or Postman work too if you prefer; `jq` is only for pretty-printing and is optional.

### Scripts

| Script | What it does |
|---|---|
| `npm run demo` | Reset, seed, submit, process (with live progress), write `results.md`. All in one. |
| `npm start` | Run the service: REST API on :3000 plus the background worker. |
| `npm run db:seed` | Load reference data (customers, transactions) only. |
| `npm run submit` | Send the 5 issues to a running API. |
| `npm run review -- <id> <auto_resolve\|escalate>` | Submit a human decision for an issue, via the API. |
| `npm run report` / `report:md` | Print the per-issue report (works while the server runs), or write it to `results.md`. |
| `npm run db:reset` | Delete the SQLite files to start fresh. |
| `npm test` / `npm run typecheck` | Run the tests / check the types. |

`results.md` is generated, so it is gitignored. The agent uses `claude-sonnet-4-6` by default. Set `AGENT_MODEL=claude-haiku-4-5` for cheaper runs. The model only suggests an action - the deterministic confidence guards are what keep it safe - so the model choice is about cost and quality of reasoning, not about safety.

## API

| Method | Path                  | Description                                        |
|--------|-----------------------|----------------------------------------------------|
| POST   | `/issues`             | Submit a payment issue (processed asynchronously)  |
| GET    | `/issues`             | List issues, `?status=` filter                     |
| GET    | `/issues/:id`         | Issue + full status history + decisions            |
| POST   | `/issues/:id/review`  | Submit the human decision for a held/flagged issue |

## Architecture overview

```
POST /issues ──▶ [issues + history + jobs]  ── one SQLite transaction
                          │
              Worker polls jobs table (atomic claim + lease)
                          │
                 Agent pipeline (Agent SDK)
                 lookup tools: customer / transaction / policies
                          │
                 AgentAssessment (JSON: recommendation, confidence, reasoning)
                          │
              deriveConfidence() ── agent self-report ∧ deterministic guards
                          │
        ┌─────────────────┼──────────────────────┐
   ≥ 90%: execute    70-89%: execute,       < 70%: hold in
   → resolved/       flag for async         awaiting_review until
     escalated       human review           POST /issues/:id/review
```

**Where the state lives:** everything is in one SQLite file - the issues, the status history (append-only), the decisions (agent and human), and the job queue. Because the queue is in the same database, submitting an issue and adding its job happen in one transaction. So there is no dual-write problem, the job key is UNIQUE so adding it twice is a no-op, and if a worker crashes the lease runs out and the job comes back.

**The model suggests, the system acts.** The agent can only read - its tools are read-only lookups. The actual action (refund, retry, escalate) is plain application code, gated by the confidence router. The model never changes state directly.

## Agent architecture

One investigator agent with three read-only tools (`get_customer_profile`, `get_transaction_details`, `get_resolution_policies`). It is asked to cite the policy parts it used, and it returns structured JSON.

Why one agent and not several? The policy doc is small (about 90 lines), each issue is a single decision, and one agent means one audit record and one place where things can break. A chain of agents (triage, then investigation, then resolution) would add latency (more LLM calls in a row), cost (passing the context again), and more ways to fail, without making the decision any better at this size. The important boundary here is not between agents. It is between the model and the system. See the Agent architecture trade-off below for when splitting would actually help.

### Confidence design

The model's own confidence is not very reliable (LLMs tend to be overconfident). So the score the system uses is `min(agent_self_report, hard_guards, risk_dampeners)`, in [confidence.ts](src/agent/confidence.ts):

- **Hard guards** (cap to 0.30, which sends the issue to a human) only fire on an `auto_resolve` suggestion, because auto-resolving the wrong thing is the only dangerous direction. They encode the "never auto-resolve" rules from the policy: declines, unauthorized disputes, item-not-received without confirmed delivery (and amount over $200), missed installments that are not within 3 days and low risk, and changed-mind refunds that are past 14 days or already shipped.
- **Risk dampeners** (cap to 0.85, which turns a silent auto-execute into flag-for-review) encode the "be careful" guidance: lifetime spend over $2000, and a risk score that is not low. 0.85 is still above 0.70, so escalations still run, just flagged. Only a silent auto-resolve is blocked.

These are caps, not subtractions, so every score is easy to explain. Each cap that fires is written into the issue's status history (the `- capped by …` part), so you can see why an overconfident agent was overruled.

### Handling policy ambiguity

The policy has some parts that are unclear or soft on purpose. For example, insufficient funds says "up to 3 attempts total" but also "escalate when the third retry fails", and those two do not quite agree on what counts as an attempt. And the General Guidelines say to "consider escalating" high-value customers and, in general, "when in doubt, escalate." The system's rule is simple: do not guess. When the facts are missing or contradictory, or the case sits right on a policy line, the agent lowers its confidence (and says why), and the guards and dampeners push borderline cases toward a human instead of a silent action. iss_001 is the clearest example - the "3 attempts" wording is genuinely unclear, so it goes to a human instead of being auto-resolved.

## Results - how the 5 issues were processed

One example run (`claude-sonnet-4-6`, you can reproduce it with `npm run report`). The agent's suggestions change a little between runs, because the LLM is not deterministic:

| Issue | Type | Agent rec | Conf. | Routing | Final status |
|---|---|---|---|---|---|
| iss_001 | decline (insufficient_funds) | human_review | 0.65 | queued_for_human | awaiting_review |
| iss_002 | missed_installment | human_review | 0.78 | executed_flagged_for_review¹ | awaiting_review |
| iss_003 | dispute (item_not_received) | escalate | 0.95 | auto_executed | escalated |
| iss_004 | refund_request (changed_mind) | auto_resolve | 0.95 | auto_executed | resolved |
| iss_005 | decline (card_expired) | escalate | 0.85 | executed_flagged_for_review | escalated |

Why each one ended up where it did, mapped to the policy:

- **iss_001** - insufficient funds can never be auto-resolved. With `auto_retry_count=2`, the "3 attempts total vs third retry" wording is unclear, so the agent lowered its confidence and asked for a human. Good caution.
- **iss_002** - 5 days overdue and medium risk, so it fails the auto-resolve check, but it has not hit the "more than 7 days" escalation line yet. The agent held it for a human. The `non-low-risk` dampener fired too (you can see it in the history).
- **iss_003** - the dispute amount $249 is over $200, which is a hard escalation rule, and the tracking is still `in_transit`. The agent escalated at 0.95, so it ran automatically.
- **iss_004** - inside the 14-day window and `not_shipped`. This is the one case that really can be auto-resolved. Auto-resolved at 0.95.
- **iss_005** - expired card on a recurring subscription, and Taylor Kim is a high-value customer ($4205). The `high-value-customer` dampener capped confidence at 0.85, so it escalated but was flagged for review instead of acting silently.

¹ iss_002's `routing` shows the raw confidence band (0.78, so flagged), but a `human_review` suggestion always goes to `awaiting_review` no matter the band. A confident "this needs a human" still means a human. (iss_005 is different: that is a normal flagged execution, the escalation ran and was flagged for review.) Every cap that fires is recorded in the issue's status history.

## Trade-offs & decisions

### Database schema

**What I traded off.** The storage is a mix. The columns I filter or join on (`status`, `customer_id`, `transaction_id`, `type`) are real columns. The fields that depend on the issue type (`error_code`, `days_overdue`, `shipping`, and so on) are kept as JSON in a `payload` column. This way one `issues` table works for all four issue types, without a pile of columns or four almost-identical tables. The cost is that I cannot index or query inside the payload from SQL. The status history is append-only (`issue_status_history`), and `issues.status` is a copy of the current status so reads are cheap but there is still a full history. Agent and human decisions share one `decisions` table, and a human row points at the agent row it reviews (`reviews_decision_id`). That is how agreed/modified/rejected is tracked. The job queue is in the same database, so the issue insert and its job insert happen in one transaction (no dual-write problem).

**At 10,000 issues/day** (that is about 7 per minute, not a lot, so the agent's speed and cost matter more than the database). I would move to Postgres for real concurrency and proper types (JSONB and a GIN index if I ever need to query inside `payload`). I would move the queue out of the issues database - either `SELECT … FOR UPDATE SKIP LOCKED` with several workers, or a real queue (pg-boss, SQS, Redis Streams) - so queue traffic does not fight with the main tables. `issue_status_history` grows the fastest, so I would partition or archive it by time. The GET endpoints would get read replicas and pagination. The indexes on status and customer are already there.

### Queue design

**Crash in the middle.** A job that is claimed holds a lease (`lease_expires_at`). If the worker dies, the lease runs out and the next `claim()` picks the job up again. So work runs at least once. Because it can run twice, it is made safe to run again: the worker skips issues that already left `processing`, `transitionStatus` does nothing if the status is the same, and decisions are append-only. The one thing that is not idempotent yet is real side effects (an actual refund call). Right now the system only changes status, so re-running is safe. Making side effects idempotent is the first item below.

**AI API down for an hour.** The agent call throws, and `queue.fail` schedules a retry with exponential backoff and jitter (`2s · 2^attempts`). Five attempts cover about an hour, so a one-hour outage is handled without anyone doing anything. The issues just wait in `pending`/`processing` and continue when the API is back. After `max_attempts` the job is marked `dead` and the issue is marked `failed` (a human can re-queue it), so a longer outage parks the batch instead of losing it.

**Why polling and not LISTEN/NOTIFY.** The worker polls once a second. At hundreds or thousands a day this is very cheap and very simple, and a 1-second delay does not matter next to agent runs that take about 30 seconds. LISTEN/NOTIFY, or a queue with a visibility timeout, is worth the extra complexity once many workers compete for jobs or you need sub-second pickup. Neither is true here.

### Agent architecture

I chose one investigator agent (see Agent architecture above). The colleague's idea, "just use a single agent for everything", is actually what I did. So the useful question is the opposite one: when would I split into triage / investigation / resolution agents?

A chain of agents helps when (a) the policy and context together are too big for one context window, so per-area agents keep each prompt small and cheap; (b) different steps need different tool permissions, or different models for cost (a cheap model for triage, an expensive one for investigation); or (c) parts of the work are independent and can run in parallel. None of these are true here. The policy doc is about 90 lines, the decision is one call, and one agent gives one audit record and one place to fail. Splitting would add latency, repeated context cost, and coordination problems between agents, with no gain in quality.

The boundary that really matters is not between agents. It is between the model and the system. "The model suggests, the system acts": the agent can only read, and the action is plain code gated by the confidence router. That is where correctness and safety live, so adding agents would not change the part that matters.

## What I would do differently with more time

In order, most useful first:

1. **A calibration loop.** Feed the human verdicts (agreed/modified/rejected) back into the confidence thresholds and the guard caps, per issue type. Right now they are set by hand, but the human review data is exactly the signal that should tune them.
2. **Idempotent side effects.** When "resolve" becomes a real refund or retry call, it needs an idempotency key so an at-least-once retry cannot refund twice. Today the system only changes status, so this is hidden, but it is the first thing that breaks when the system does real work.
3. **Save policy citations, and make the agent output sturdier.** Store the policy parts the agent cited (right now only the free-text reasoning is saved), and add a retry budget and a few examples so broken JSON is rarer.
4. **Operational tools.** A way to see dead jobs, an endpoint to re-queue them by hand, and some metrics: auto-resolution rate, how often the human agrees with the agent, and cost and latency per decision.
5. **Scaling out.** Move the queue out of SQLite into Postgres or a real queue, run several workers, and add read replicas for reads (see the schema answer).
6. **Hardening the API.** Authentication and authorization, rate limiting, pagination on `GET /issues`, and idempotency keys on `POST /issues`.

## Data notes

The provided mock data is copied into `data/` without changes. Customers and transactions are loaded as reference tables (`db:seed`). The 5 issues go in through the public API (`submit`, or `demo` using the same repository call), so they go through the real path: validation, the transactional enqueue, and the first history row.
