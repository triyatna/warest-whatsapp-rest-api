import { config } from "../config.js";
import { createCacheStore } from "../drivers/cache.js";

const DEFAULT_WINDOW_MS = Math.max(1000, Number(config.rateLimit.windowMs) || 60000);
const rateLimitCache = createCacheStore({
  namespace: "middleware:ratelimit",
  ttlSeconds: Math.ceil(DEFAULT_WINDOW_MS / 1000) + 5,
  name: "rate-limit",
});

export function dynamicRateLimit() {
  return async (req, res, next) => {
    try {
      const key = req.auth?.key || req.ip || "anonymous";
      const windowMs = DEFAULT_WINDOW_MS;
      const max = Number(config.rateLimit.max) || 120;
      const bucketKey = `rl:${key}`;
      let state = (await rateLimitCache.get(bucketKey)) || null;
      const now = Date.now();
      if (!state || now > state.reset) {
        state = { count: 0, reset: now + windowMs };
      }
      state.count += 1;
      await rateLimitCache.set(bucketKey, state, Math.ceil(windowMs / 1000) + 5);
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, max - state.count))
      );
      res.setHeader("X-RateLimit-Reset", String(Math.floor(state.reset / 1000)));
      if (state.count > max) {
        return res.status(429).json({ error: "Too many requests" });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
