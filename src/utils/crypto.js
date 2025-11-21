import crypto from "crypto";

/**
 * Returns HMAC-SHA256 hex digest for a payload and secret.
 */
export function hmacSign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Returns SHA256 hex of the provided data (Buffer or string).
 */
export function sha256Hex(data) {
  const h = crypto.createHash("sha256");
  if (Buffer.isBuffer(data)) h.update(data);
  else h.update(String(data || ""));
  return h.digest("hex");
}

/**
 * Returns SHA2 (224/256/384/512) hex of data.
 * @param {Buffer|string} data
 * @param {('sha224'|'sha256'|'sha384'|'sha512')} algo
 */
export function shaHex(data, algo = "sha256") {
  const h = crypto.createHash(algo);
  if (Buffer.isBuffer(data)) h.update(data);
  else h.update(String(data || ""));
  return h.digest("hex");
}

/**
 * Returns HMAC hex using SHA2 variants.
 * @param {string|Buffer} payload
 * @param {string|Buffer} secret
 * @param {('sha224'|'sha256'|'sha384'|'sha512')} algo
 */
export function hmacHex(payload, secret, algo = "sha256") {
  return crypto.createHmac(algo, secret).update(payload).digest("hex");
}

/**
 * Constant-time equality with strict length check.
 */
export function safeEqual(a, b) {
  try {
    const A = Buffer.from(String(a ?? ""), "utf8");
    const B = Buffer.from(String(b ?? ""), "utf8");
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

/**
 * normalize algo header "HMAC-SHA256" -> "sha256"
 */
export function algoFromHeader(header) {
  const m = String(header || "")
    .toUpperCase()
    .match(/^HMAC-SHA(224|256|384|512)$/);
  const bits = m ? m[1] : "256";
  return bits === "224"
    ? "sha224"
    : bits === "384"
    ? "sha384"
    : bits === "512"
    ? "sha512"
    : "sha256";
}

/**
 * Normalize SHA2 input from env: accepts
 *  - numeric strings: "224", "256", "384", "512"
 *  - algorithm names: "sha256", "SHA-256", "SHA256"
 */
export function algoFromEnv(input, def = "sha256") {
  const raw = String(input || "")
    .trim()
    .toLowerCase();
  if (!raw) return def;
  if (/^sha-?224$/.test(raw) || raw === "224") return "sha224";
  if (/^sha-?256$/.test(raw) || raw === "256") return "sha256";
  if (/^sha-?384$/.test(raw) || raw === "384") return "sha384";
  if (/^sha-?512$/.test(raw) || raw === "512") return "sha512";
  return def;
}

/**
 * Convert algo (sha224|sha256|sha384|sha512) to header token HMAC-SHAxxx
 */
export function algoToHeaderToken(algo = "sha256") {
  const bits =
    algo === "sha224" ? 224 : algo === "sha384" ? 384 : algo === "sha512" ? 512 : 256;
  return `HMAC-SHA${bits}`;
}
