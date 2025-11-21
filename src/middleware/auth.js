import crypto from "node:crypto";
import { findUserByApiKey } from "../database/models/userRepo.js";

export function ownerIdFromKey(key) {
  return crypto
    .createHash("sha256")
    .update(String(key))
    .digest("hex")
    .slice(0, 32);
}

/** Ambil API key dari Header, Query, atau Bearer */
export function extractApiKey(req) {
  const getHeader = (k) => (req.get?.(k) || req.headers?.[k.toLowerCase()] || "").toString();
  const hAuth = String(getHeader("authorization") || "");
  let token = "";
  for (const prefix of ["Bearer ", "Token ", "APIKey "]) {
    if (hAuth.startsWith(prefix)) {
      token = hAuth.slice(prefix.length).trim();
      break;
    }
  }
  const candidates = [
    getHeader("X-WAREST-API-KEY"),
    getHeader("X-API-KEY"),
    getHeader("X-Api-Key"),
    getHeader("Api-Key"),
    req.query?.api_key,
    req.query?.apikey,
    req.query?.apiKey,
    token,
  ]
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return candidates[0] || "";
}

/**
 * Middleware otentikasi berdasarkan API key
 * - Mendukung: Header `X-WAREST-API-KEY`, `Authorization: Bearer`, ?api_key=
 * @param {"user"|"admin"} requiredRole
 */
export function apiKeyAuth(requiredRole = "user") {
  return async (req, res, next) => {
    try {
      const key = extractApiKey(req);
      if (!key) {
        return res.status(401).json({ error: "Missing X-WAREST-API-KEY" });
      }

      const user = await findUserByApiKey(key);
      if (!user) {
        return res.status(401).json({ error: "Invalid X-WAREST-API-KEY" });
      }

      const isAdmin = !!user.is_admin;
      if (requiredRole === "admin" && !isAdmin) {
        return res.status(403).json({ error: "Admin only" });
      }

      req.auth = {
        role: isAdmin ? "admin" : "user",
        key,
        ownerId: user.registry,
        userId: user.id,
        username: user.username,
        isAdmin,
        user,
      };
      res.locals.auth = req.auth;

      return next();
    } catch {
      return res.status(401).json({ error: "Invalid X-WAREST-API-KEY" });
    }
  };
}
