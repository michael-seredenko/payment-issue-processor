import express from "express";
import type { IssueRepository } from "../db/repository.js";
import { issuesRouter } from "./routes/issues.js";

/**
 * Builds the Express app. Exported as a factory so tests can mount it with an
 * in-memory DB. The API never talks to the queue directly: enqueueing happens
 * inside the repository, in the same transaction as the issue insert.
 */
export function buildServer(repo: IssueRepository): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/issues", issuesRouter(repo));
  return app;
}
