import { config } from "../config.js";
import { createCacheStore } from "../drivers/cache.js";

const cooldownCache = createCacheStore({
  namespace: "middleware:spam:cooldown",
  ttlSeconds: Math.ceil((config.spam.cooldownMs || 3000) / 1000) + 5,
  name: "spam-cooldown",
});
const quotaCache = createCacheStore({
  namespace: "middleware:spam:quota",
  ttlSeconds: Math.ceil((config.spam.quotaWindowMs || 60000) / 1000) + 5,
  name: "spam-quota",
});

export function antiSpam() {
  return async (req, res, next) => {
    try {
      const key = req.auth?.key || req.ip || "anonymous";
      const to = (req.body?.to || "").toString();
      const now = Date.now();

      if (to) {
        const cooldownKey = `cd:${key}:${to}`;
        const until = await cooldownCache.get(cooldownKey);
        if (until && now < until) {
          const retryAfter = Math.max(0, Math.ceil((until - now) / 1000));
          res.setHeader("Retry-After", retryAfter);
          return res
            .status(429)
            .json({ error: "Recipient cooldown", retryAfter });
        }
        await cooldownCache.set(
          cooldownKey,
          now + (config.spam.cooldownMs || 3000),
          Math.ceil((config.spam.cooldownMs || 3000) / 1000) + 5
        );
      }

      const qkey = `q:${key}`;
      let state = (await quotaCache.get(qkey)) || null;
      const quotaWindow = config.spam.quotaWindowMs || 60000;
      if (!state || now > state.reset)
        state = { count: 0, reset: now + quotaWindow };
      state.count += 1;
      await quotaCache.set(qkey, state, Math.ceil(quotaWindow / 1000) + 5);
      res.setHeader("X-Quota-Limit", String(config.spam.quotaMax));
      res.setHeader(
        "X-Quota-Remaining",
        String(Math.max(0, config.spam.quotaMax - state.count))
      );
      res.setHeader("X-Quota-Reset", String(Math.floor(state.reset / 1000)));
      if (state.count > config.spam.quotaMax) {
        return res.status(429).json({ error: "Quota exceeded" });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
