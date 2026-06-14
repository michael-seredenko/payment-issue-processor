# Step 3: Agent pipeline — run the agent, execute the routing

**Status: 📋 planned**
**Covers: Part 2.1/2.2 (agent built + integrated), executes Part 2.3's routing table (deriveConfidence guards land in Step 4)**

## Goal

Implement `runAgent()` and routing execution in `src/agent/pipeline.ts` so the
5 issues actually reach terminal states end-to-end. Step 4 will replace the
interim confidence pass-through with hard guards + risk dampeners.

## Design

Verified against the installed packages (not just type surface): `z.toJSONSchema`
exists in zod 4.4.3; the SDK forwards `outputFormat` to the CLI as `--json-schema`
and the bundled `claude` binary has real `structured_output` support; `tools: []`
+ `allowedTools` (MCP names) is the correct lockdown; Node 24 has
`process.loadEnvFile`.

### 1. Structured output instead of JSON string parsing

The SDK supports `outputFormat: { type: 'json_schema', schema }` and returns
`structured_output` on the `subtype: 'success'` result message. Define one zod
schema (`assessmentSchema`) mirroring `AgentAssessment`:

- `recommendation: z.enum(["auto_resolve", "human_review", "escalate"])`
- `confidence: z.number().min(0).max(1)`
- `reasoning: z.string().min(1)`
- `policy_citations: z.array(z.string())`

Use it twice — `z.toJSONSchema(assessmentSchema)` for the SDK's `outputFormat`,
and `assessmentSchema.parse(structured_output)` to validate what comes back.
Single source of truth; no markdown-fence stripping, no prompt-and-pray JSON.

### 2. `runAgent(repo, issue)` — the query() loop

```ts
const result = query({
  prompt,                                   // issue type + payload as JSON
  options: {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: { "payment-context": buildAgentTools(repo) },
    tools: [],                              // disable ALL built-in tools (no fs/bash)
    allowedTools: [
      "mcp__payment-context__get_customer_profile",
      "mcp__payment-context__get_transaction_details",
      "mcp__payment-context__get_resolution_policies",
    ],
    maxTurns: 12,
    model: process.env.AGENT_MODEL ?? "claude-opus-4-8",
    outputFormat: { type: "json_schema", schema: z.toJSONSchema(assessmentSchema) },
  },
});
for await (const message of result) { /* collect type === "result" */ }
```

- success → `assessmentSchema.parse(message.structured_output)`.
- non-success subtypes (`error_max_turns`, `error_during_execution`, …) or
  invalid structured output → **throw**. The Step 1 queue already owns retry,
  backoff, and dead-lettering — the pipeline adds no retry logic of its own.
  This is the "AI API down for an hour" answer: jobs fail,
  back off, retry, and nothing is lost.

### 3. Routing execution — `applyAssessment(repo, issue, assessment)`

Exported separately from `runAgent` so tests can drive it with fake
assessments (no API key, no SDK).

| Condition | Transition | Note |
|---|---|---|
| recommendation = `human_review` (any confidence) | → `awaiting_review` | a confident "needs a human" still means a human |
| routing = `queued_for_human` (< 0.70) | → `awaiting_review` | no action before review |
| routing = `auto_executed` / `executed_flagged_for_review` | → `resolved` (auto_resolve) or `escalated` (escalate) | flagged ones stay reviewable via existing `POST /:id/review` |

History reason carries the audit trail:
`agent auto_resolve (confidence 0.94, auto_executed)`.

`processIssueWithAgent` = `runAgent` → `deriveConfidence` → `recordAgentDecision`
→ `applyAssessment`. Re-run note (at-least-once queue): a crash between
recording the decision and the transition re-runs the agent and appends a
second decision row — acceptable; decisions are an append-only audit log.

### 4. Supporting changes

- `src/agent/confidence.ts`: interim `deriveConfidence` = clamp(agent
  self-report, 0, 1). Hard guards + risk dampeners are Step 4.
- `src/index.ts`: nothing loads `.env` today — add `process.loadEnvFile?.()`
  in a try/catch so `ANTHROPIC_API_KEY` works as the README promises.
- **`src/queue/worker.ts` — crash-recovery idempotency (required by this step).**
  Once `applyAssessment` reaches terminal states, the worker's unconditional
  `transitionStatus(processing)` becomes unsafe on reclaim: a job that finished
  the work but crashed before `complete()` would hit `resolved → processing`
  (illegal) and throw, and the final-attempt `→ failed` transition would throw
  too. Fix: at the top of `runJob`, if the issue already left `processing`
  (resolved/escalated/awaiting_review/failed), the prior attempt did the work —
  just `complete()` the job and return. This is the Part 1.3 "restart without
  losing work" guarantee, only now actually exercised.

## Files

| File | Change |
|---|---|
| `src/agent/pipeline.ts` | implement `runAgent` + `applyAssessment` |
| `src/agent/confidence.ts` | interim pass-through `deriveConfidence` |
| `src/index.ts` | `.env` loading |
| `test/pipeline.test.ts` | new — routing execution tests |

## Tests (no API key needed)

Fake assessments into `applyAssessment` against an in-memory DB:

1. confidence 0.95 + `auto_resolve` → issue `resolved`, decision routing
   `auto_executed`, history reason includes confidence
2. confidence 0.80 + `escalate` → issue `escalated`, routing
   `executed_flagged_for_review`, then `POST /:id/review` can still override
3. confidence 0.50 → `awaiting_review`, no terminal transition
4. edge case: confidence 0.95 + `human_review` → `awaiting_review` (the
   routing table alone would auto-execute; the recommendation must win)

## Verification

- `npm run typecheck` && `npm test` (expect 28+ green).
- Live: `npm run dev` + `npm run seed` with `ANTHROPIC_API_KEY` set — watch
  the 5 issues reach terminal states via `GET /issues`; capture per-issue
  recommendation/confidence/routing for the README results table (Step 5).
