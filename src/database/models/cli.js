
import { migrateLatest, migrateRollback, migrationStatus, makeMigration } from "./migrator.js";
import { seedRun, makeSeed } from "./seeder.js";
import { db, closeDb } from "./db.js";

function info(msg, data) {
  process.stdout.write(`[db] ${msg}${data ? " " + JSON.stringify(data, null, 2) : ""}\n`);
}
function error(msg, data) {
  process.stderr.write(`[db] ERROR: ${msg}${data ? " " + JSON.stringify(data, null, 2) : ""}\n`);
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  try {
    switch (cmd) {
      case "migrate:latest": {
        const res = await migrateLatest();
        info("migrate:latest done", res);
        break;
      }
      case "migrate:rollback": {
        const all = args.includes("--all");
        const res = await migrateRollback({ all });
        info(`migrate:rollback ${all ? "(all)" : ""} done`, res);
        break;
      }
      case "migrate:make": {
        const name = args[0];
        const file = await makeMigration(name);
        info("created migration", { file });
        break;
      }
      case "seed:run": {
        const res = await seedRun();
        info("seed:run done", res);
        break;
      }
      case "seed:make": {
        const name = args[0];
        const file = await makeSeed(name);
        info("created seed", { file });
        break;
      }
      case "db:status": {
        const st = await migrationStatus();
        info("status", st);
        break;
      }
      case "db:ping": {
        await db.raw("select 1 as ok");
        info("ping ok");
        break;
      }
      case "help":
      default: {
        const help = `
Usage:
  node src/database/models/cli.js <command>

Commands:
  migrate:latest                 Run all pending migrations
  migrate:rollback [--all]       Rollback the last batch (or all)
  migrate:make <name>            Create a new migration file
  seed:run                       Run all seeders
  seed:make <name>               Create a new seed file
  db:status                      Show completed & pending migrations
  db:ping                        Test DB connectivity
`;
        process.stdout.write(help);
        break;
      }
    }
  } catch (e) {
    error(e.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main();
