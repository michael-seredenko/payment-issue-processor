# Step 4: Confidence guards — deterministic hard guards + risk dampeners

**Status: ✅ completed** (commits `e5db4ae`, `95884b2`)
**Covers: Part 2.3 ("Design how you measure/derive confidence. Think about what factors should actually influence it.")**

## Context

Step 3 ships an interim `deriveConfidence` that just clamps the agent's
self-reported confidence. That means an overconfident model can auto-execute a
resolution the policy forbids — e.g. `auto_resolve` on an unauthorized-transaction
dispute (policy: "Auto-resolve: Never"). Step 4 replaces the pass-through with
deterministic checks derived from `data/policies.md` that can only *lower* the
score, so the routing table the brief defines (≥0.90 auto, 0.70–0.89
flagged, <0.70 human) is actually trustworthy. This is the heart of Part 2.3:
confidence is not the LLM's word — it's `min(self_report, policy_guards,
risk_dampeners)`, and every applied cap is auditable.

## Design

`deriveConfidence` becomes the single place that turns an agent recommendation
into a routable score. Signature changes to return the adjustments so the audit
trail can record *why* an overconfident agent was overridden:

```ts
export interface ConfidenceResult {
  confidence: number;
  adjustments: { rule: string; cappedTo: number; reason: string }[];
}
export function deriveConfidence(assessment, issue, repo): ConfidenceResult;
```

Algorithm (caps, not subtractions — explainable):

```
score = clamp(assessment.confidence, 0, 1)
for guard of HARD_GUARDS:    if guard.fires(assessment, issue, ctx) → score = min(score, 0.30)
for damp of RISK_DAMPENERS:  if damp.applies(issue, ctx)           → score = min(score, 0.85)
return { confidence: score, adjustments }   // every applied cap recorded
```

`ctx` = `{ customer, transaction }` looked up once via `repo.getCustomer` /
`repo.getTransaction` (already exist).

### Hard guards (cap → 0.30, i.e. force `queued_for_human`)

Fire **only when `recommendation === "auto_resolve"`** — escalating or holding is
always safe; the dangerous direction is auto-resolving something that shouldn't
be. Each guard encodes a policy clause where auto-resolve is forbidden:

| Guard | Policy clause | Fires when (auto_resolve +) | Mock data |
|---|---|---|---|
| `decline-never-auto` | Declined Payments: both subtypes "Can auto-resolve: No" | `type === "decline"` | iss_001, iss_005 |
| `unauthorized-never-auto` | Disputes / Unauthorized: "Auto-resolve: Never" | `type === "dispute"` && `payload.reason === "unauthorized"` | — |
| `dispute-inr-requires-delivery` | Item Not Received: auto-resolve only if tracking "delivered" 3+ days AND amount ≤ $200 AND not high-value | `type === "dispute"` && reason `item_not_received` && NOT(tracking delivered ≥3d) OR amount > 200 | iss_003 (in_transit, $249) |
| `installment-requires-low-risk` | Missed Installments: auto-resolve only if ≤3 days overdue AND low risk | `type === "missed_installment"` && (`days_overdue > 3` OR `risk_score !== "low"`) | iss_002 (5d, medium) |
| `refund-window-and-unshipped` | Changed Mind: auto-resolve only within 14 days AND not yet shipped | `type === "refund_request"` && (`days_since_purchase > 14` OR transaction shipped) | iss_004 does NOT fire (3d, not_shipped) |

iss_004 is the one legitimately auto-resolvable case in the mock set — it must
pass all guards. Use it as the negative control in tests.

### Risk dampeners (cap → 0.85, i.e. demote `auto_executed` → `executed_flagged_for_review`)

Apply regardless of recommendation (0.85 ≥ 0.70, so escalations still execute,
just flagged). These encode the policy's "extra care" guidance — they never
block, they just deny *silent* auto-execution so a human sees it async:

| Dampener | Policy clause | Applies when |
|---|---|---|
| `high-value-customer` | General: "High-value customers get extra care … consider escalating even if auto-resolvable" (lifetime spend > $2000) | `customer.lifetime_spend > 2000` (e.g. cust_315 @ $4205) |
| `non-low-risk` | "When in doubt, escalate"; risk signal | `customer.risk_score !== "low"` (e.g. cust_108 medium) |

### Threading the adjustments through

- `finalizeDecision` (pipeline.ts) calls `deriveConfidence`, uses
  `.confidence` for routing + the recorded decision, and passes a one-line
  summary of `.adjustments` into `applyAssessment`'s history `reason`, e.g.:
  `agent auto_resolve (confidence 0.30, queued_for_human) — capped by guard
  unauthorized-never-auto`.
- Agent `reasoning` stays pure (the model's words); the cap explanation lives in
  the status-history reason, where the confidence + routing already are.

## Files

| File | Change |
|---|---|
| `src/agent/confidence.ts` | implement guards + dampeners; return `ConfidenceResult` |
| `src/agent/pipeline.ts` | `finalizeDecision` consumes `.confidence` + folds `.adjustments` into the history reason |
| `src/domain/types.ts` | add `ConfidenceResult` / adjustment type (or co-locate in confidence.ts) |
| `test/routing.test.ts` | implement the 3 existing `todo`s + per-guard coverage |

## Tests (pure — no API key, no SDK)

`deriveConfidence` takes `(assessment, issue, repo)` and is synchronous; tests
build an in-memory repo, seed a customer/transaction, create an issue, then
assert. Fill the three existing todos and add per-type guard coverage:

1. **never-auto-resolvable** (existing todo): `auto_resolve` on a `decline`
   (and on an unauthorized dispute) → confidence ≤ 0.30 → `queued_for_human`.
2. **high-value customer** (existing todo): `auto_resolve` @ 0.95 for a
   customer with lifetime_spend $4205 → capped to 0.85 →
   `executed_flagged_for_review` (not silent auto-execute).
3. **overconfident agent still routed to human** (existing todo): guard fires at
   self-report 0.99 → still ≤ 0.30 → `queued_for_human`.
4. guards target auto_resolve only: `escalate` @ 0.95 on a never-auto decline
   is NOT capped → stays `auto_executed`.
5. negative control: iss_004-shaped refund (within 14 days, not shipped, low
   risk, < $2000) with `auto_resolve` @ 0.92 → no cap → `auto_executed`.
6. dispute item_not_received with in-transit tracking + $249 → guard fires.

## Verification

- `npm run typecheck` && `npm test` (3 todos become passing; suite ~35 green).
- Sanity-map against the 5 mock issues (no API key needed) by calling
  `deriveConfidence` with a plausible recommendation per issue and confirming the
  routing matches policy intent — feeds the README per-issue table (Step 5):
  - iss_001 decline/insufficient_funds → auto_resolve blocked → human
  - iss_002 missed_installment 5d/medium → auto_resolve blocked → human
  - iss_003 dispute INR in-transit $249 → auto_resolve blocked → human/escalate
  - iss_004 refund 3d not-shipped low-risk → auto_resolve allowed → auto/flagged
  - iss_005 decline/card_expired (recurring) → auto_resolve blocked → human

## Out of scope (→ Step 5)

README prose (Part 3.2 trade-offs, Part 3.3 prioritized list) and the final
per-issue results table produced from a live agent run.
