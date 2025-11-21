import path from "node:path";
import fs from "node:fs";
import createDb from "knex";
import { config } from "../../config.js";

const ROOT = path.resolve();
const MIGRATIONS_DIR = path.resolve(ROOT, "src/database/migrations");
const SEEDS_DIR = path.resolve(ROOT, "src/database/seeders");

for (const p of [MIGRATIONS_DIR, SEEDS_DIR]) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

let _db = null;

function buildClientConfig() {
  const client = (config?.db?.client || "sqlite").toLowerCase();

  if (client === "sqlite") {
    const filename =
      config?.db?.sqlite?.filename || path.resolve("data/warest.sqlite");
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    } catch {}

    return {
      client: "sqlite3",
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      migrations: {
        directory: MIGRATIONS_DIR,
        tableName: "_migrations",
        extension: "js",
        loadExtensions: [".js"],
      },
      seeds: {
        directory: SEEDS_DIR,
        extension: "js",
        loadExtensions: [".js"],
      },
    };
  }

  if (client === "mysql") {
    const c = config.db.mysql || {};
    return {
      client: "mysql2",
      connection: {
        host: c.host,
        port: c.port || 3306,
        user: c.user,
        password: c.password,
        database: c.database,
        multipleStatements: false,
      },
      pool: { min: 1, max: 10 },
      migrations: {
        directory: MIGRATIONS_DIR,
        tableName: "_migrations",
        extension: "js",
        loadExtensions: [".js"],
      },
      seeds: {
        directory: SEEDS_DIR,
        extension: "js",
        loadExtensions: [".js"],
      },
    };
  }

  if (client === "postgres" || client === "postgresql" || client === "pg") {
    const c = config.db.postgres || {};
    const useUrl = typeof c.url === "string" && c.url.length > 0;
    const connection = useUrl
      ? { connectionString: c.url }
      : {
          host: c.host,
          port: c.port || 5432,
          user: c.user,
          password: c.password,
          database: c.database,
        };
    if (process.env.WAREST_DB_SSL === "1") {
      connection.ssl = { rejectUnauthorized: false };
    }
    return {
      client: "pg",
      connection,
      pool: { min: 1, max: 10 },
      migrations: {
        directory: MIGRATIONS_DIR,
        tableName: "_migrations",
        schemaName: process.env.WAREST_DB_SCHEMA || undefined,
        extension: "js",
        loadExtensions: [".js"],
      },
      seeds: {
        directory: SEEDS_DIR,
        extension: "js",
        loadExtensions: [".js"],
      },
    };
  }

  throw new Error(`Unsupported DB client: ${client}`);
}

export function getDb() {
  if (_db) return _db;
  const cfg = buildClientConfig();
  _db = createDb(cfg);
  return _db;
}

export const db = getDb();

export async function closeDb() {
  if (_db) {
    const inst = _db;
    _db = null;
    await inst.destroy().catch(() => {});
  }
}
