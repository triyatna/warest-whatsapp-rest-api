import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  getDevice,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { ulid } from "ulid";
import { isBoom } from "@hapi/boom";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { logger as appLogger } from "../logger.js";
import {
  cachePushName,
  toSWhatsAppUserJid,
  chooseNormalizedUserJid,
} from "./profile.js";
import { postWebhook } from "../services/webhook.js";
import { SimpleQueue } from "../utils/queue.js";
import {
  upsertSessionMeta,
  listSessionMeta,
  getSessionMeta,
  notifySessionsChanged,
} from "./sessionRegistry.js";
import { config } from "../config.js";
import {
  extractTextObject,
  extractQuotedTextObject,
  getSenderInfo,
  getMentions,
  extractMediaInfo,
  parseCommand,
  isIgnorableJid,
  guessMediaExtension,
  unwrapMessage,
} from "./message-utils.js";
import { upsertSession as upsertSessionRecord } from "../database/models/sessionRepo.js";
import { createStoreManager } from "./storeManager.js";
import { storage } from "../drivers/storage.js";
import { createCacheStore } from "../drivers/cache.js";
import pkg from "../../package.json" with { type: "json" };
import QRCode from "qrcode";
import {
  acquireProxyAgent,
  releaseProxy,
  reportProxyFailure,
  reportProxySuccess,
} from "./proxyManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sessions = new Map();
const creatingInFlight = new Map();
const qrCache = createCacheStore({
  namespace: "whatsapp:qr",
  ttlSeconds: 60,
  name: "qr-cache",
});
const qrImageDataCache = new Map();
const qrTiming = new Map();
const pairingCodeCache = createCacheStore({
  namespace: "whatsapp:pairing",
  ttlSeconds: 65,
  name: "pairing-cache",
});
const versionCache = createCacheStore({
  namespace: "whatsapp:baileys-version",
  ttlSeconds: 6 * 3600,
  name: "baileys-version",
});
const sessionsListCache = createCacheStore({
  namespace: "whatsapp:sessions",
  ttlSeconds: 2,
  name: "sessions-list",
});
const SESSIONS_LIST_KEY = "all";

const isDev = (config?.env || "").toLowerCase() === "development";
const logger = appLogger.child(
  { module: "WARESTbClient" },
  { level: isDev ? "debug" : "warn" }
);
logger.info(`Environment: ${isDev}`);
const normalizeMimeType = (mimeType) => {
  if (!mimeType) return "";
  return String(mimeType).split(";")[0].trim().toLowerCase();
};

const matchesMimePattern = (pattern, candidate) => {
  if (!pattern || !candidate) return false;
  if (pattern === "*/*" || pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -1);
    return candidate.startsWith(base);
  }
  return pattern === candidate;
};

function guardIncomingMediaMime(media = {}, msg = {}, sctx = {}) {
  const normalized = normalizeMimeType(media?.mimeType);
  const allowed = config?.download?.allowedMimeTypes || [];
  if (!allowed.length) {
    return { allowed: true, mimeType: normalized || undefined };
  }
  if (!normalized) {
    logger.warn(
      {
        sessionId: sctx?.id,
        messageId: msg?.key?.id,
        reason: "missing_mime_type",
      },
      "incoming media skipped: MIME type missing"
    );
    return { allowed: false };
  }
  const ok = allowed.some((pattern) => matchesMimePattern(pattern, normalized));
  if (!ok) {
    logger.warn(
      {
        sessionId: sctx?.id,
        messageId: msg?.key?.id,
        mimeType: normalized,
        reason: "disallowed_mime_type",
      },
      "incoming media skipped: MIME type not allowed by configuration"
    );
    return { allowed: false };
  }
  return { allowed: true, mimeType: normalized };
}

const jitter = (ms) => Math.floor(ms * (0.8 + Math.random() * 0.4));

function mapContentTypeToTag(ctype) {
  const s = String(ctype || "").trim();
  switch (s) {
    case "conversation":
      return "text";
    case "extendedTextMessage":
      return "extended_text";
    case "pinInChatMessage":
      return "pin";
    case "interactiveResponseMessage":
    case "buttonsResponseMessage":
    case "listResponseMessage":
    case "templateButtonReplyMessage":
      return "interactive";
    case "imageMessage":
    case "videoMessage":
      return "media";
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3":
    case "pollUpdateMessage":
    case "pollUpdateMessageV2":
      return "poll";
    case "eventMessage":
      return "event";
    case "orderMessage":
      return "order";
    case "productMessage":
      return "product";
    case "documentMessage":
      return "file";
    case "audioMessage":
      return "audio";
    case "stickerMessage":
      return "sticker";
    case "locationMessage":
    case "liveLocationMessage":
      return "location";
    case "groupInviteMessage":
      return "group_invite";
    case "requestPaymentMessage":
    case "paymentInviteMessage":
      return "payment";
    case "protocolMessage":
    case "senderKeyDistributionMessage":
      return "system";
    case "contactsArrayMessage":
      return "contacts";
    case "contactMessage":
      return "contact";
    case "reactionMessage":
      return "reaction";
    default: {
      const lc = s.toLowerCase();
      if (lc.includes("extendedtext")) return "extended_text";
      if (lc.includes("pin")) return "pin";
      if (lc.includes("poll")) return "poll";
      if (lc.includes("event")) return "event";
      if (
        lc.includes("interactive") ||
        lc.includes("button") ||
        lc.includes("list")
      )
        return "interactive";
      if (lc.includes("image") || lc.includes("video")) return "media";
      if (lc.includes("document") || lc.includes("file")) return "file";
      if (lc.includes("audio") || lc.includes("ptt")) return "audio";
      if (lc.includes("sticker")) return "sticker";
      if (lc.includes("location")) return "location";
      if (lc.includes("contactsarray")) return "contacts";
      if (lc.includes("contact")) return "contact";
      if (lc.includes("group") && lc.includes("invite")) return "group_invite";
      if (lc.includes("payment")) return "payment";
      if (lc.includes("protocol") || lc.includes("senderkey")) return "system";
      if (lc.includes("order")) return "order";
      if (lc.includes("product")) return "product";
      if (lc.includes("reaction")) return "reaction";
      return "system";
    }
  }
}

const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;
const digitsOnly = (value) => String(value || "").replace(/\D+/g, "");
const looksLikeMsisdn = (digits) =>
  typeof digits === "string" &&
  digits.length >= MIN_PHONE_DIGITS &&
  digits.length <= MAX_PHONE_DIGITS &&
  !digits.startsWith("0");
const stripDeviceFromJid = (jid) => {
  const raw = String(jid || "").trim();
  const at = raw.indexOf("@");
  if (at === -1) return raw;
  const local = raw.slice(0, at);
  const server = raw.slice(at + 1);
  const cleanLocal = local.includes(":") ? local.split(":")[0] : local;
  return `${cleanLocal}@${server}`;
};
const normalizeDigitsCandidate = (raw) => {
  let digits = digitsOnly(raw);
  if (!digits) return null;
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith("8")) digits = `62${digits}`;
  return looksLikeMsisdn(digits) ? digits : null;
};

function canonicalizeUserJidLike(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  if (
    /@g\.us$/i.test(trimmed) ||
    /@newsletter$/i.test(trimmed) ||
    trimmed === "status@broadcast"
  )
    return null;
  const replaced = stripDeviceFromJid(
    trimmed.replace(/@c\.us$/i, "@s.whatsapp.net")
  );
  if (!/@s\.whatsapp\.net$/i.test(replaced)) return null;
  const local = replaced.split("@")[0];
  const digits = normalizeDigitsCandidate(local);
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function canonicalizeLid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/@lid$/i.test(raw)) return raw;
  const withoutDomain = raw.slice(0, raw.toLowerCase().lastIndexOf("@lid"));
  const clean = withoutDomain.includes(":")
    ? withoutDomain.split(":")[0]
    : withoutDomain;
  return `${clean}@lid`;
}

function getSessionLidCache(sctx) {
  if (!sctx) return new Map();
  if (!sctx.__lidToJidCache) sctx.__lidToJidCache = new Map();
  return sctx.__lidToJidCache;
}

function findContactJidByLid(target, sctx) {
  if (!target || !sctx?.sock) return null;
  const contacts = sctx.sock.store?.contacts || sctx.sock.contacts || null;
  if (!contacts) return null;
  const cache = getSessionLidCache(sctx);
  const ingest = (contact) => {
    if (!contact) return null;
    const lid = canonicalizeLid(contact.lid || contact.lidJid || "");
    const jid = canonicalizeUserJidLike(contact.id || contact.jid);
    if (lid && jid && !cache.has(lid)) cache.set(lid, jid);
    if (lid && lid === target && jid) return jid;
    return null;
  };
  if (contacts instanceof Map) {
    for (const contact of contacts.values()) {
      const hit = ingest(contact);
      if (hit) return hit;
    }
  } else if (contacts && typeof contacts === "object") {
    for (const contact of Object.values(contacts)) {
      const hit = ingest(contact);
      if (hit) return hit;
    }
  }
  return null;
}

function resolveLidToUserJid(lid, sctx) {
  if (!lid || !sctx) return null;
  const cache = getSessionLidCache(sctx);
  const canonical = canonicalizeLid(lid);
  const candidates = [lid, canonical].filter(Boolean);
  for (const key of candidates) {
    if (cache.has(key)) return cache.get(key);
  }
  const resolved = findContactJidByLid(canonical, sctx);
  for (const key of candidates) {
    if (key && !cache.has(key)) cache.set(key, resolved || null);
  }
  return resolved || null;
}

function normalizeUserJidFromAny(value, sctx) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/status@broadcast/i.test(raw) || /@g\.us$/i.test(raw)) return null;
  if (/@lid$/i.test(raw)) return resolveLidToUserJid(raw, sctx);
  const canonical = canonicalizeUserJidLike(raw);
  if (canonical) return canonical;
  const digits = normalizeDigitsCandidate(raw);
  if (digits) return `${digits}@s.whatsapp.net`;
  return null;
}

function getGroupParticipantCache(sctx) {
  if (!sctx) return new Map();
  if (!sctx.__groupParticipantCache) sctx.__groupParticipantCache = new Map();
  return sctx.__groupParticipantCache;
}

function getGroupParticipantInflightCache(sctx) {
  if (!sctx) return new Map();
  if (!sctx.__groupParticipantInflightCache)
    sctx.__groupParticipantInflightCache = new Map();
  return sctx.__groupParticipantInflightCache;
}

async function buildGroupParticipantMap(chatId, sctx) {
  if (!chatId || !chatId.endsWith("@g.us") || !sctx?.sock?.groupMetadata)
    return new Map();
  try {
    const meta = await sctx.sock.groupMetadata(chatId);
    const map = new Map();
    for (const participant of meta?.participants || []) {
      const lid = canonicalizeLid(
        participant?.lid || participant?.jid || participant?.id || ""
      );
      const jid =
        canonicalizeUserJidLike(
          participant?.jid || participant?.id || participant?.user
        ) || null;
      if (lid && jid) map.set(lid, jid);
    }
    return map;
  } catch (err) {
    logger.warn(
      { chatId, err: err?.message },
      "[mentions] groupMetadata lookup failed"
    );
    return new Map();
  }
}

async function getGroupParticipantMap(chatId, sctx) {
  if (!chatId || !chatId.endsWith("@g.us") || !sctx) return null;
  const ttlMs = 60_000;
  const cache = getGroupParticipantCache(sctx);
  const now = Date.now();
  const cached = cache.get(chatId);
  if (cached && now - cached.ts < ttlMs) return cached.map;
  const inflight = getGroupParticipantInflightCache(sctx);
  if (!inflight.has(chatId)) {
    inflight.set(
      chatId,
      (async () => {
        try {
          const map = await buildGroupParticipantMap(chatId, sctx);
          cache.set(chatId, { map, ts: Date.now() });
          return map;
        } finally {
          inflight.delete(chatId);
        }
      })()
    );
  }
  return inflight.get(chatId);
}

async function normalizeMentionEntities(list, sctx, opts = {}) {
  const arr = Array.isArray(list) ? list : [];
  const mentions = [];
  const replacements = new Map();
  const seen = new Set();
  const chatId = String(opts.chatId || "").trim();
  let groupMapPromise = null;
  const getGroupMap = async () => {
    if (!chatId.endsWith("@g.us")) return null;
    if (!groupMapPromise) {
      groupMapPromise = getGroupParticipantMap(chatId, sctx).catch(() => null);
    }
    return groupMapPromise;
  };
  for (const raw of arr) {
    let jid = normalizeUserJidFromAny(raw, sctx);
    if (!jid && typeof raw === "string" && /@lid$/i.test(raw)) {
      const map = await getGroupMap();
      const maybe = map?.get(canonicalizeLid(raw));
      if (maybe) jid = maybe;
    }
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    mentions.push(jid);
    const rawLocal = String(raw || "").split("@")[0] || "";
    const normLocal = String(jid || "").split("@")[0] || "";
    if (rawLocal && normLocal && rawLocal !== normLocal) {
      if (!replacements.has(rawLocal)) replacements.set(rawLocal, normLocal);
      const rawWithDomain = `${rawLocal}@lid`;
      const normWithDomain = `${normLocal}@s.whatsapp.net`;
      if (!replacements.has(rawWithDomain))
        replacements.set(rawWithDomain, normWithDomain);
    }
  }
  return { mentions, replacements };
}

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function applyMentionReplacements(text, replacements) {
  if (typeof text !== "string" || !replacements || !replacements.size) {
    return text;
  }
  let out = text;
  for (const [needle, replacement] of replacements.entries()) {
    if (!needle || !replacement || needle === replacement) continue;
    const pattern = new RegExp(`@${escapeRegex(needle)}`, "g");
    out = out.replace(pattern, `@${replacement}`);
  }
  return out;
}

function isRegisteredCommand(cmd) {
  try {
    const list = Array.isArray(config?.commands?.names)
      ? config.commands.names
      : Array.isArray(config?.commands)
      ? config.commands
      : [];
    return list
      .map((x) => String(x || "").toLowerCase())
      .includes(String(cmd || "").toLowerCase());
  } catch {
    return false;
  }
}

async function getBaileysVersionCached() {
  const cached = await versionCache.get("baileys_version");
  if (cached) return cached;
  const out = await fetchLatestBaileysVersion().catch(() => ({
    version: undefined,
  }));
  const version = out?.version || pkg.version;
  if (version) {
    await versionCache.set("baileys_version", version, 6 * 3600);
  }
  return version;
}

async function invalidateSessionsCache() {
  try {
    await sessionsListCache.delete(SESSIONS_LIST_KEY);
  } catch (err) {
    logger.warn({ err: err?.message }, "failed to invalidate sessions cache");
  }
}

function rememberQrDataUrl(raw, dataUrl) {
  if (!raw || !dataUrl) return;
  try {
    const key = raw;
    if (qrImageDataCache.has(key)) {
      clearTimeout(qrImageDataCache.get(key)?.timer);
    }
    const timer = setTimeout(() => {
      qrImageDataCache.delete(key);
    }, 60_000);
    timer.unref?.();
    qrImageDataCache.set(key, { dataUrl, timer });
  } catch {}
}

async function buildQrDataUrl(raw) {
  if (!raw || typeof raw !== "string" || raw.length < 8) return null;
  const cached = qrImageDataCache.get(raw);
  if (cached?.dataUrl) return cached.dataUrl;
  try {
    const buf = await QRCode.toBuffer(raw, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    rememberQrDataUrl(raw, dataUrl);
    return dataUrl;
  } catch (err) {
    logger.warn({ err: err?.message }, "qr data url encoding failed");
    return null;
  }
}

function slugifyLabel(s) {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "session"
  );
}

const ABSOLUTE_URL_REGEX = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
let cachedPublicBaseUrl = null;

function computePublicBaseUrl() {
  const configured = String(config?.publicUrl || "").trim();
  const tryNormalize = (value) => {
    if (!value) return null;
    try {
      const parsed = new URL(value);
      if (!parsed.pathname) parsed.pathname = "/";
      if (!parsed.pathname.endsWith("/"))
        parsed.pathname = `${parsed.pathname}/`;
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return null;
    }
  };
  if (configured) {
    const candidates = [configured];
    if (!/^https?:\/\//i.test(configured)) {
      candidates.push(`https://${configured}`);
      candidates.push(`http://${configured}`);
    }
    for (const candidate of candidates) {
      const normalized = tryNormalize(candidate);
      if (normalized) return normalized;
    }
  }
  const host = String(config?.host || "localhost").trim() || "localhost";
  const normalizedHost = ["0.0.0.0", "::", "[::]"].includes(host)
    ? "localhost"
    : host;
  const port = Number(config?.port || 0);
  const scheme = port === 443 ? "https" : "http";
  const portPart =
    port &&
    !(
      (scheme === "http" && port === 80) ||
      (scheme === "https" && port === 443)
    )
      ? `:${port}`
      : "";
  return `${scheme}://${normalizedHost}${portPart}/`;
}

function getPublicBaseUrl() {
  if (!cachedPublicBaseUrl) {
    cachedPublicBaseUrl = computePublicBaseUrl();
  }
  return cachedPublicBaseUrl;
}

function ensureAbsoluteUrl(value) {
  const str = String(value || "").trim();
  if (!str) return str;
  if (ABSOLUTE_URL_REGEX.test(str)) {
    if (str.startsWith("http://local")) {
      try {
        const parsed = new URL(str);
        const relative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        return new URL(relative, getPublicBaseUrl()).toString();
      } catch {
        return str;
      }
    }
    return str;
  }
  try {
    return new URL(str, getPublicBaseUrl()).toString();
  } catch {
    return str;
  }
}

function scrubMediaForWebhook(media) {
  if (!media) return media;
  const { rawUrl, cleanUrl, ...rest } = media;
  return rest;
}

function safeHexFromBase64(input) {
  try {
    return Buffer.from(String(input || ""), "base64").toString("hex");
  } catch {
    return null;
  }
}

const MEDIA_NODES_ALLOWING_STORAGE = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "ptvMessage",
]);

function applyStorageMetadataToMessage(msg, type, payload = {}) {
  try {
    if (!payload || !MEDIA_NODES_ALLOWING_STORAGE.has(type)) return false;
    const unwrapped = unwrapMessage(msg) || msg?.message || {};
    const node = unwrapped?.[type];
    if (!node || typeof node !== "object") return false;
    let changed = false;
    if (payload.urlDecrypt) {
      if (node.urlDecrypt !== payload.urlDecrypt) {
        node.urlDecrypt = payload.urlDecrypt;
        changed = true;
      }
      if (node.url !== payload.urlDecrypt) {
        node.url = payload.urlDecrypt;
        changed = true;
      }
      if (node.directPath) {
        delete node.directPath;
        changed = true;
      }
    }
    if (payload.storageKey && node.storageKey !== payload.storageKey) {
      node.storageKey = payload.storageKey;
      changed = true;
    }
    if (payload.storageDriver && node.storageDriver !== payload.storageDriver) {
      node.storageDriver = payload.storageDriver;
      changed = true;
    }
    return changed;
  } catch {
    return false;
  }
}

async function persistIncomingMediaToStorage(msg, media, sctx, sock) {
  const mimeDecision = guardIncomingMediaMime(media, msg, sctx);
  if (!mimeDecision.allowed) {
    return null;
  }
  const sanitizedMime =
    mimeDecision.mimeType || normalizeMimeType(media?.mimeType);
  if (sanitizedMime && media) {
    media.mimeType = sanitizedMime;
  } else if (media && !sanitizedMime) {
    delete media.mimeType;
  }

  let stream;
  try {
    stream = await downloadMediaMessage(
      msg,
      "stream",
      {},
      { logger, reuploadRequest: sock?.updateMediaMessage }
    );
  } catch (err) {
    logger.error(
      { err: err?.message, id: sctx?.id, messageId: msg?.key?.id },
      "failed to download incoming media stream"
    );
    return null;
  }

  const extension = guessMediaExtension(media) || "bin";
  const shaHex = media?.fileSha256 ? safeHexFromBase64(media.fileSha256) : null;
  const baseName = shaHex || ulid().toLowerCase();
  const filename = extension ? `${baseName}.${extension}` : baseName;
  const directory = [
    "incoming-media",
    sctx?.id || "unknown",
    media?.type || "unknown",
  ];

  try {
    const saved = await storage.save(stream, {
      directory,
      filename,
      metadata: {
        sessionId: sctx?.id,
        chatId: msg?.key?.remoteJid || "",
        messageId: msg?.key?.id || "",
        type: media?.type || "",
      },
      originalName: media?.fileName || undefined,
      mimeType: media?.mimeType || undefined,
    });

    const driverName =
      String(
        saved?.metadata?.driver || config?.storage?.driver || ""
      ).toLowerCase() || null;

    let storageUrl = saved?.url ? ensureAbsoluteUrl(saved.url) : null;
    if (!storageUrl) {
      try {
        const signedOpts = {};
        if (driverName === "local") {
          const signedPath =
            config?.storage?.local?.signedUrl?.path || "/storage/signed";
          const normalizedPath = signedPath.startsWith("/")
            ? signedPath
            : `/${signedPath}`;
          signedOpts.baseUrl = new URL(normalizedPath, getPublicBaseUrl())
            .toString()
            .replace(/\/+$/, "");
        }
        const signed = await storage.signedUrl(saved.key, signedOpts);
        storageUrl = signed?.url || null;
      } catch {}
    }

    if (storageUrl) {
      storageUrl = ensureAbsoluteUrl(storageUrl);
    }

    const resolvedDriver =
      saved?.metadata?.driver || config?.storage?.driver || null;

    if (!storageUrl) {
      logger.warn(
        { key: saved?.key, id: sctx?.id },
        "stored incoming media but no accessible URL available"
      );
      return {
        storageKey: saved?.key,
        storageDriver: resolvedDriver,
      };
    }

    return {
      storageUrl,
      storageKey: saved?.key,
      storageDriver: resolvedDriver,
    };
  } catch (err) {
    logger.error(
      { err: err?.message, id: sctx?.id, messageId: msg?.key?.id },
      "failed to persist incoming media"
    );
    return null;
  } finally {
    try {
      stream?.destroy?.();
    } catch {}
  }
}

function authDirOf(id) {
  const meta = getSessionMeta(id) || {};
  const newBase = path.resolve(
    __dirname,
    "../../data/private/credentials/session"
  );
  const persisted = meta.credentialsPath;
  if (persisted && typeof persisted === "string") {
    try {
      if (fs.existsSync(persisted)) return persisted;
    } catch {}
  }
  const owner = meta.ownerId || "unknown";
  const label = slugifyLabel(meta.label || id);
  const desiredPath = path.resolve(newBase, `session_${owner}_${label}`);
  try {
    fs.mkdirSync(newBase, { recursive: true });
  } catch {}
  try {
    if (fs.existsSync(desiredPath)) return desiredPath;
  } catch {}
  return desiredPath;
}

async function purgeCreds(id) {
  try {
    const dir = authDirOf(id);
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
export { purgeCreds };

function shouldEmit(tag) {
  try {
    const allowed = new Set([
      "session_status",
      "message_received",
      "message_reaction",
      "message_command",
      "message_edited",
      "message_revoked",
      "group_join",
      "group_leave",
      "group_update",
      "group_participants",
      "presence_update",
      "creds_update",
      "call",
    ]);
    return allowed.has(String(tag));
  } catch {
    return false;
  }
}
async function emitWebhook(tag, event, payload, sctx) {
  if (!shouldEmit(tag)) return;
  const url = sctx?.webhook?.url || config?.webhookDefault?.url || "";
  const secret = sctx?.webhook?.secret || config?.webhookDefault?.secret || "";
  if (!url) return;
  await postWebhook({
    url,
    secret,
    event,
    payload: { ...payload, sessionId: sctx?.id },
    sessionId: sctx?.id,
    options: config.webhookOpts,
  }).catch(() => {});
}

export async function listSessions() {
  return sessionsListCache.remember(SESSIONS_LIST_KEY, async () => {
    const metas = new Map(listSessionMeta().map((m) => [m.id, m]));
    const merged = new Map();

    for (const [id, m] of metas.entries()) {
      merged.set(id, {
        id,
        status: "stopped",
        label: m.label || id,
        autoStart: m.autoStart !== false,
        webhookUrl: m.webhookUrl || "",
        webhookSecret: m.webhookSecret || "",
        createdAt: m.createdAt,
        attempts: 0,
      });
    }
    for (const [id, s] of sessions.entries()) {
      const m = metas.get(id) || {};
      merged.set(id, {
        id,
        status: s.status || "starting",
        me: s.me,
        pushName: s.pushName,
        lastConn: s.lastConn,
        label: m.label || id,
        autoStart: m.autoStart !== false,
        webhookUrl: m.webhookUrl || "",
        webhookSecret: m.webhookSecret || "",
        createdAt: m.createdAt,
        attempts: s.attempts || 0,
      });
    }
    return [...merged.values()].sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
    );
  });
}

export function getSession(id) {
  return sessions.get(id);
}
export function getCachedMessage(sessionId, messageId) {
  try {
    const s = sessions.get(sessionId);
    if (!s || !messageId) return null;
    const id = String(messageId || "").trim();
    return s.msgCache?.get(id) || null;
  } catch {
    return null;
  }
}
export async function getQR(id) {
  const cached = await qrCache.get(id);
  return cached ?? null;
}
export function getQrTtlHint(id) {
  try {
    const t = qrTiming.get(id);
    return Math.max(5, Math.min(65, Number(t?.lastTtl || 20)));
  } catch {
    return 20;
  }
}
function normalizePhoneForPairing(v) {
  return String(v || "").replace(/\D+/g, "");
}
function pairKey(id, phone) {
  return `${String(id || "").trim()}:${normalizePhoneForPairing(phone)}`;
}
export async function getPairingCode(id, phone) {
  if (!phone) return null;
  const cached = await pairingCodeCache.get(pairKey(id, phone));
  return cached ?? null;
}

/** Create + Start session */
export async function createSession({
  id,
  socketServer,
  webhook,
  label,
  autoStart = true,
  ownerId,
  allowAutoId = false,
  pairing,
}) {
  if (!id && !allowAutoId) throw new Error("Session id is required");
  const sessId = id || ulid();
  if (sessions.has(sessId)) return sessions.get(sessId);
  if (creatingInFlight.has(sessId)) return creatingInFlight.get(sessId);

  const meta = upsertSessionMeta({
    id: sessId,
    label,
    webhookUrl: webhook?.url || "",
    webhookSecret: webhook?.secret || "",
    autoStart,
    ownerId,
  });

  const authDir = authDirOf(sessId);
  try {
    await upsertSessionRecord?.({
      id: sessId,
      registry_user: meta.ownerId || "",
      label: meta.label || null,
      credentials_path: authDir,
    });
    upsertSessionMeta({ id: sessId, credentialsPath: authDir });
  } catch {}

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await getBaileysVersionCached();

  const sctx = {
    id: sessId,
    status: "starting",
    me: null,
    pushName: null,
    lastConn: null,
    ownerId: meta.ownerId,
    label: meta.label || sessId,
    autoStart: meta.autoStart !== false,
    webhook: { url: meta.webhookUrl, secret: meta.webhookSecret },
    queue: new SimpleQueue({
      ...config.queue,
    }),
    attempts: 0,
    timer: null,
    sock: null,
    store: createStoreManager({ sessionId: sessId }),
    msgCache: new Map(),
    state,
    saveCreds,
    version,
    socketServer,
    pairing: pairing?.phone
      ? { phone: normalizePhoneForPairing(pairing.phone) }
      : null,
  };

  const p = (async () => {
    sessions.set(sessId, sctx);
    await invalidateSessionsCache();
    try {
      notifySessionsChanged(sctx.ownerId || null);
    } catch {}
    try {
      await emitWebhook(
        "session_status",
        "session_status",
        { id: sctx.id, tags: "create" },
        sctx
      );
    } catch {}
    try {
      await startSocket(sctx);
      return sctx;
    } finally {
      creatingInFlight.delete(sessId);
    }
  })();
  creatingInFlight.set(sessId, p);
  return p;
}

export async function deleteSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try {
    try {
      s.socketServer?.to(id).emit("closed", { id, reason: "manual_stop" });
    } catch {}
    try {
      await emitWebhook(
        "session_status",
        "session_status",
        { id, tags: "close" },
        s
      );
    } catch {}
    if (s.timer) clearTimeout(s.timer);
    s.sock?.ev?.removeAllListeners?.();
    await s.sock?.end?.();
  } catch {}
  try {
    s.store?.dispose?.();
  } catch {}
  sessions.delete(id);
  releaseProxy(id);
  await qrCache.delete(id);
  await invalidateSessionsCache();
  try {
    notifySessionsChanged(s?.ownerId || null);
  } catch {}
  return true;
}

export async function bootstrapSessions(socketServer) {
  const metas = listSessionMeta();
  for (const m of metas) {
    if (m.autoStart === false) continue;
    try {
      await createSession({
        id: m.id,
        socketServer,
        webhook: { url: m.webhookUrl, secret: m.webhookSecret },
        label: m.label,
        autoStart: true,
        ownerId: m.ownerId,
      });
    } catch (e) {
      appLogger.error({ err: e, id: m.id }, "[bootstrap] create failed");
    }
  }
}

async function startSocket(sctx) {
  if (sctx.timer) {
    clearTimeout(sctx.timer);
    sctx.timer = null;
  }
  sctx.sock?.ev?.removeAllListeners?.();

  const proxyAssignment = acquireProxyAgent(sctx.id);
  if (proxyAssignment?.url) {
    logger.debug(
      { class: "baileys", id: sctx.id, proxy: proxyAssignment.display },
      "selected proxy"
    );
  }
  const sock = makeWASocket({
    version: sctx.version,
    auth: sctx.state,
    printQRInTerminal: false,
    browser: Browsers.macOS("Chrome"),
    syncFullHistory: true,
    connectTimeoutMs: 60_000,
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 120_000,
    emitOwnEvents: true,
    getMessage: async (key) => {
      try {
        const got = await sctx.store?.getMessage?.(key);
        return got || undefined;
      } catch {
        return undefined;
      }
    },
    agent: proxyAssignment?.agent,
    logger: logger,
  });
  sctx.proxyAssignment = proxyAssignment || null;

  sctx.sock = sock;
  try {
    sctx.store?.bind(sock.ev);
    sock.store = sctx.store;
  } catch {}

  const selfBareJid = () => {
    const raw = String(
      sock?.user?.id || sock?.user?.jid || sctx.me?.id || ""
    ).trim();
    if (!raw) return "";
    return stripDeviceFromJid(raw);
  };
  const matchSelfContact = (entries = []) => {
    const meJid = selfBareJid();
    if (!meJid) return null;
    for (const entry of entries) {
      if (!entry) continue;
      const candidates = [
        entry.jid,
        entry.id,
        entry.user,
        entry.wid,
        entry.waid,
        entry.lidJid,
      ];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const normalized =
          canonicalizeUserJidLike(candidate) ||
          (typeof candidate === "string" && candidate.includes("@")
            ? stripDeviceFromJid(candidate)
            : null);
        if (normalized && stripDeviceFromJid(normalized) === meJid) {
          return { meJid, contact: entry };
        }
      }
    }
    return null;
  };
  const extractContactName = (contact) => {
    const sources = [
      contact?.verifiedName,
      contact?.name,
      contact?.notify,
      contact?.pushName,
      contact?.pushname,
      contact?.shortName,
      contact?.displayName,
      contact?.fullName,
      contact?.formattedName,
    ];
    for (const value of sources) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
    }
    return null;
  };
  const syncSelfProfileFromContacts = async (entries = []) => {
    try {
      const hit = matchSelfContact(entries);
      if (!hit) return false;
      const nextName = extractContactName(hit.contact);
      if (!nextName) return false;
      if (nextName === sctx.pushName) return false;
      const meJid = hit.meJid;
      const mePhone = meJid.includes("@") ? meJid.split("@")[0] : meJid;
      sctx.pushName = nextName;
      const mergedMe = {
        ...(sctx.me || sock?.user || {}),
        id: meJid,
        jid: meJid,
        name: nextName,
      };
      sctx.me = mergedMe;
      if (sock?.user) sock.user.name = nextName;
      const meta = getSessionMeta(sctx.id) || {};
      const list = Array.isArray(meta.sessionProfile)
        ? [...meta.sessionProfile]
        : [];
      const idx = list.findIndex((entry) => {
        const jidMatch =
          typeof entry?.jid === "string" &&
          stripDeviceFromJid(entry.jid) === meJid;
        const phoneDigits = String(entry?.phone || "")
          .split("@")[0]
          .replace(/\D+/g, "");
        const meDigits = String(mePhone || "").replace(/\D+/g, "");
        const phoneMatch = phoneDigits && phoneDigits === meDigits;
        return jidMatch || phoneMatch;
      });
      const updatedEntry = {
        ...(idx >= 0 ? list[idx] : {}),
        pushname: nextName,
        phone: mePhone,
        jid: meJid,
      };
      if (idx >= 0) list[idx] = updatedEntry;
      else list.push(updatedEntry);
      upsertSessionMeta({ id: sctx.id, sessionProfile: list });
      await invalidateSessionsCache();
      return true;
    } catch (err) {
      logger.warn(
        { err: err?.message, id: sctx.id },
        "self contact sync failed"
      );
      return false;
    }
  };
  let selfProfileHydrationTimer = null;
  let selfProfileHydrationAttempts = 0;
  const stopSelfProfileHydration = () => {
    if (selfProfileHydrationTimer) {
      clearTimeout(selfProfileHydrationTimer);
      selfProfileHydrationTimer = null;
    }
  };
  const ensureSelfProfileHydration = () => {
    if (sctx.pushName) {
      stopSelfProfileHydration();
      return;
    }
    if (selfProfileHydrationTimer) return;
    selfProfileHydrationAttempts = 0;
    const run = async () => {
      if (sctx.pushName) {
        stopSelfProfileHydration();
        return;
      }
      if (selfProfileHydrationAttempts >= 20) {
        stopSelfProfileHydration();
        return;
      }
      selfProfileHydrationAttempts += 1;
      try {
        const src =
          sctx.store?.contacts ||
          sctx.sock?.store?.contacts ||
          sctx.sock?.contacts ||
          null;
        const arr =
          src instanceof Map
            ? [...src.values()]
            : Array.isArray(src)
            ? src
            : src && typeof src === "object"
            ? Object.values(src)
            : [];
        if (arr.length) {
          const ok = await syncSelfProfileFromContacts(arr);
          if (ok) {
            stopSelfProfileHydration();
            return;
          }
        }
      } catch {}
      selfProfileHydrationTimer = setTimeout(() => {
        selfProfileHydrationTimer = null;
        ensureSelfProfileHydration();
      }, 2000);
      selfProfileHydrationTimer.unref?.();
    };
    run();
  };
  const handleSelfContactPayload = (payload) => {
    const arr = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.contacts)
      ? payload.contacts
      : Array.isArray(payload?.contacts?.contacts)
      ? payload.contacts.contacts
      : [];
    if (!arr.length) {
      ensureSelfProfileHydration();
      return;
    }
    syncSelfProfileFromContacts(arr)
      .then((ok) => {
        if (ok) stopSelfProfileHydration();
        else ensureSelfProfileHydration();
      })
      .catch(() => ensureSelfProfileHydration());
  };

  ensureSelfProfileHydration();

  sock.ev.on("creds.update", async () => {
    await sctx.saveCreds();
    try {
      await emitWebhook("creds_update", "creds_update", { id: sctx.id }, sctx);
    } catch {}
  });
  sock.ev.on("messaging-history.set", async (m) => {
    try {
      logger.debug(
        {
          chats: m.chats.length,
          contacts: m.contacts.length,
          messages: m.messages.length,
          session: sctx.id,
        },
        "Received messaging history snapshot"
      );
    } catch {}
    handleSelfContactPayload(m?.contacts);
  });
  sock.ev.on("contacts.update", handleSelfContactPayload);
  sock.ev.on("contacts.upsert", handleSelfContactPayload);
  sock.ev.on("contacts.set", handleSelfContactPayload);
  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      await qrCache.set(sctx.id, qr, 60);
      const now = Date.now();
      const t = qrTiming.get(sctx.id) || { lastAt: 0, lastTtl: 20 };
      let ttl = t.lastTtl || 20;
      if (t.lastAt) {
        const delta = Math.max(1, Math.round((now - t.lastAt) / 1000));
        if (delta >= 5 && delta <= 65) ttl = delta;
      }
      qrTiming.set(sctx.id, { lastAt: now, lastTtl: ttl });
      let qrDataUrl = null;
      try {
        qrDataUrl = await buildQrDataUrl(qr);
      } catch {}
      const qrPayload = { id: sctx.id, qr, qrDuration: ttl };
      if (qrDataUrl) qrPayload.qrDataUrl = qrDataUrl;
      sctx.socketServer?.to(sctx.id).emit("qr", qrPayload);
      try {
        await emitWebhook(
          "session_status",
          "session_status",
          { id: sctx.id, tags: "qr", qr: qrDataUrl || qr, qrDuration: ttl },
          sctx
        );
      } catch {}
    }

    if (sctx.pairing?.phone && connection === "connecting") {
      try {
        const cacheKey = pairKey(sctx.id, sctx.pairing.phone);
        const existing = await pairingCodeCache.get(cacheKey);
        if (!existing) {
          const code = await sock.requestPairingCode(sctx.pairing.phone);
          sctx.socketServer
            ?.to(sctx.id)
            .emit("pairing_code", { id: sctx.id, code });
          await pairingCodeCache.set(cacheKey, code, 65);
        }
      } catch (e) {
        logger.error({ err: e?.message }, "requestPairingCode failed");
      }
    }

    if (connection === "connecting") {
      sctx.status = "connecting";
      try {
        await emitWebhook(
          "session_status",
          "session_status",
          { id: sctx.id, tags: "connecting" },
          sctx
        );
      } catch {}
    }

    if (connection === "open") {
      reportProxySuccess(sctx.id);
      sctx.attempts = 0;
      sctx.status = "open";
      sctx.me = sock.user;
      sctx.pushName = sock?.user?.name || null;
      sctx.lastConn = Date.now();
      try {
        sctx.store?.setSelfJid?.(sock?.user?.id || null);
        sctx.store?.purgeSelf?.();
        const meId = String(sock?.user?.id || "").trim();
        if (meId) {
          const prev = sctx.store?.contacts?.get?.(meId) || {};
          sctx.store?.contacts?.set?.(meId, {
            ...prev,
            id: meId,
            jid: meId,
            isMe: true,
            isMyContact: true,
            name: sock?.user?.name || prev.name || null,
            notify: sock?.user?.name || prev.notify || null,
          });
        }
      } catch {}
      await qrCache.delete(sctx.id);
      await invalidateSessionsCache();
      try {
        notifySessionsChanged(sctx.ownerId || null);
      } catch {}

      try {
        const jid = sock?.user?.id || null;
        const phone = jid ? String(jid).split("@")[0] : null;
        let deviceFromMeta = null;
        try {
          const meta = getSessionMeta(sctx.id) || {};
          const arr = Array.isArray(meta.sessionProfile)
            ? meta.sessionProfile
            : [];
          const meJid = String(jid || "");
          const mePhone = meJid ? meJid.split("@")[0] : null;
          const hit = arr.find(
            (p) =>
              String(p?.jid || "") === meJid ||
              String(p?.phone || "").split("@")[0] === mePhone
          );
          if (hit?.device) deviceFromMeta = hit.device;
        } catch {}
        const entry = {
          pushname: sctx.pushName || sock?.user?.name || null,
          phone,
          jid,
        };
        if (deviceFromMeta) entry.device = deviceFromMeta;
        const profile = [entry];
        await upsertSessionRecord({
          id: sctx.id,
          registry_user: sctx.ownerId || "",
          label: sctx.label || sctx.id,
          credentials_path: undefined,
          webhook_url: undefined,
          webhook_secret: undefined,
          session_profile: JSON.stringify(profile),
          auto_start: sctx.autoStart !== false,
          status: "open",
          last_connected_at: new Date().toISOString(),
        });
      } catch {}

      try {
        await sock.resyncAppState?.();
      } catch (e) {
        logger.error({ err: e?.message }, "resyncMainAppState failed");
      }
      ensureSelfProfileHydration();
      setTimeout(() => {
        sctx.store?.flush?.().catch(() => {});
      }, 1500);

      sctx.socketServer
        ?.to(sctx.id)
        .emit("ready", { id: sctx.id, me: sock.user });
      logger.debug(
        { class: "warest", id: sctx.id, me: sock.user },
        "connection open"
      );

      try {
        await emitWebhook(
          "session_status",
          "session_status",
          { id: sctx.id, status: sctx.status, me: sock.user },
          sctx
        );
      } catch {}
      try {
        let retries = 0;
        const maxRetries = 3;
        const retryDelayMs = 15000;
        const attempt = async () => {
          try {
            await sock.resyncMainAppState?.();
          } catch {}
          retries++;
          if (retries < maxRetries) setTimeout(attempt, retryDelayMs).unref?.();
        };
        setTimeout(attempt, 5000).unref?.();
      } catch {}
    }

    if (connection === "close") {
      stopSelfProfileHydration();
      let code = 0;
      if (isBoom(lastDisconnect?.error))
        code = lastDisconnect.error.output?.statusCode ?? 0;
      else
        code =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.statusCode ??
          0;

      const isLoggedOut = code === DisconnectReason.loggedOut;
      const isReplaced = code === DisconnectReason.connectionReplaced;
      if (!isLoggedOut && !isReplaced) {
        reportProxyFailure(sctx.id, { code });
      }
      logger.warn(
        { class: "baileys", id: sctx.id, code, msg: "connection close" },
        "socket closed"
      );
      sock.ev.removeAllListeners();

      if (isReplaced) {
        sctx.status = "replaced";
        try {
          sctx.socketServer
            ?.to(sctx.id)
            .emit("closed", { id: sctx.id, reason: code });
        } catch {}
        await invalidateSessionsCache();
        try {
          notifySessionsChanged(sctx.ownerId || null);
        } catch {}
        try {
          await emitWebhook(
            "session_status",
            "session_status",
            {
              id: sctx.id,
              status: sctx.status,
              reason: code,
              tags: "conflict_replaced",
            },
            sctx
          );
        } catch {}
        return;
      }

      if (isLoggedOut) {
        sctx.status = "logged_out";
        sctx.socketServer
          ?.to(sctx.id)
          .emit("closed", { id: sctx.id, reason: code });
        await invalidateSessionsCache();
        try {
          notifySessionsChanged(sctx.ownerId || null);
        } catch {}
        try {
          await emitWebhook(
            "session_status",
            "session_status",
            { id: sctx.id, status: sctx.status, reason: code },
            sctx
          );
        } catch {}
        try {
          await upsertSessionRecord({
            id: sctx.id,
            registry_user: sctx.ownerId || "",
            label: sctx.label || sctx.id,
            auto_start: sctx.autoStart !== false,
            status: "logged_out",
          });
        } catch {}
        (async () => {
          try {
            await purgeCreds(sctx.id);
            const { state, saveCreds } = await useMultiFileAuthState(
              authDirOf(sctx.id)
            );
            sctx.state = state;
            sctx.saveCreds = saveCreds;
            sctx.attempts = 0;
            sctx.status = "starting";
            await qrCache.delete(sctx.id);
            await startSocket(sctx);
          } catch (e) {
            logger.error(
              { err: e, id: sctx.id },
              "relaunch after logout failed"
            );
          }
        })();
        return;
      }

      sctx.status = "reconnecting";
      sctx.attempts += 1;
      await invalidateSessionsCache();
      try {
        notifySessionsChanged(sctx.ownerId || null);
      } catch {}
      try {
        await emitWebhook(
          "session_status",
          "session_status",
          { id: sctx.id, status: sctx.status, attempts: sctx.attempts },
          sctx
        );
      } catch {}

      if (config?.reconnect?.immediateOnClose) {
        logger.debug(
          { class: "baileys", id: sctx.id },
          "immediate reconnect on close"
        );
        try {
          await startSocket(sctx);
        } catch (e) {
          logger.error({ err: e, id: sctx.id }, "immediate reconnect failed");
        }
        return;
      }

      const base = Math.min(30_000, 1_000 * 2 ** Math.min(sctx.attempts, 5));
      const delay = jitter(base);
      logger.debug(
        { class: "baileys", id: sctx.id, code, attempts: sctx.attempts, delay },
        "scheduling reconnect"
      );
      sctx.timer = setTimeout(async () => {
        try {
          await startSocket(sctx);
        } catch (e) {
          logger.error({ err: e, id: sctx.id }, "reconnect failed");
        }
      }, delay);
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const MAX_CACHE = 1000;
    for (const msg of m.messages || []) {
      try {
        const mid = String(msg?.key?.id || "").trim();
        if (mid) {
          sctx.msgCache.set(mid, msg);
          if (sctx.msgCache.size > MAX_CACHE) {
            const oldest = sctx.msgCache.keys().next().value;
            if (oldest) sctx.msgCache.delete(oldest);
          }
        }
      } catch {}
      if (!msg) continue;

      const tObj = extractTextObject(msg);
      const earlyTag = mapContentTypeToTag(tObj.contentType);
      const allowSelfTags = new Set(["pin"]);
      if (msg.key.fromMe && !allowSelfTags.has(earlyTag)) continue;

      const chatId = msg.key.remoteJid;
      if (isIgnorableJid(chatId)) continue;

      const qObj = extractQuotedTextObject(msg);
      const sender = getSenderInfo(msg);
      let media = extractMediaInfo(msg);
      if (
        media?.hasMedia &&
        config?.download?.mediaReceived &&
        (media.directPath || media.url || media.rawUrl)
      ) {
        const stored = await persistIncomingMediaToStorage(
          msg,
          media,
          sctx,
          sock
        );
        if (stored?.storageUrl) {
          const finalUrl = stored.storageUrl || media.url;
          const extraUrl =
            stored.storageUrl && stored.storageUrl !== finalUrl
              ? stored.storageUrl
              : null;
          const nextMedia = {
            ...media,
            url: finalUrl,
            storageKey: stored.storageKey,
            storageDriver: stored.storageDriver,
            directPath: undefined,
          };
          if (extraUrl) nextMedia.storageUrl = extraUrl;
          media = nextMedia;
          applyStorageMetadataToMessage(msg, media.type, {
            urlDecrypt: finalUrl,
            storageKey: stored.storageKey,
            storageDriver: stored.storageDriver,
          });
          try {
            await sctx.store?.setMediaDecryptedUrl?.(msg, {
              urlDecrypt: finalUrl,
              storageKey: stored.storageKey,
              storageDriver: stored.storageDriver,
            });
          } catch {}
        }
      }
      const mentionDetails = await normalizeMentionEntities(
        getMentions(msg),
        sctx,
        { chatId }
      );
      const mentions = mentionDetails.mentions;
      const displayText = applyMentionReplacements(
        tObj.text || "",
        mentionDetails.replacements
      );
      msg.__warestMentionInfo = {
        normalized: [...mentionDetails.mentions],
        replacements: [...mentionDetails.replacements.entries()],
      };
      const parsed = parseCommand(displayText);

      if (
        tObj.contentType === "reactionMessage" ||
        msg.message?.reactionMessage
      ) {
        try {
          await emitWebhook(
            "message_reaction",
            "message_reaction",
            {
              id: sctx.id,
              key: msg.key,
              reaction:
                msg.message?.reactionMessage || tObj.raw?.reactionMessage || {},
              sender,
            },
            sctx
          );
        } catch {}
        continue;
      }

      if (parsed && isRegisteredCommand(parsed.cmd)) {
        try {
          await emitWebhook(
            "message_command",
            "message_command",
            {
              id: sctx.id,
              message: msg,
              text: displayText,
              contentType: tObj.contentType,
              quoted: qObj?.text ? qObj : undefined,
              sender,
              mentions,
              type: m.type,
            },
            sctx
          );
        } catch {}
        continue;
      }

      let tag = mapContentTypeToTag(tObj.contentType);
      if (tag === "reaction") continue;
      if (!tag || tag === "unknown") {
        if (media?.hasMedia) {
          const mt = String(media.type || "");
          if (/(image|video)/i.test(mt)) tag = "media";
          else if (/document/i.test(mt)) tag = "file";
          else if (/audio/i.test(mt)) tag = "audio";
          else if (/sticker/i.test(mt)) tag = "sticker";
          else if (/location/i.test(mt)) tag = "location";
        } else if (tObj?.type === "interactive") tag = "interactive";
        else if (tObj?.contentType === "conversation") tag = "text";
        else if (tObj?.contentType === "extendedTextMessage")
          tag = "extended_text";
        else if (tObj?.contentType && /pin/i.test(String(tObj.contentType)))
          tag = "pin";
        else tag = "system";
      }

      const webhookMedia = media?.hasMedia
        ? scrubMediaForWebhook(media)
        : undefined;

      try {
        await emitWebhook(
          "message_received",
          "message_received",
          {
            id: sctx.id,
            tags: tag,
            message: msg,
            text: displayText,
            contentType: tObj.contentType,
            quoted: qObj?.text ? qObj : undefined,
            sender,
            media: webhookMedia,
            mentions,
            type: m.type,
          },
          sctx
        );
      } catch {}

      logger.debug(
        {
          class: "baileys",
          id: sctx.id,
          from: chatId,
          type: Object.keys(msg.message || {})[0],
        },
        "message received"
      );

      try {
        const rawAuthor =
          msg?.key?.participant || msg?.participant || msg?.author || null;
        const base = rawAuthor || chatId;
        const jid =
          chooseNormalizedUserJid({ id: base }) ||
          toSWhatsAppUserJid(base) ||
          base;
        const push = String(msg?.pushName || "").trim();
        if (jid && push) cachePushName(jid, push);
      } catch {}

      try {
        const dev = getDevice?.(String(msg?.key?.id || ""));
        if (dev && dev !== "unknown") {
          const meJid = String(sock?.user?.id || "");
          if (meJid) {
            const mePhone = meJid.split("@")[0];
            const pushname = sctx.pushName || sock?.user?.name || null;
            const meta = getSessionMeta(sctx.id) || {};
            const list = Array.isArray(meta.sessionProfile)
              ? [...meta.sessionProfile]
              : [];
            const hitIdx = list.findIndex(
              (p) =>
                String(p?.jid || "") === meJid ||
                String(p?.phone || "").split("@")[0] === mePhone
            );
            const base = { pushname, phone: mePhone, jid: meJid };
            if (hitIdx >= 0) {
              const cur = list[hitIdx] || {};
              list[hitIdx] = { ...cur, ...base, device: dev };
            } else {
              list.push({ ...base, device: dev });
            }
            upsertSessionMeta({ id: sctx.id, sessionProfile: list });
          }
        }
      } catch {}

      if (config.autoReply?.enabled && displayText) {
        const clean = displayText.trim().toLowerCase();
        if (config.autoReply?.pingPong && clean === "ping") {
          try {
            await sock.presenceSubscribe(sender.chatId);
            await sock.sendPresenceUpdate("composing", sender.chatId);
            await new Promise((r) => setTimeout(r, 2000));
            await sock.sendPresenceUpdate("paused", sender.chatId);
           await sock.sendMessage(
            sender.chatId,
            { text: `pong!\n\n_Warest v${pkg.version}_`},
            { quoted: msg }
          );
          } catch {}
        }
      }
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    for (const u of updates || []) {
      try {
        const key = u?.key;
        const msg = u?.update?.message || u?.message;
        if (msg?.pinInChatMessage) {
          try {
            await emitWebhook(
              "message_received",
              "message_received",
              {
                id: sctx.id,
                tags: "pin",
                message: {
                  key,
                  message: { pinInChatMessage: msg.pinInChatMessage },
                },
                text: "",
                contentType: "pinInChatMessage",
                mentions: [],
                type: u?.type,
              },
              sctx
            );
          } catch {}
          continue;
        }

        const reaction = msg?.reactionMessage || msg?.encReactionMessage;
        if (reaction) {
          try {
            await emitWebhook(
              "message_reaction",
              "message_reaction",
              {
                id: sctx.id,
                key,
                reaction: {
                  text: reaction?.text,
                  key: reaction?.key,
                  sender: reaction?.senderKeyDistributionMessage || undefined,
                },
              },
              sctx
            );
          } catch {}
          continue;
        }

        const edited =
          msg?.editedMessage || msg?.protocolMessage?.editedMessage;
        if (edited) {
          const editedCarrier =
            edited && typeof edited === "object"
              ? edited?.message && typeof edited.message === "object"
                ? { message: edited.message }
                : { message: edited }
              : null;
          let editedMentions = [];
          if (editedCarrier) {
            const mentionInfo = await normalizeMentionEntities(
              getMentions(editedCarrier),
              sctx,
              { chatId: key?.remoteJid }
            );
            editedMentions = mentionInfo.mentions;
          }
          try {
            await emitWebhook(
              "message_edited",
              "message_edited",
              {
                id: sctx.id,
                key,
                editedMessage: edited,
                update: u,
                mentions: editedMentions,
              },
              sctx
            );
          } catch {}
          continue;
        }

        const proto = msg?.protocolMessage;
        if (proto?.key && !edited) {
          try {
            await emitWebhook(
              "message_revoked",
              "message_revoked",
              { id: sctx.id, key: proto.key, update: u },
              sctx
            );
          } catch {}
          continue;
        }
      } catch {}
    }
  });

  sock.ev.on("messages.delete", async (item) => {
    try {
      const arr = Array.isArray(item) ? item : [item];
      for (const it of arr) {
        await emitWebhook(
          "message_revoked",
          "message_revoked",
          { id: sctx.id, key: it?.key || it },
          sctx
        );
      }
    } catch {}
  });

  sock.ev.on("presence.update", async (u) => {
    try {
      await emitWebhook(
        "presence_update",
        "presence_update",
        { id: sctx.id, presence: u },
        sctx
      );
    } catch {}
  });

  sock.ev.on("groups.update", async (updates) => {
    try {
      const arr = Array.isArray(updates) ? updates : [updates];
      for (const g of arr) {
        await emitWebhook(
          "group_update",
          "group_update",
          { id: sctx.id, update: g },
          sctx
        );
      }
    } catch {}
  });

  sock.ev.on("group-participants.update", async (upd) => {
    try {
      const payload = {
        id: sctx.id,
        groupId: upd?.id,
        participants: upd?.participants || [],
        action: upd?.action,
      };
      await emitWebhook(
        "group_participants",
        "group_participants",
        payload,
        sctx
      );
      if (upd?.action === "add")
        await emitWebhook("group_join", "group_join", payload, sctx);
      else if (upd?.action === "remove")
        await emitWebhook("group_leave", "group_leave", payload, sctx);
    } catch {}
  });

  sock.ev.on("call", async (calls) => {
    try {
      const arr = Array.isArray(calls) ? calls : [calls];
      await emitWebhook("call", "call", { id: sctx.id, calls: arr }, sctx);
    } catch {}
  });
}

export async function requestPairingCodeForSession(id, phone) {
  try {
    const s = sessions.get(id);
    if (!s || !s.sock || !phone) return null;
    const cacheKey = pairKey(id, phone);
    const cached = await pairingCodeCache.get(cacheKey);
    if (cached) return cached;
    const normalized = normalizePhoneForPairing(phone);
    const code = await s.sock.requestPairingCode(normalized);
    if (code) await pairingCodeCache.set(cacheKey, code, 65);
    return code || null;
  } catch {
    return null;
  }
}

export { sessions, listSessions as _listSessionsForDebug };
