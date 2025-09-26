// db/db.ts
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

// ensure `out/` dir exists
const OUT_DIR = path.join(process.cwd(), "out");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const DB_PATH = path.join(OUT_DIR, "messages.db");

// open SQLite database
const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite, { schema });

// run migrations
export function initDb() {
  migrate(db, { migrationsFolder: "drizzle/migrations" });
  console.log("✅ Database migrated");
}
