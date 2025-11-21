import express from "express";

import {
  getSession,
  listSessions,
  getCachedMessage,
} from "../whatsapp/baileysClient.js";
import { logger } from "../logger.js";
import { normalizePhoneDigits } from "../utils/phone.js";

const router = express.Router();

/* ------------------------ helpers ------------------------ */
function digitsOnly(v) {
  return String(v || "").replace(/\D+/g, "");
}
function jidify(to) {
  const raw = String(to || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) {
    const lower = raw.toLowerCase();
    if (/(?:@s\.whatsapp\.net|@g\.us|@newsletter|@broadcast)$/i.test(lower)) {
      return raw;
    }
    if (/@c\.us$/i.test(lower))
      return raw.replace(/@c\.us$/i, "@s.whatsapp.net");
    const d = normalizePhoneDigits(raw);
    if (d) return `${d}@s.whatsapp.net`;
    return raw;
  }
  const d = normalizePhoneDigits(raw);
  return d ? `${d}@s.whatsapp.net` : "";
}

function parseBoolean(v, def = false) {
  if (typeof v === "boolean") return v;
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}

function clampNumber(n, min, max, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, min), max);
}

function stripDeviceSuffix(value = "") {
  return String(value || "")
    .replace(/:\d+(?=@[A-Za-z0-9.-]+$)/, "")
    .replace(/:\d+$/, "");
}

function sanitizeJid(jid) {
  const raw = String(jid || "").trim();
  if (!raw) return "";
  return stripDeviceSuffix(raw);
}

async function resolveSession({ sessionId, phone }) {
  const id = String(sessionId || "").trim();
  const p = digitsOnly(phone);
  if (id) {
    const s = getSession(id);
    if (s && s.status === "open") return s;
    return null;
  }
  if (!p) return null;
  try {
    const items = await listSessions();
    for (const it of items) {
      if (it.status !== "open") continue;
      const s = getSession(it.id);
      const me = String(s?.me?.id || "");
      const mePhone = me.split("@")[0];
      if (mePhone && mePhone.replace(/\D+/g, "") === p) return s;
    }
  } catch {}
  return null;
}

function makeBaseResult(session, jid) {
  const normalizedJid = sanitizeJid(jid);
  const toPhone = normalizedJid ? normalizedJid.split("@")[0] : null;
  const meJid = sanitizeJid(session?.me?.id || "");
  const fromPhone = meJid ? meJid.split("@")[0] : null;
  return {
    sessionId: session?.id || null,
    phone: fromPhone,
    to: toPhone,
    toJid: normalizedJid || null,
  };
}

async function inferKey(s, jid, messageId, preferFromMe) {
  const id = String(messageId || "").trim();
  const cached = id ? getCachedMessage(s?.id, id) : null;
  let stored = null;
  let key = cached?.key ? { ...cached.key } : null;
  if (!key && id) {
    try {
      stored = await s.store?.getMessage?.({ id, remoteJid: jid });
      if (stored?.key) key = { ...stored.key };
    } catch {}
  }
  if (!key) key = { id, remoteJid: jid };
  if (!key.remoteJid) key.remoteJid = jid;
  let resolvedFromMe;
  if (typeof preferFromMe === "boolean") {
    resolvedFromMe = preferFromMe;
  } else if (cached?.key && typeof cached.key.fromMe === "boolean") {
    resolvedFromMe = cached.key.fromMe;
  } else if (stored?.key && typeof stored.key.fromMe === "boolean") {
    resolvedFromMe = stored.key.fromMe;
  } else if (typeof key.fromMe === "boolean") {
    resolvedFromMe = key.fromMe;
  }
  const fromMeUncertain =
    typeof resolvedFromMe !== "boolean" && typeof preferFromMe !== "boolean";
  key.fromMe = typeof resolvedFromMe === "boolean" ? resolvedFromMe : false;
  return { key, fromMeUncertain };
}

async function performMessageActionWithFallback(keyData, fn) {
  try {
    await fn(keyData.key);
    return keyData.key;
  } catch (err) {
    if (!keyData.fromMeUncertain) throw err;
    const swapped = { ...keyData.key, fromMe: !keyData.key.fromMe };
    keyData.key = swapped;
    keyData.fromMeUncertain = false;
    await fn(swapped);
    return swapped;
  }
}

function respondActionSuccess(
  res,
  { message, payload, statusCode = 200, code = 1000 }
) {
  const results = payload == null ? null : [payload];
  return res.status(statusCode).json({
    status: true,
    code,
    message,
    results,
  });
}

function respondActionError(res, { message, statusCode = 500, code = 8000 }) {
  return res.status(statusCode).json({
    status: false,
    code,
    message,
    results: null,
  });
}

/* ------------------------ per-message actions ------------------------ */

// POST /api/(v1)/messages/{:messageId}/action/star
router.post(["/:messageId/action/star"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const { messageId } = req.params || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return respondActionError(res, {
        statusCode: 404,
        code: 1101,
        message: "Session not found",
      });
    const jid = jidify(to);
    if (!jid || !messageId)
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Missing destination or messageId",
      });
    const keyData = await inferKey(s, jid, messageId);
    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () =>
        s.sock.chatModify(
          {
            star: {
              messages: [{ id: key.id, fromMe: !!key.fromMe }],
              star: true,
            },
          },
          jid
        )
      )
    );
    try {
      await s.store?.setMessageStarred?.(keyData.key.id, true);
    } catch {}
    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "message starred success",
    };
    return respondActionSuccess(res, {
      message: "Message starred",
      payload: out,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/star error");
    return respondActionError(res, {
      statusCode: 500,
      code: 8000,
      message: "Internal server error",
    });
  }
});

router.post(["/:messageId/action/unstar"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const { messageId } = req.params || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return respondActionError(res, {
        statusCode: 404,
        code: 1101,
        message: "Session not found",
      });
    const jid = jidify(to);
    if (!jid || !messageId)
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Missing destination or messageId",
      });
    const keyData = await inferKey(s, jid, messageId);
    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () =>
        s.sock.chatModify(
          {
            star: {
              messages: [{ id: key.id, fromMe: !!key.fromMe }],
              star: false,
            },
          },
          jid
        )
      )
    );
    try {
      await s.store?.setMessageStarred?.(keyData.key.id, false);
    } catch {}
    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "message unstarred success",
    };
    return respondActionSuccess(res, {
      message: "Message unstarred",
      payload: out,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/unstar error");
    return respondActionError(res, {
      statusCode: 500,
      code: 8000,
      message: "Internal server error",
    });
  }
});

router.post(["/:messageId/action/reaction"], async (req, res) => {
  try {
    const { sessionId, phone, to, emoji } = req.body || {};
    const { messageId } = req.params || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return respondActionError(res, {
        statusCode: 404,
        code: 1101,
        message: "Session not found",
      });
    const jid = jidify(to);
    if (!jid || !messageId)
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Missing destination or messageId",
      });
    if (typeof emoji !== "string" || !emoji)
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Emoji is required",
      });
    const keyData = await inferKey(s, jid, messageId);
    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () =>
        s.sock.sendMessage(jid, { react: { text: emoji, key } })
      )
    );
    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "reaction applied success",
    };
    return respondActionSuccess(res, {
      message: "Reaction applied",
      payload: out,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/reaction error");
    return respondActionError(res, {
      statusCode: 502,
      code: 4005,
      message: "Failed to react to message",
    });
  }
});

router.post(["/:messageId/action/unreaction"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const { messageId } = req.params || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return respondActionError(res, {
        statusCode: 404,
        code: 1101,
        message: "Session not found",
      });
    const jid = jidify(to);
    if (!jid || !messageId)
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Missing destination or messageId",
      });
    const keyData = await inferKey(s, jid, messageId);
    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () =>
        s.sock.sendMessage(jid, { react: { text: "", key } })
      )
    );
    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "reaction removed success",
    };
    return respondActionSuccess(res, {
      message: "Reaction removed",
      payload: out,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/unreaction error");
    return respondActionError(res, {
      statusCode: 502,
      code: 4005,
      message: "Failed to remove reaction",
    });
  }
});

router.delete(["/:messageId/action/delete"], async (req, res) => {
  try {
    const { sessionId, phone, to, withMedia } = req.body || {};
    const { messageId } = req.params || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const jid = jidify(to);
    if (!jid || !messageId)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing destination or messageId",
        results: null,
      });
    const keyData = await inferKey(s, jid, messageId);
    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () =>
        s.sock.chatModify(
          {
            deleteForMe: {
              key,
              deleteMedia: parseBoolean(withMedia, true),
              timestamp: Date.now(),
            },
          },
          jid
        )
      )
    );
    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "message deleted success",
    };
    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Message deleted for me",
      results: [out],
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/delete error");
    return res.status(502).json({
      status: false,
      code: 4000,
      message: "Failed to delete message",
      results: null,
    });
  }
});

router.post(["/:messageId/action/revoke"], async (req, res) => {
  try {
    const { sessionId, phone, to, deleteForMe } = req.body || {};
    const { messageId } = req.params || {};

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });

    const jid = jidify(to);
    if (!jid || !messageId)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing destination or messageId",
        results: null,
      });

    const keyData = await inferKey(s, jid, messageId, true);

    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () => s.sock.sendMessage(jid, { delete: key }))
    );
    if (parseBoolean(deleteForMe, false)) {
      await performMessageActionWithFallback(keyData, (key) =>
        s.queue.push(async () =>
          s.sock.chatModify(
            {
              deleteForMe: {
                key,
                deleteMedia: true,
                timestamp: Date.now(),
              },
            },
            jid
          )
        )
      );
    }

    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "message revoked success",
    };
    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Message revoked",
      results: [out],
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/revoke error");
    return res.status(502).json({
      status: false,
      code: 4000,
      message: "Failed to revoke message",
      results: null,
    });
  }
});

router.post(["/:messageId/action/edit"], async (req, res) => {
  try {
    const { sessionId, phone, to, message } = req.body || {};
    const { messageId } = req.params || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return respondActionError(res, {
        statusCode: 404,
        code: 1101,
        message: "Session not found",
      });
    const jid = jidify(to);
    if (!jid || !messageId)
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Missing destination or messageId",
      });
    if (typeof message !== "string" || !message.trim())
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Message text is required",
      });
    const keyData = await inferKey(s, jid, messageId, true);
    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () =>
        s.sock.sendMessage(jid, { edit: key, text: String(message) })
      )
    );
    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "message edited success",
    };
    return respondActionSuccess(res, {
      message: "Message edited",
      payload: out,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/edit error");
    return respondActionError(res, {
      statusCode: 403,
      code: 4001,
      message: "Editing this message is not allowed",
    });
  }
});

router.post(["/:messageId/action/mark-as-read"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const { messageId } = req.params || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return respondActionError(res, {
        statusCode: 404,
        code: 1101,
        message: "Session not found",
      });
    const jid = jidify(to);
    if (!jid || !messageId)
      return respondActionError(res, {
        statusCode: 400,
        code: 2001,
        message: "Missing destination or messageId",
      });
    const keyData = await inferKey(s, jid, messageId);
    await performMessageActionWithFallback(keyData, (key) =>
      s.queue.push(async () => s.sock.readMessages([{ ...key }]))
    );
    const out = {
      ...makeBaseResult(s, jid),
      messageId: keyData.key.id,
      status: "message read success",
    };
    return respondActionSuccess(res, {
      message: "Message marked as read",
      payload: out,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/mark-as-read error");
    return respondActionError(res, {
      statusCode: 500,
      code: 8000,
      message: "Internal server error",
    });
  }
});

/* ------------------------ chat-level actions ------------------------ */

// POST /api/(v1)/messages/action/mute
router.post(["/action/mute"], async (req, res) => {
  try {
    const { sessionId, phone, to, duration } = req.body || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const jid = jidify(to);
    if (!jid)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing destination",
        results: null,
      });
    const minutes = clampNumber(duration ?? 60, 1, 43200, 60);
    const until = Date.now() + minutes * 60 * 1000;
    await s.queue.push(async () => s.sock.chatModify({ mute: until }, jid));
    const out = {
      ...makeBaseResult(s, jid),
      status: "chat muted success",
    };
    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Chat muted",
      results: [out],
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/mute error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

router.post(["/action/unmute"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const jid = jidify(to);
    if (!jid)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing destination",
        results: null,
      });
    await s.queue.push(async () => s.sock.chatModify({ mute: 0 }, jid));
    const out = { ...makeBaseResult(s, jid), status: "chat unmuted success" };
    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Chat unmuted",
      results: [out],
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/unmute error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

router.post(["/action/archive"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const jid = jidify(to);
    if (!jid)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing destination",
        results: null,
      });
    const tsNow = Math.floor(Date.now() / 1000);
    const lastMessages = { lastMessageTimestamp: tsNow };
    await s.queue.push(async () =>
      s.sock.chatModify({ archive: true, lastMessages }, jid)
    );
    const out = { ...makeBaseResult(s, jid), status: "chat archived success" };
    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Chat archived",
      results: [out],
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/archive error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

router.post(["/action/unarchive"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const jid = jidify(to);
    if (!jid)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing destination",
        results: null,
      });
    const tsNow = Math.floor(Date.now() / 1000);
    const lastMessages = { lastMessageTimestamp: tsNow };
    await s.queue.push(async () =>
      s.sock.chatModify({ archive: false, lastMessages }, jid)
    );
    const out = {
      ...makeBaseResult(s, jid),
      status: "chat unarchived success",
    };
    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Chat unarchived",
      results: [out],
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/unarchive error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

router.delete(["/action/clear-all"], async (req, res) => {
  try {
    const { sessionId, phone, to } = req.body || {};
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const jid = jidify(to);
    if (!jid)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing destination",
        results: null,
      });
    const tsNow = Math.floor(Date.now() / 1000);
    const lastMessages = { lastMessageTimestamp: tsNow };
    await s.queue.push(async () =>
      s.sock.chatModify({ clear: "all", lastMessages }, jid)
    );
    const out = { ...makeBaseResult(s, jid), status: "chat cleared success" };
    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Chat cleared",
      results: [out],
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "action/clear-all error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

export default router;


