import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./db/database.js";
import { IssueRepository } from "./db/repository.js";
import { config } from "./config.js";

/**
 * Renders a markdown summary of how every issue was processed — the Part 2
 * deliverable ("output showing how each of the 5 issues was processed:
 * recommendation, confidence, routing"). Pure over repository reads so it can
 * be unit-tested; the script entry point below just prints it.
 */
export function renderReport(repo: IssueRepository): string {
  const out: string[] = [];

  out.push("# Payment Issue Processing — Results");
  out.push("");
  out.push(
    "How each issue was processed end to end: agent recommendation, confidence " +
      "(after the deterministic guards), routing, and final status.",
  );
  out.push("");
  out.push("| Issue | Type | Agent rec | Conf. | Routing | Final status | Human verdict |");
  out.push("|---|---|---|---|---|---|---|");
  for (const summary of repo.listIssues()) {
    const issue = repo.getIssue(summary.id)!;
    const agent = issue.decisions.find((d) => d.actor === "agent");
    const human = issue.decisions.find((d) => d.actor === "human");
    const conf = agent?.confidence != null ? agent.confidence.toFixed(2) : "—";
    out.push(
      `| ${issue.id} | ${issue.type} | ${agent?.recommendation ?? "—"} | ${conf} | ` +
        `${agent?.routing ?? "—"} | ${issue.status} | ${human?.human_verdict ?? "—"} |`,
    );
  }

  out.push("");
  out.push("### Reasoning per issue");
  for (const summary of repo.listIssues()) {
    const issue = repo.getIssue(summary.id)!;
    const agent = issue.decisions.find((d) => d.actor === "agent");
    out.push("");
    out.push(`**${issue.id}** (${issue.type}) → ${issue.status}`);
    if (!agent) {
      out.push("- No agent decision recorded (still pending or failed).");
      continue;
    }
    out.push(`- Agent: ${agent.recommendation} @ ${agent.confidence?.toFixed(2)} → ${agent.routing}`);
    out.push(`- Reasoning: ${agent.reasoning}`);
    const capReason = issue.history.find((h) => h.reason?.includes("— capped by"))?.reason;
    if (capReason) {
      out.push(`- Confidence caps applied: ${capReason.split("— capped by")[1]!.trim()}`);
    }
  }

  return out.join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const report = renderReport(new IssueRepository(openDatabase(config.dbPath)));

  // `--out <file>` writes the markdown to a file (a shareable doc); otherwise
  // it prints to stdout. `npm run report:md` uses --out results.md.
  const outIdx = process.argv.indexOf("--out");
  const outFile = outIdx !== -1 ? process.argv[outIdx + 1] : undefined;
  if (outFile) {
    writeFileSync(outFile, report + "\n");
    console.log(`Wrote report to ${outFile}`);
  } else {
    console.log(report);
  }
}
