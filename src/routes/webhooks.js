import express from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { getSession } from "../whatsapp/baileysClient.js";
import { preflightWebhook } from "../services/webhook.js";
import { config } from "../config.js";

const router = express.Router();
router.use(apiKeyAuth("user"));

router.post("/preflight", async (req, res) => {
  const { sessionId, url, secret } = req.body || {};
  if (!url || !secret)
    return res.status(400).json({ error: "url and secret required" });
  const s = getSession(sessionId);
  if (!s) return res.status(404).json({ error: "Session not found" });
  try {
    const out = await preflightWebhook({
      url,
      secret,
      sessionId,
      options: config.webhookOpts,
    });
    res.json({ ok: true, results: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

export default router;
