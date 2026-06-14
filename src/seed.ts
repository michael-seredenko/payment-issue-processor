import { openDatabase } from "./db/database.js";
import { IssueRepository } from "./db/repository.js";
import { seedReferenceData } from "./data.js";
import { config } from "./config.js";

/**
 * Loads reference data (customers + transactions) into the database. Run this
 * before `npm start` + `npm run submit` for the live-service flow; the
 * self-contained `npm run demo` does it for you.
 *
 * Idempotent (upserts). Does NOT submit issues — that's `npm run submit`.
 */
const repo = new IssueRepository(openDatabase(config.dbPath));
const { customers, transactions } = seedReferenceData(repo);
console.log(`Seeded ${customers} customers and ${transactions} transactions into the reference tables.`);
