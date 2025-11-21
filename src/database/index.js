
import { db, getDb } from "./models/db.js";
import { migrateLatest } from "./models/migrator.js";

export { db, getDb };

export async function initDatabase() {
  
  await db.raw("select 1 as ok");
}

export async function runMigrations() {
  await migrateLatest();
}


export { syncAdminFromEnv } from "../utils/adminSeed.js";

