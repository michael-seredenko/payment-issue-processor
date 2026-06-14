import { readFileSync } from "node:fs";
import type { IssueRepository } from "./db/repository.js";
import type { IssueType } from "./domain/types.js";

const DATA_DIR = new URL("../data/", import.meta.url);

export function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DATA_DIR), "utf-8")) as T;
}

/**
 * Loads customers + transactions into their reference tables (upserts, so it's
 * idempotent). Reference data has no lifecycle — no reason to go through HTTP.
 * Returns the row counts. Shared by `db:seed` and `demo`.
 */
export function seedReferenceData(repo: IssueRepository): { customers: number; transactions: number } {
  const customers = loadJson<Record<string, unknown>[]>("customers.json");
  for (const c of customers) repo.upsertCustomer(c);

  const transactions = loadJson<(Record<string, unknown> & { id: string })[]>("transactions.json");
  for (const t of transactions) repo.upsertTransaction(t);

  return { customers: customers.length, transactions: transactions.length };
}

export interface RawIssue {
  id: string;
  type: IssueType;
  customer_id: string;
  transaction_id?: string | null;
  [key: string]: unknown;
}

export function loadIssues(): RawIssue[] {
  return loadJson<RawIssue[]>("payment_issues.json");
}

/** Splits a raw issue record into the shape repo.createIssue expects (type-specific fields → payload). */
export function toSubmission(raw: RawIssue): {
  id: string;
  type: IssueType;
  customer_id: string;
  transaction_id: string | null;
  payload: Record<string, unknown>;
} {
  const { id, type, customer_id, transaction_id, ...payload } = raw;
  return { id, type, customer_id, transaction_id: transaction_id ?? null, payload };
}
