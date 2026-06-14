import { loadIssues } from "./data.js";
import { config } from "./config.js";

/**
 * Submits the 5 issues to a running API (`npm start`) via POST /issues — the
 * real ingestion path (validation, transactional enqueue, history row). The
 * worker then processes them in the background.
 *
 * Idempotent: re-submitting an existing issue id returns 409 and is skipped.
 * Usage: `npm start` in one terminal, then `npm run submit`.
 */
const BASE = config.apiBaseUrl;

async function main() {
  const issues = loadIssues();
  console.log(`Submitting ${issues.length} issues to ${BASE} …`);

  for (const issue of issues) {
    const res = await fetch(`${BASE}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issue),
    }).catch(() => {
      throw new Error(`could not reach ${BASE} — is the server running? (npm start)`);
    });

    const body = (await res.json()) as { status?: string; error?: string };
    if (res.status === 201) {
      console.log(`✓ ${issue.id} submitted (status: ${body.status})`);
    } else if (res.status === 409) {
      console.log(`- ${issue.id} already submitted, skipping`);
    } else {
      throw new Error(`POST /issues for ${issue.id} failed: ${res.status} ${JSON.stringify(body)}`);
    }
  }

  console.log("Submitted. The worker is processing them — watch with: curl -s localhost:3000/issues | jq");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
