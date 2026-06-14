import { config } from "./config.js";

/**
 * Submit a human decision for an issue, against a running API (`npm start`).
 * The endpoint records the verdict (agreed / modified / rejected) versus the
 * agent's recommendation and moves the issue to resolved or escalated.
 *
 * Usage: npm run review -- <issueId> <auto_resolve|escalate> [reasoning...]
 * Example: npm run review -- iss_002 escalate "medium-risk customer, send to a specialist"
 */
const [issueId, recommendation, ...rest] = process.argv.slice(2);
const reasoning = rest.join(" ") || "human review via npm run review";

interface ReviewResponse {
  decision?: { actor: string; recommendation: string; human_verdict: string | null };
  issue?: { status: string };
  error?: string;
}

async function main() {
  if (!issueId || (recommendation !== "auto_resolve" && recommendation !== "escalate")) {
    console.error("Usage: npm run review -- <issueId> <auto_resolve|escalate> [reasoning...]");
    process.exit(1);
  }

  const res = await fetch(`${config.apiBaseUrl}/issues/${issueId}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recommendation, reasoning }),
  }).catch(() => {
    throw new Error(`could not reach ${config.apiBaseUrl} — is the server running? (npm start)`);
  });

  const body = (await res.json()) as ReviewResponse;
  if (!res.ok) {
    throw new Error(`review of ${issueId} failed: ${res.status} ${body.error ?? JSON.stringify(body)}`);
  }

  const d = body.decision!;
  console.log(`✓ ${issueId}: human ${d.recommendation} recorded (verdict: ${d.human_verdict}) → ${body.issue!.status}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
