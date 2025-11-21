import crypto from "node:crypto";

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (err, dk) => (err ? reject(err) : resolve(dk)))
  );
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password, hash) {
  try {
    if (!hash?.startsWith("scrypt:")) return false;
    const [, sHex, hHex] = hash.split(":");
    const salt = Buffer.from(sHex, "hex");
    const derived = Buffer.from(hHex, "hex");
    const computed = await new Promise((resolve, reject) =>
      crypto.scrypt(password, salt, derived.length, (err, dk) => (err ? reject(err) : resolve(dk)))
    );
    return crypto.timingSafeEqual(derived, computed);
  } catch {
    return false;
  }
}

