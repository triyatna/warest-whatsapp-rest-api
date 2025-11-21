import crypto from "node:crypto";
import { db } from "./db.js";

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}
function isHex64(s) {
  return typeof s === "string" && /^[a-f0-9]{64}$/i.test(s);
}

export async function findUserByApiKey(apiKey) {
  if (!apiKey) return null;

  const plain = String(apiKey).trim();
  const hashed = sha256Hex(plain);

  
  let user = await db("users").where({ api_key: hashed }).first();
  if (user) return user;

  
  user = await db("users").where({ api_key: plain }).first();
  if (user) return user;

  
  try {
    const row = await db("users")
      .whereRaw("LOWER(api_key) = LOWER(?)", [hashed])
      .first();
    if (row) return row;
  } catch {}
  try {
    const row2 = await db("users")
      .whereRaw("LOWER(api_key) = LOWER(?)", [plain])
      .first();
    if (row2) return row2;
  } catch {}

  return null;
}

export async function findUserByRegistry(registry) {
  if (!registry) return null;
  return db("users").where({ registry }).first();
}


export const findUserByIdRegistry = findUserByRegistry;

export async function setUserApiKeyHashed(id, apiKey) {
  if (!id || !apiKey) return false;
  const hashed = sha256Hex(apiKey);
  const updated = await db("users")
    .where({ id })
    .update({ api_key: hashed, updated_at: db.fn.now() });
  return updated > 0;
}
