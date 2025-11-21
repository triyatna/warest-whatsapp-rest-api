import crypto from "node:crypto";
import { ulid } from "ulid";
import { config } from "../config.js";
import { db } from "../database/models/db.js";
import { hashPassword } from "./password.js";
import { randomApiKeyLike } from "./apiKey.js";

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

export async function syncAdminFromEnv() {
  const { username, password, apiKey } = config.adminSeed || {};

  const u = String(username || "").trim();
  const p = String(password || "").trim();
  const k = String(apiKey || "").trim();

  if (!u || !p) {
    return;
  }

  const existing = await db("users").where({ username: u }).first();
  const pwdHash = await hashPassword(p);

  const initialApiKey = k || randomApiKeyLike("admin");
  const apiKeyHash = sha256Hex(initialApiKey);

  if (!existing) {
    const id = ulid();
    const registry = "admin";
    await db("users").insert({
      id,
      registry,
      username: u,
      password: pwdHash,
      api_key: apiKeyHash,
      is_admin: 1,
      created_at: db.fn.now(),
    });
    return;
  }

  const patch = {
    password: pwdHash,
    is_admin: 1,
    updated_at: db.fn.now(),
  };
  if (k) patch.api_key = apiKeyHash;

  await db("users").where({ id: existing.id }).update(patch);
}
