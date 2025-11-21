import crypto from "node:crypto";

function hashHex(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest();
}

function deriveUpperAlphaCode(input, offset = 0) {
  const buf = Buffer.isBuffer(input) ? input : hashHex(input);
  const out = [];
  for (let i = 0; i < 10; i++) {
    const b = buf[(offset + i) % buf.length];
    out.push(String.fromCharCode(65 + (b % 26)));
  }
  return out.join("");
}

function randomUpperAlpha(len = 10) {
  const out = [];
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out.push(String.fromCharCode(65 + (bytes[i] % 26)));
  return out.join("");
}

export async function pickUniqueRegistryCode(trx, base, selfId = null) {
  const h = hashHex(base);
  for (let off = 0; off < h.length; off++) {
    const code = deriveUpperAlphaCode(h, off);
    const exists = await trx("users").where({ registry: code }).first();
    if (!exists) return code;
    if (selfId && exists?.id === selfId) return code;
  }
  for (let i = 0; i < 10; i++) {
    const code = randomUpperAlpha(10);
    const exists = await trx("users").where({ registry: code }).first();
    if (!exists) return code;
  }
  return deriveUpperAlphaCode(h, 7);
}

