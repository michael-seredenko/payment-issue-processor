import { rmSync, writeFileSync } from "node:fs";
import { renderReport } from "./report.js";
import { seedReferenceData, loadIssues, toSubmission } from "./data.js";
import { config, requireAnthropicApiKey } from "./config.js";
import { createApp } from "./app.js";

/**
 * End-to-end demo in one transparent, self-terminating command:
 *   reset → seed reference data → submit the issues → process them with live
 *   per-issue progress → write results.md when everything is done.
 *
 * It builds the SAME components the service uses (src/app.ts → createApp) and
 * drives them sequentially in one process so the progress is observable. The
 * async API + background-worker design is unchanged; see `npm start` +
 * `npm run submit` for the live HTTP path.
 *
 * Run it on its own (stop any `npm start` first — it owns the database file).
 */
const OUT = "results.md";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  requireAnthropicApiKey();

  // 1. Reset, so every run starts clean and repeatable.
  console.log("Resetting database…");
  for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(f, { force: true });

  const { db, repo, queue, worker } = createApp();

  // 2. Reference data.
  const { customers, transactions } = seedReferenceData(repo);
  console.log(`Seeding reference data… ${customers} customers, ${transactions} transactions.`);

  // 3. Submit the issues (each insert enqueues a job in the same transaction).
  const issues = loadIssues();
  console.log(`Submitting ${issues.length} issues…`);
  for (const raw of issues) repo.createIssue(toSubmission(raw));

  // 4. Process with live progress — the real worker + pipeline.
  console.log(`Processing ${issues.length} issues (model: ${config.agentModel}):`);
  const t0 = Date.now();
  while (true) {
    const job = queue.claim();
    if (job) {
      const before = repo.getIssue(job.issue_id)!;
      process.stdout.write(`  ${job.issue_id} ${before.type.padEnd(18)} … analyzing`);
      await worker.runJob(job);
      const after = repo.getIssue(job.issue_id)!;
      const agent = [...after.decisions].reverse().find((d) => d.actor === "agent");
      const detail = agent ? `${agent.recommendation} @ ${agent.confidence?.toFixed(2)}` : "no decision";
      process.stdout.write(` → ${after.status} (${detail})\n`);
      continue;
    }
    // No job due right now: if any are scheduled for a backoff retry, wait for them.
    const pending = (
      db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'running')`).get() as { n: number }
    ).n;
    if (pending === 0) break;
    await sleep(2000);
  }

  // 5. Write the doc, only now that everything is done.
  writeFileSync(OUT, renderReport(repo) + "\n");
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Wrote ${OUT} — open it or run \`npm run report\`.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
