import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Opens (and migrates) the SQLite database. Pass ":memory:" in tests.
 * better-sqlite3 is synchronous — fine at this scale, and it makes the
 * queue's claim-job transaction trivially race-free within one process.
 */
export function openDatabase(path: string = "issues.db"): Database.Database {
  const db = new Database(path);
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}
