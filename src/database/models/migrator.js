import path from "node:path";
import { db } from "./db.js";

const MIGRATIONS_DIR = path.resolve("src/database/migrations");

export async function migrateLatest() {
  const [batch, files] = await db.migrate.latest({
    directory: MIGRATIONS_DIR,
    tableName: "_migrations",
  });
  return { batch, files };
}

export async function migrateRollback({ all = false } = {}) {
  if (all) {
    const out = [];
    while (true) {
      const [batch, files] = await db.migrate.rollback(
        { directory: MIGRATIONS_DIR, tableName: "_migrations" },
        true
      );
      if (!files || files.length === 0) break;
      out.push({ batch, files });
    }
    return out;
  } else {
    const [batch, files] = await db.migrate.rollback(
      { directory: MIGRATIONS_DIR, tableName: "_migrations" },
      false
    );
    return { batch, files };
  }
}

export async function migrationStatus() {
  const [completed, pending] = await db.migrate.list({
    directory: MIGRATIONS_DIR,
    tableName: "_migrations",
  });
  return {
    completed,
    pending: pending.map((f) => path.basename(f.file)),
  };
}

export async function makeMigration(name) {
  if (!name) throw new Error("Migration name is required");
  const file = await db.migrate.make(name, {
    directory: MIGRATIONS_DIR,
    extension: "js",
  });
  return file;
}
