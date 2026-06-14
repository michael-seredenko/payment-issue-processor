import type Database from "better-sqlite3";
import { openDatabase } from "./db/database.js";
import { IssueRepository } from "./db/repository.js";
import { JobQueue } from "./queue/queue.js";
import { Worker } from "./queue/worker.js";
import { processIssueWithAgent } from "./agent/pipeline.js";
import { config } from "./config.js";

export interface App {
  db: Database.Database;
  repo: IssueRepository;
  queue: JobQueue;
  worker: Worker;
}

/**
 * Composition root: open the database and wire the repository, queue, and worker
 * (with the agent pipeline as the worker's unit of work). The service
 * (src/index.ts) and the demo (src/demo.ts) both build their components here, so
 * the wiring — including how a claimed job maps to an agent run — lives in
 * exactly one place.
 */
export function createApp(dbPath: string = config.dbPath): App {
  const db = openDatabase(dbPath);
  const repo = new IssueRepository(db);
  const queue = new JobQueue(db);
  const worker = new Worker(queue, repo, async (issueId) => {
    const issue = repo.getIssue(issueId);
    if (!issue) throw new Error(`issue ${issueId} not found`);
    await processIssueWithAgent(repo, issue);
  });
  return { db, repo, queue, worker };
}
