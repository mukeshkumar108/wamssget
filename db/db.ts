// db/db.ts
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

// ensure `data/` dir exists (persistent volume)
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "app.sqlite");

// open SQLite database
const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite, { schema });

// ✅ get the instance type of the Database constructor
type BetterSqlite3Instance = InstanceType<typeof Database>;

function ensureIndexes(sql: BetterSqlite3Instance) {
  sql.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_chat_ts   ON messages (chat_id, ts)`).run();
  sql.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_sender_ts ON messages (sender_id, ts)`).run();
}

// run migrations, then ensure indexes
export function initDb() {
  migrate(db, { migrationsFolder: "drizzle/migrations" });
  ensureIndexes(sqlite);
  console.log("✅ Database migrated & indexes ensured");
}

export { sqlite };
