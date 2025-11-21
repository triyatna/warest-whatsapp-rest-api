import axios from "axios";
import { hmacHex, algoFromEnv, algoToHeaderToken } from "../utils/crypto.js";
import { logger } from "../logger.js";
import { getSession } from "../whatsapp/baileysClient.js";
import {
  sendButtons as sendInteractiveButtons,
  sendList as sendInteractiveList,
} from "../whatsapp/interactiveMessages.js";
import {
  getSessionMeta,
  upsertSessionMeta,
} from "../whatsapp/sessionRegistry.js";
import { clearSessionWebhook } from "../database/models/sessionRepo.js";
import { findUserByRegistry } from "../database/models/userRepo.js";
import { config } from "../config.js";
import { normalizePhoneDigits } from "../utils/phone.js";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULTS = {
  timeout: 10000,
  retries: 3,
  backoffMs: 800,
  jitter: 300,
  delayMsActions: 1200,
};

const circuit = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jittered(ms, j) {
  return ms + Math.floor(Math.random() * j);
}
function pickArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function genWebhookSecret() {
  try {
    const min = 10,
      max = 18;
    const len = min + Math.floor(Math.random() * (max - min + 1));
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  } catch {
    return Math.random().toString(36).slice(2, 12);
  }
}

function ensureSecretPresent(sessionId) {
  try {
    const meta = getSessionMeta(sessionId) || {};
    const cur = String(meta.webhookSecret || "").trim();
    if (cur && cur.length >= 6) return cur;
    const fresh = genWebhookSecret();
    upsertSessionMeta({ id: sessionId, webhookSecret: fresh });
    return fresh;
  } catch {
    return null;
  }
}

function isRetryable(err) {
  if (!err) return false;
  const code = err.response?.status;
  if (!code) return true;
  if (code === 429) return true;
  if (code >= 500) return true;
  return false;
}

function isCircuitOpen(url) {
  const s = circuit.get(url);
  return s && s.openUntil && Date.now() < s.openUntil;
}

function markCircuit(url, ok) {
  const s = circuit.get(url) || { fail: 0, openUntil: 0, security: false };
  if (ok) {
    s.fail = 0;
    s.openUntil = 0;
    s.security = false;
  } else {
    s.fail++;
    if (s.fail >= 5 && !s.security) {
      s.openUntil = Date.now() + 60_000;
    }
  }
  circuit.set(url, s);
}

function markSecurityOpen(url, minutes = 10) {
  const s = circuit.get(url) || { fail: 0, openUntil: 0, security: false };
  s.security = true;
  s.openUntil = Date.now() + minutes * 60_000;
  circuit.set(url, s);
}

function renderTemplate(str, ctx) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (_, k) => {
    const path = k.trim().split(".");
    let v = ctx;
    for (const p of path) {
      v = v?.[p];
    }
    return v == null ? "" : String(v);
  });
}
function renderDeep(obj, ctx) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map((x) => renderDeep(x, ctx));
  if (typeof obj === "object") {
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      o[k] = renderDeep(v, ctx);
    }
    return o;
  }
  return renderTemplate(obj, ctx);
}

async function runAction(sessionId, action) {
  const s = getSession(sessionId);
  if (!s) throw new Error("session not found");

  const to = action.to;
  const jid =
    to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")
      ? to
      : `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;

  switch (action.type) {
    case "text":
      await s.sock.sendMessage(jid, {
        text: action.text,
        mentions: (action.mentions || []).map(
          (x) => `${String(x).replace(/\D/g, "")}@s.whatsapp.net`
        ),
      });
      break;
    case "media": {
      const mediaType = String(action.mediaType || "").toLowerCase();
      if (!mediaType) throw new Error("unsupported mediaType");
      let buf = await fetchBuffer(action.url);

      if (mediaType === "image" && action.transform?.sharp) {
        try {
          const { default: sharp } = await import("sharp");
          let img = sharp(buf.buffer);
          const t = action.transform.sharp || {};
          if (t.resize && (t.resize.width || t.resize.height)) {
            img = img.resize(t.resize.width || null, t.resize.height || null, {
              fit: t.resize.fit || "inside",
              withoutEnlargement: t.resize.withoutEnlargement !== false,
            });
          }
          if (t.webp) img = img.webp({ quality: t.webp.quality ?? 90 });
          if (t.jpeg) img = img.jpeg({ quality: t.jpeg.quality ?? 90 });
          if (t.png) img = img.png({ quality: t.png.quality ?? 90 });
          const out = await img.toBuffer();
          buf = { buffer: out, mime: buf.mime };
        } catch (e) {
          logger.warn(
            { err: e?.message },
            "sharp transform failed; sending original"
          );
        }
      }

      if (
        (mediaType === "video" ||
          mediaType === "audio" ||
          mediaType === "gif") &&
        action.transcode
      ) {
        try {
          const out = await transcodeWithFfmpeg(
            buf.buffer,
            action.transcode,
            mediaType
          );
          if (out?.buffer)
            buf = { buffer: out.buffer, mime: out.mime || buf.mime };
        } catch (e) {
          logger.warn(
            { err: e?.message },
            "ffmpeg transcode failed; sending original"
          );
        }
      }

      if (mediaType === "image") {
        await s.sock.sendMessage(jid, {
          image: buf.buffer,
          mimetype: buf.mime,
          caption: action.caption,
        });
      } else if (mediaType === "video" || mediaType === "gif") {
        await s.sock.sendMessage(jid, {
          video: buf.buffer,
          mimetype: buf.mime,
          gifPlayback: mediaType === "gif",
          caption: action.caption,
        });
      } else if (mediaType === "audio") {
        await s.sock.sendMessage(jid, {
          audio: buf.buffer,
          mimetype: buf.mime,
          ptt: true,
        });
      } else {
        throw new Error("unsupported mediaType");
      }
      break;
    }
    case "document": {
      const buf = await fetchBuffer(action.url);
      await s.sock.sendMessage(jid, {
        document: buf.buffer,
        mimetype: buf.mime,
        fileName: action.filename || `file.${buf.mime.split("/")[1] || "bin"}`,
        caption: action.caption,
      });
      break;
    }
    case "location":
      await s.sock.sendMessage(jid, {
        location: {
          degreesLatitude: action.lat,
          degreesLongitude: action.lng,
          name: action.name,
          address: action.address,
        },
      });
      break;
    case "sticker": {
      const { default: sharp } = await import("sharp");
      let buf;
      if (action.webpUrl) {
        const w = await fetchBuffer(action.webpUrl);
        buf = w.buffer;
      } else {
        const img = await fetchBuffer(action.imageUrl);
        buf = await sharp(img.buffer)
          .resize(512, 512, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 95 })
          .toBuffer();
      }
      await s.sock.sendMessage(jid, { sticker: buf });
      break;
    }
    case "vcard": {
      const v = buildVCard(action.contact || {});
      await s.sock.sendMessage(jid, {
        contacts: {
          displayName: action.contact?.fullName || "Contact",
          contacts: [{ vcard: v }],
        },
      });
      break;
    }
    case "button": {
      if (action.message) {
        await s.sock.sendMessage(jid, action.message);
      } else if (Array.isArray(action.buttons)) {
        await sendInteractiveButtons(s.sock, jid, {
          text: action.text || " ",
          footer: action.footer,
          image: action.image,
          buttons: action.buttons,
          quoted: action.quoted,
        });
      } else {
        throw new Error("buttons action requires message or buttons array");
      }
      break;
    }
    case "list": {
      if (action.message) {
        await s.sock.sendMessage(jid, action.message);
      } else if (action.list || action.lists || action.sections) {
        const opts =
          action.list || action.lists
            ? {
                text: action.text || " ",
                footer: action.footer,
                list: action.list,
                lists: action.lists,
                image: action.image,
                quoted: action.quoted,
              }
            : {
                text: action.text || " ",
                footer: action.footer,
                list: {
                  buttonText: action.buttonText || "Open",
                  sections: action.sections || [],
                },
                image: action.image,
                quoted: action.quoted,
              };
        await sendInteractiveList(s.sock, jid, opts);
      } else {
        throw new Error("list action requires message or list/lists/sections");
      }
      break;
    }
    case "poll":
      await s.sock.sendMessage(jid, action.message);
      break;
    case "forward":
    case "raw":
      await s.sock.sendMessage(jid, action.message);
      break;
    case "noop":
      break;
    default:
      throw new Error("unknown action type");
  }
}

function getNumber(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return NaN;
}

async function runControlAction(sessionId, entry, opts) {
  const kind = String(
    entry.act || entry.action || entry.type || ""
  ).toLowerCase();
  if (!kind) return false;

  const s = getSession(sessionId);
  const jidify = (to) => {
    const p = String(to || "").trim();
    if (!p) return "";
    const lower = p.toLowerCase();
    if (/(?:@s\.whatsapp\.net|@g\.us)$/i.test(lower)) return p;
    if (lower.endsWith("@c.us"))
      return p.replace(/@c\.us$/i, "@s.whatsapp.net");
    const digits = normalizePhoneDigits(p);
    return digits ? `${digits}@s.whatsapp.net` : "";
  };

  if (kind === "delay") {
    const sec = getNumber(entry.seconds, entry.sec);
    const fromSec = !Number.isNaN(sec) ? sec * 1000 : NaN;
    const msVal = getNumber(entry.ms, entry.delayMs, fromSec);
    const d = !Number.isNaN(msVal) ? msVal : opts?.delayMsActions || 0;
    const state = String(entry.state || "").toLowerCase();
    const hasPresence = state === "composing" || state === "recording";
    const to = entry.to || entry.chat || entry.jid;
    if (hasPresence && !to) {
      logger.warn({ entry }, "[webhook] delay with state requires 'to'");
    }
    if (hasPresence && s && to) {
      const jid = jidify(to);
      try {
        await s.sock.presenceSubscribe?.(jid);
      } catch {}
      try {
        await s.sock.sendPresenceUpdate?.("available");
      } catch {}
      try {
        await s.sock.sendPresenceUpdate?.(state, jid);
      } catch {}
      if (d > 0) await sleep(d);
      try {
        await s.sock.sendPresenceUpdate?.("paused", jid);
      } catch {}
    } else {
      if (d > 0) await sleep(d);
    }
    return true;
  }

  if (kind === "typing") {
    const to = entry.to || entry.chat || entry.jid;
    const ms = !Number.isNaN(Number(entry.ms))
      ? Number(entry.ms)
      : opts?.delayMsActions || 1200;
    if (!to) {
      logger.warn({ entry }, "[webhook] typing requires 'to'");
      return true;
    }
    if (!s) return true;
    const jid = jidify(to);
    try {
      await s.sock.presenceSubscribe?.(jid);
    } catch {}
    try {
      await s.sock.sendPresenceUpdate?.("available");
    } catch {}
    try {
      await s.sock.sendPresenceUpdate?.("composing", jid);
    } catch {}
    if (ms > 0) await sleep(ms);
    try {
      await s.sock.sendPresenceUpdate?.("paused", jid);
    } catch {}
    return true;
  }

  if (kind === "presence") {
    const to = entry.to || entry.chat || entry.jid;
    const state = String(
      entry.state || entry.status || "available"
    ).toLowerCase();
    if (!s) return true;
    const jid = to ? jidify(to) : undefined;
    try {
      if (jid) await s.sock.presenceSubscribe?.(jid);
    } catch {}
    try {
      await s.sock.sendPresenceUpdate?.(state, jid);
    } catch {}
    return true;
  }

  if (kind === "react") {
    const to = entry.to || entry.chat || entry.jid || entry.key?.remoteJid;
    const emoji = entry.text || entry.emoji || entry.reaction || "";
    const key = entry.key;
    if (!s || !to || !emoji || !key) return true;
    const jid = jidify(to);
    await s.sock.sendMessage(jid, { react: { text: emoji, key } });
    return true;
  }

  if (kind === "star" || kind === "unstar") {
    const to = entry.to || entry.chat || entry.jid || entry.key?.remoteJid;
    const key = entry.key;
    if (!s || !to || !key) return true;
    const jid = jidify(to);
    const fromMe = !!key.fromMe;
    const on = kind === "star";
    await s.sock.chatModify(
      { star: { messages: [{ id: key.id, fromMe }], star: on } },
      jid
    );
    return true;
  }

  if (kind === "delete") {
    const to = entry.to || entry.chat || entry.jid || entry.key?.remoteJid;
    const key = entry.key;
    if (!s || !to || !key) return true;
    const jid = jidify(to);
    const deleteMedia = (() => {
      if (typeof entry.deleteMedia === "boolean") return entry.deleteMedia;
      if (typeof entry.withMedia === "boolean") return entry.withMedia;
      return true;
    })();
    await s.sock.chatModify(
      { deleteForMe: { key, deleteMedia, timestamp: Date.now() } },
      jid
    );
    return true;
  }

  if (kind === "revoke") {
    const to = entry.to || entry.chat || entry.jid || entry.key?.remoteJid;
    const key = entry.key;
    if (!s || !to || !key) return true;
    const jid = jidify(to);
    await s.sock.sendMessage(jid, { delete: key });
    if (entry.deleteForMe) {
      await s.sock.chatModify(
        { deleteForMe: { key, deleteMedia: true, timestamp: Date.now() } },
        jid
      );
    }
    return true;
  }

  if (kind === "edit") {
    const to = entry.to || entry.chat || entry.jid || entry.key?.remoteJid;
    const key = entry.key;
    const text = entry.message ?? entry.text ?? "";
    if (!s || !to || !key || !text) return true;
    const jid = jidify(to);
    await s.sock.sendMessage(jid, { edit: key, text: String(text) });
    return true;
  }

  if (kind === "read") {
    const keys = Array.isArray(entry.keys)
      ? entry.keys
      : entry.key
      ? [entry.key]
      : [];
    if (!s || !keys.length) return true;
    try {
      await s.sock.readMessages(keys);
    } catch {}
    return true;
  }

  if (kind === "queue") {
    const items = Array.isArray(entry.items) ? entry.items : [];
    const stepDelay = getNumber(entry.delayMs);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await runEntry(sessionId, it, opts);
      const d = !Number.isNaN(stepDelay) ? stepDelay : 0;
      if (d > 0 && i < items.length - 1) await sleep(d);
    }
    return true;
  }

  if (kind === "parallel") {
    const items = Array.isArray(entry.items) ? entry.items : [];
    await Promise.all(items.map((it) => runEntry(sessionId, it, opts)));
    return true;
  }

  if (kind === "when") {
    const v = entry.cond ?? entry.condition;
    const truthy = (() => {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (v == null) return false;
      const s = String(v).trim().toLowerCase();
      return !(
        s === "" ||
        s === "0" ||
        s === "false" ||
        s === "null" ||
        s === "undefined" ||
        s === "no"
      );
    })();
    const arr = truthy
      ? entry.then || entry.do || entry.items
      : entry.else || entry.otherwise;
    if (Array.isArray(arr) && arr.length) {
      for (const it of arr) await runEntry(sessionId, it, opts);
    }
    return true;
  }

  if (kind === "retry") {
    const attemptMax = Math.max(1, Number(entry.attempts || entry.times || 3));
    const inner =
      entry.item || (Array.isArray(entry.items) ? entry.items[0] : null);
    const backoff = Math.max(
      0,
      Number(entry.delayMs || entry.backoffMs || 500)
    );
    if (!inner) return true;
    let n = 0;

    while (n < attemptMax) {
      try {
        await runEntry(sessionId, inner, opts);
        return true;
      } catch (e) {
        n++;
        if (n >= attemptMax) break;
        await sleep(backoff);
      }
    }

    if (Array.isArray(entry.onFail)) {
      for (const it of entry.onFail) await runEntry(sessionId, it, opts);
    }
    return true;
  }

  return false;
}

async function runEntry(sessionId, entry, opts) {
  if (
    entry &&
    (entry.act ||
      entry.action ||
      (entry.type &&
        [
          "delay",
          "queue",
          "parallel",
          "when",
          "retry",
          "typing",
          "presence",
          "react",
          "read",
          "star",
          "unstar",
          "delete",
          "revoke",
          "edit",
        ].includes(String(entry.type).toLowerCase())))
  ) {
    const handled = await runControlAction(sessionId, entry, opts);
    if (handled) return true;
  }
  await runAction(sessionId, entry);
  return false;
}

async function fetchBuffer(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20_000,
  });
  const ct = resp.headers["content-type"] || "application/octet-stream";
  return { buffer: Buffer.from(resp.data), mime: ct };
}
function buildVCard({ fullName, org, phone, email }) {
  const num = (phone || "").replace(/\D/g, "");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${fullName || ""}`,
    org ? `ORG:${org}` : "",
    num ? `TEL;type=CELL;type=VOICE;waid=${num}:${num}` : "",
    email ? `EMAIL:${email}` : "",
    "END:VCARD",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Kirim event ke 1..N webhook URLs.
 * @param {Object} cfg
 *   - url: string | string[]
 *   - secret: string | string[]     (mendukung rotasi; tanda tangan pakai secret[0])
 *   - event: string
 *   - payload: object
 *   - sessionId: string  (untuk aksi response)
 *   - options: { timeout?, retries?, backoffMs?, jitter?, delayMsActions? }
 */
export async function postWebhook({
  url,
  secret,
  event,
  payload,
  sessionId,
  options = {},
}) {
  const urls = pickArray(url);
  if (!urls.length) return [];

  const secrets = pickArray(secret);
  const mainSecret = secrets[0] || "";
  const opts = { ...DEFAULTS, ...(config.webhookOpts || {}), ...options };

  const s = sessionId ? getSession(sessionId) : null;
  const meta = sessionId ? getSessionMeta(sessionId) : null;
  const sessionInfo = {
    id: sessionId || payload?.sessionId || null,
    label: s?.label || meta?.label || null,
    registry: s?.ownerId || meta?.ownerId || null,
    username: null,
  };
  try {
    if (sessionInfo.registry) {
      const u = await findUserByRegistry(sessionInfo.registry);
      sessionInfo.username = u?.username || null;
    }
  } catch {}
  if (!urls.length) return [];
  if (typeof mainSecret !== "string" || mainSecret.length < 6) {
    logger.warn({ urls }, "webhook skipped: weak/missing secret");
    return [];
  }

  const body = { event, data: payload, ts: Date.now(), session: sessionInfo };
  const json = JSON.stringify(body);
  const combinedKey =
    String(mainSecret || "") + String(sessionInfo.username || "");

  const algo = algoFromEnv(
    opts.signatureSha2 || config.webhookOpts?.signatureSha2 || "256",
    "sha256"
  );
  const sigHex = hmacHex(json, combinedKey, algo);
  const sigToken = algoToHeaderToken(algo); // e.g., HMAC-SHA256

  const baseHeaders = {
    "Content-Type": "application/json",
    "User-Agent": `WAREst/1 (webhook) Node/${process.version}`,
    "X-WAREST-Signature": `${sigToken}=${sigHex}`,
    "X-WAREST-Signature-Alg": sigToken,
    "X-WAREST-Timestamp": String(body.ts),
    "X-WAREST-Event": event,
    "X-WAREST-Event-Id": payload?.eventId || payload?.id || undefined,
    "X-WAREST-Session": sessionInfo.id || undefined,
    "X-WAREST-Registry": sessionInfo.registry || undefined,
    "X-WAREST-Label": sessionInfo.label || undefined,
    "X-WAREST-Username": sessionInfo.username || undefined,
    "X-WAREST-Version": "1",
  };

  const tasks = urls.map((target) =>
    deliverToTarget({
      target,
      json,
      baseHeaders,
      opts,
      body,
      sessionInfo,
      payload,
    })
  );
  const results =
    config.webhookOpts?.parallelTargets !== false
      ? await Promise.allSettled(tasks)
      : await sequential(tasks);

  const all = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const item = r.status === "fulfilled" ? r.value : null;
    if (!item) continue;
    const { response, actions, delayMs } = item;
    if (actions && actions.length) {
      const ctx = { ...body, ...payload };
      const delay = Number(delayMs || opts.delayMsActions);
      for (const raw of actions) {
        const action = renderDeep(raw, ctx);
        try {
          const isControl = await runEntry(
            sessionId || payload?.sessionId,
            action,
            opts
          );
          if (!isControl) await sleep(delay);
        } catch (e) {
          logger.warn({ action, err: e?.message }, "webhook action failed");
        }
      }
    }
    all.push({ target: urls[i], status: response?.status, ok: true });
  }
  return all;
}

async function sequential(promises) {
  const out = [];
  for (const p of promises) out.push(await p);
  return out.map((v) => ({ status: "fulfilled", value: v }));
}

async function deliverToTarget({
  target,
  json,
  baseHeaders,
  opts,
  body,
  sessionInfo,
  payload,
}) {
  if (isCircuitOpen(target)) {
    logger.warn({ target }, "webhook circuit open, skip");
    return { target, skipped: true };
  }
  let attempt = 0,
    delivered = false,
    lastErr = null,
    lastResp = null;
  while (attempt <= opts.retries && !delivered) {
    attempt++;
    try {
      const resp = await axios.post(target, json, {
        headers: {
          ...baseHeaders,
          "X-WAREST-Delivery-Attempt": String(attempt),
        },
        timeout: opts.timeout,
        validateStatus: () => true,
      });

      lastResp = resp;
      if (resp.status >= 200 && resp.status < 300) {
        markCircuit(target, true);
        delivered = true;
        const actions = resp?.data?.actions;
        const delayMs = resp?.data?.delayMs;
        return {
          response: resp,
          actions: Array.isArray(actions) ? actions : [],
          delayMs,
        };
      }

      // treat as error for non-2xx
      const err = new Error(`HTTP ${resp.status}`);
      err.response = resp;
      throw err;
    } catch (err) {
      lastErr = err;
      const code = err?.response?.status;
      const retry = isRetryable(err);
      if (
        (code === 404 || code === 410) &&
        (sessionInfo.id || payload?.sessionId)
      ) {
        try {
          const sid = sessionInfo.id || payload?.sessionId;
          const meta = getSessionMeta(sid) || {};
          if (
            meta.webhookUrl &&
            String(meta.webhookUrl).trim() === String(target).trim()
          ) {
            const ensured =
              ensureSecretPresent(sid) || meta.webhookSecret || "";
            upsertSessionMeta({
              id: sid,
              webhookUrl: "",
              webhookSecret: ensured,
            });
            await clearSessionWebhook(sid);
            logger.warn(
              { sid, target },
              "Webhook URL cleared (set NULL) due to 404/410 response; secret preserved/generated"
            );
          }
        } catch {}
      }
      if (code === 401 || code === 403) {
        markSecurityOpen(target, 15);
        logger.warn(
          { target, attempt, code },
          "Webhook blocked: security verification failed (401/403)"
        );
      } else {
        markCircuit(target, false);
        logger.warn(
          { target, attempt, code, err: err?.message },
          "Webhook deliver failed"
        );
      }
      if (!retry || attempt > opts.retries) break;
      const wait = jittered(
        opts.backoffMs * Math.pow(2, attempt - 1),
        opts.jitter
      );
      await sleep(wait);
    }
  }

  if (!delivered) {
    logger.warn({ target }, "Webhook permanently failed");
    try {
      const sid = sessionInfo.id || payload?.sessionId;
      if (sid) {
        const meta = getSessionMeta(sid) || {};
        const ensured = ensureSecretPresent(sid) || meta.webhookSecret || "";
        upsertSessionMeta({ id: sid, webhookUrl: "", webhookSecret: ensured });
        await clearSessionWebhook(sid);
      }
    } catch {}
  }
  return { response: lastResp, error: lastErr };
}

/**
 * Preflight: quick verification to check URL reachability and signature acceptance.
 * Sends minimal body and expects 2xx.
 */
export async function preflightWebhook({
  url,
  secret,
  sessionId,
  options = {},
}) {
  const urls = pickArray(url);
  if (!urls.length) return [];
  const secrets = pickArray(secret);
  const mainSecret = secrets[0] || "";
  const s = sessionId ? getSession(sessionId) : null;
  const meta = sessionId ? getSessionMeta(sessionId) : null;
  const sessionInfo = {
    id: sessionId || null,
    label: s?.label || meta?.label || null,
    registry: s?.ownerId || meta?.ownerId || null,
    username: null,
  };
  try {
    if (sessionInfo.registry) {
      const u = await findUserByRegistry(sessionInfo.registry);
      sessionInfo.username = u?.username || null;
    }
  } catch {}
  const body = {
    event: "preflight",
    data: { ping: true },
    ts: Date.now(),
    session: sessionInfo,
  };
  const json = JSON.stringify(body);
  const combinedKey =
    String(mainSecret || "") + String(sessionInfo.username || "");
  const opts = { ...config.webhookOpts, ...options };
  const algo = algoFromEnv(opts.signatureSha2 || "256", "sha256");
  const sigHex = hmacHex(json, combinedKey, algo);
  const sigToken = algoToHeaderToken(algo);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `WAREst/1 (preflight) Node/${process.version}`,
    "X-WAREST-Preflight": "1",
    "X-WAREST-Signature": `${sigToken}=${sigHex}`,
    "X-WAREST-Signature-Alg": sigToken,
    "X-WAREST-Timestamp": String(body.ts),
    "X-WAREST-Event": "preflight",
    "X-WAREST-Session": sessionInfo.id || undefined,
    "X-WAREST-Registry": sessionInfo.registry || undefined,
    "X-WAREST-Label": sessionInfo.label || undefined,
    "X-WAREST-Username": sessionInfo.username || undefined,
    "X-WAREST-Version": "1",
  };
  const tasks = urls.map(async (target) => {
    const t0 = Date.now();
    try {
      const resp = await axios.post(target, json, {
        headers,
        timeout: opts.preflightTimeoutMs || 5000,
        validateStatus: () => true,
      });
      const ms = Date.now() - t0;
      const ok = resp.status >= 200 && resp.status < 300;
      return { target, ok, status: resp.status, roundTripMs: ms };
    } catch (e) {
      const ms = Date.now() - t0;
      return { target, ok: false, error: e?.message, roundTripMs: ms };
    }
  });
  return Promise.all(tasks);
}

async function transcodeWithFfmpeg(buffer, opts = {}, mediaType = "video") {
  const { default: ffmpegPath } = await import("ffmpeg-static");
  const { default: Ffmpeg } = await import("fluent-ffmpeg");
  if (ffmpegPath) Ffmpeg.setFfmpegPath(ffmpegPath);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "warest-"));
  const inFile = path.join(tmp, `in-${Date.now()}.bin`);
  const outExt = (
    opts.format || (mediaType === "audio" ? "mp3" : "mp4")
  ).replace(/^\./, "");
  const outFile = path.join(tmp, `out-${Date.now()}.${outExt}`);
  await fs.writeFile(inFile, buffer);
  await new Promise((resolve, reject) => {
    let cmd = Ffmpeg(inFile);
    if (opts.preset) cmd = cmd.preset(opts.preset);
    if (opts.audioBitrate) cmd = cmd.audioBitrate(String(opts.audioBitrate));
    if (opts.videoBitrate) cmd = cmd.videoBitrate(String(opts.videoBitrate));
    if (Array.isArray(opts.extraArgs)) cmd = cmd.addOptions(opts.extraArgs);
    cmd.output(outFile).on("end", resolve).on("error", reject).run();
  });
  const outBuf = await fs.readFile(outFile);
  try {
    await fs.unlink(inFile);
    await fs.unlink(outFile);
    await fs.rmdir(tmp);
  } catch {}
  const mime = mediaType === "audio" ? `audio/${outExt}` : `video/${outExt}`;
  return { buffer: outBuf, mime };
}
