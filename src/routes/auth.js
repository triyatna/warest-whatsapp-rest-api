import express from "express";
import { db } from "../database/index.js";
import { verifyPassword } from "../utils/password.js";
import { randomApiKeyLike } from "../utils/apiKey.js";
import crypto from "node:crypto";
import { findUserByApiKey } from "../database/models/userRepo.js";

export const DOCS_COOKIE_NAME = "WAREST_DOCS_SESSION";
export const DOCS_COOKIE_BASE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
const DOCS_COOKIE_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const setDocsCookie = (res, value) =>
  res.cookie(DOCS_COOKIE_NAME, value, {
    ...DOCS_COOKIE_BASE_OPTIONS,
    maxAge: DOCS_COOKIE_MAX_AGE,
  });
const clearDocsCookie = (res) =>
  res.clearCookie(DOCS_COOKIE_NAME, {
    ...DOCS_COOKIE_BASE_OPTIONS,
    maxAge: 0,
  });

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCKS_MS = [2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];
const loginGuards = new Map();

const extractClientIp = (req = {}) => {
  const fwd = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return fwd || req.ip || req.socket?.remoteAddress || "unknown";
};

const buildLoginKey = (req, username) => {
  return `${extractClientIp(req)}|${String(username || "").toLowerCase() || "*"}`;
};

const getLockRemainingMs = (key) => {
  const state = loginGuards.get(key);
  if (!state) return 0;
  const now = Date.now();
  if (state.lockUntil && state.lockUntil > now) {
    return state.lockUntil - now;
  }
  if (now - state.start > LOGIN_WINDOW_MS) {
    loginGuards.delete(key);
  } else if (state.lockUntil && state.lockUntil <= now) {
    loginGuards.set(key, { ...state, lockUntil: 0 });
  }
  return 0;
};

const registerLoginFailure = (key) => {
  const now = Date.now();
  const existing = loginGuards.get(key);
  let next = existing;
  if (!existing || now - existing.start > LOGIN_WINDOW_MS) {
    next = { start: now, count: 0, lockUntil: 0 };
  }
  next.count += 1;
  if (next.count % LOGIN_FAIL_LIMIT === 0) {
    const level = Math.min(
      LOGIN_LOCKS_MS.length,
      Math.floor(next.count / LOGIN_FAIL_LIMIT)
    );
    const idx = Math.max(0, Math.min(LOGIN_LOCKS_MS.length - 1, level - 1));
    next.lockUntil = now + LOGIN_LOCKS_MS[idx];
  }
  loginGuards.set(key, next);
  return next.lockUntil && next.lockUntil > now ? next.lockUntil - now : 0;
};

const clearLoginFailures = (key) => {
  if (key) loginGuards.delete(key);
};

const extractApiKeyFromHeaders = (req) => {
  const headerKey = String(req.headers?.["x-warest-api-key"] || "").trim();
  if (headerKey) return headerKey;
  const auth = String(req.headers?.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
};

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

const router = express.Router();

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Response: { apiKey, role: 'admin'|'user', username, registry }
 */
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const u = String(username || "").trim();
    const p = String(password || "").trim();
    const loginKey = buildLoginKey(req, u);
    const lockedFor = getLockRemainingMs(loginKey);
    if (lockedFor > 0) {
      const retryAfter = Math.ceil(lockedFor / 1000);
      return res
        .status(429)
        .set("Retry-After", String(retryAfter))
        .json({
          error: `Too many attempts. Try again in ${retryAfter}s`,
          retryAfter,
        });
    }

    if (!u || !p) {
      clearDocsCookie(res);
      return res.status(400).json({ error: "username/password required" });
    }

    const user = await db("users").where({ username: u }).first();
    if (!user) {
      clearDocsCookie(res);
      const waitMs = registerLoginFailure(loginKey);
      if (waitMs > 0) {
        const retryAfter = Math.ceil(waitMs / 1000);
        return res
          .status(429)
          .set("Retry-After", String(retryAfter))
          .json({
            error: `Too many attempts. Try again in ${retryAfter}s`,
            retryAfter,
          });
      }
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await verifyPassword(p, user.password);
    if (!ok) {
      clearDocsCookie(res);
      const waitMs = registerLoginFailure(loginKey);
      if (waitMs > 0) {
        const retryAfter = Math.ceil(waitMs / 1000);
        return res
          .status(429)
          .set("Retry-After", String(retryAfter))
          .json({
            error: `Too many attempts. Try again in ${retryAfter}s`,
            retryAfter,
          });
      }
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isAdmin = !!user.is_admin;
    const role = isAdmin ? "admin" : "user";

    // For admin seeded via .env, keep the API key fixed to env (hash stored in DB)
    const envAdminKey = String(process.env.WAREST_ADMIN_APIKEY || "").trim();
    let apiKeyOut = null;
    if (role === "admin" && envAdminKey) {
      const hashed = sha256Hex(envAdminKey);
      try {
        await db("users").where({ id: user.id }).update({
          api_key: hashed,
          last_login_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
      } catch {}
      apiKeyOut = envAdminKey;
    } else {
      // Rotate API key for non-admins
      const newApiKey = randomApiKeyLike(role);
      const hashed = sha256Hex(newApiKey);
      try {
        await db("users").where({ id: user.id }).update({
          api_key: hashed,
          last_login_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
      } catch {}
      apiKeyOut = newApiKey;
    }

    clearLoginFailures(loginKey);
    setDocsCookie(res, apiKeyOut);

    return res.json({
      apiKey: apiKeyOut,
      role,
      isAdmin,
      username: user.username,
      registry: user.registry,
    });
  } catch (e) {
    return res.status(500).json({ error: "login failed" });
  }
});

router.post("/logout", (req, res) => {
  try {
    clearDocsCookie(res);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "logout failed" });
  }
});

router.post("/session", async (req, res) => {
  try {
    const headerKey = extractApiKeyFromHeaders(req);
    const rawKey =
      headerKey || String(req.body?.apiKey || req.body?.token || "").trim();
    if (!rawKey) {
      return res.status(400).json({ error: "apiKey required" });
    }
    const user = await findUserByApiKey(rawKey);
    if (!user) {
      return res.status(401).json({ error: "Invalid apiKey" });
    }
    setDocsCookie(res, rawKey);
    return res.json({
      ok: true,
      username: user.username,
      role: user.is_admin ? "admin" : "user",
      isAdmin: !!user.is_admin,
    });
  } catch (e) {
    return res.status(500).json({ error: "sync failed" });
  }
});

export default router;
