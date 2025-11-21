import path from "node:path";
import { db } from "./db.js";

const SEEDS_DIR = path.resolve("src/database/seeders");

export async function seedRun() {
  const results = await db.seed.run({
    directory: SEEDS_DIR,
    extension: "js",
    loadExtensions: [".js"],
  });
  return results;
}

export async function makeSeed(name) {
  if (!name) throw new Error("Seed name is required");
  const file = await db.seed.make(name, {
    directory: SEEDS_DIR,
    extension: "js",
  });
  return file;
}
