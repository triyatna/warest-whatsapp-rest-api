import express from "express";
import axios from "axios";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import mime from "mime-types";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { ulid } from "ulid";
import QRCode from "qrcode";
import {
  v1 as uuidv1,
  v3 as uuidv3,
  v4 as uuidv4,
  v5 as uuidv5,
  NIL as NIL_UUID,
  validate as uuidValidate,
  version as uuidVersion,
} from "uuid";
import {
  getMediaKeys,
  decryptPollVote,
  jidDecode,
  jidEncode,
} from "@whiskeysockets/baileys";
import { apiKeyAuth } from "../middleware/auth.js";
import { dynamicRateLimit } from "../middleware/ratelimit.js";
import { send } from "../utils/code.js";
import { storage } from "../drivers/storage.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getSession, listSessions } from "../whatsapp/baileysClient.js";
import { getSessionMeta } from "../whatsapp/sessionRegistry.js";

const router = express.Router();
router.use(apiKeyAuth("user"), dynamicRateLimit());

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const digitsOnly = (value) => String(value || "").replace(/\D+/g, "");
const stripDeviceSuffix = (jid) =>
  String(jid || "").replace(/:[^@]+(?=@)/, "");

const MAX_MISC_FILE_BYTES =
  Math.max(1, Number(config.uploadLimits?.miscFileMb || 50)) *
  1024 *
  1024;
const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;
const DATA_URL_RE = /^data:/i;
const URL_RE = /^https?:\/\//i;
const SUPPORTED_IMAGE_FORMATS = new Set(["png", "jpg", "jpeg", "webp"]);
const VIDEO_THUMB_COUNT = 3;
const MIN_TEMP_FILE_TTL_MS = 60 * 1000;
const configuredTempTtlSeconds = Number(config.storage?.tempTtlSeconds);
const DEFAULT_TEMP_FILE_TTL_MS = Math.max(
  MIN_TEMP_FILE_TTL_MS,
  Number.isFinite(configuredTempTtlSeconds) && configuredTempTtlSeconds > 0
    ? configuredTempTtlSeconds * 1000
    : 5 * 60 * 1000
);
const tempStorageTimers = new Map();

const DEFAULT_COUNTRY_CODE = (() => {
  const raw = digitsOnly(config.defaultCountryCode || "62");
  const trimmed = raw.replace(/^0+/, "");
  return trimmed || "62";
})();

const ISO_TO_DIAL = {
  AE: "971",
  AR: "54",
  AU: "61",
  BD: "880",
  BE: "32",
  BR: "55",
  CA: "1",
  CL: "56",
  CN: "86",
  CO: "57",
  DE: "49",
  EG: "20",
  ES: "34",
  FR: "33",
  GB: "44",
  GH: "233",
  HK: "852",
  ID: "62",
  IN: "91",
  IT: "39",
  JP: "81",
  KE: "254",
  KH: "855",
  KR: "82",
  KW: "965",
  LA: "856",
  LK: "94",
  MM: "95",
  MX: "52",
  MY: "60",
  NL: "31",
  NP: "977",
  NZ: "64",
  PH: "63",
  PK: "92",
  QA: "974",
  RU: "7",
  SA: "966",
  SG: "65",
  TH: "66",
  TR: "90",
  TW: "886",
  UA: "380",
  UK: "44",
  US: "1",
  VN: "84",
  ZA: "27",
};

const DIAL_TO_ISO = (() => {
  const map = new Map();
  for (const [iso, dial] of Object.entries(ISO_TO_DIAL)) {
    const key = digitsOnly(dial);
    if (!key) continue;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(iso);
  }
  return map;
})();

const looksLikeUrl = (value) => URL_RE.test(String(value || "").trim());
const looksLikeBase64 = (value) => {
  if (!value || typeof value !== "string") return false;
  const clean = value.trim();
  if (clean.length < 16) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(clean);
};

let sharpSingleton = null;
async function getSharpInstance() {
  if (sharpSingleton) return sharpSingleton;
  try {
    const mod = await import("sharp");
    sharpSingleton = mod.default || mod;
    return sharpSingleton;
  } catch {
    return null;
  }
}

function parseDataUri(value) {
  try {
    const raw = String(value || "");
    if (!DATA_URL_RE.test(raw)) return null;
    const idx = raw.indexOf(",");
    if (idx < 0) return null;
    const header = raw.slice(5, idx);
    const mimeType = header.split(";")[0] || "application/octet-stream";
    const base64 = raw.slice(idx + 1);
    return {
      buffer: Buffer.from(base64, "base64"),
      mimeType,
    };
  } catch {
    return null;
  }
}

function magicMime(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
      return "image/jpeg";
    if (buf.slice(0, 4).toString("ascii") === "%PDF") return "application/pdf";
    if (
      buf
        .slice(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      return "image/png";
    if (buf.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
    if (
      buf.slice(0, 4).toString("ascii") === "RIFF" &&
      buf.slice(8, 12).toString("ascii") === "WEBP"
    )
      return "image/webp";
    if (buf.slice(4, 8).toString("ascii") === "ftyp") return "video/mp4";
    if (buf.slice(0, 4).toString("ascii") === "OggS") return "audio/ogg";
    if (
      buf.slice(0, 3).toString("ascii") === "ID3" ||
      (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
    )
      return "audio/mpeg";
  } catch {}
  return null;
}

function detectMime(buffer, fallback, sourceName) {
  const guess =
    magicMime(buffer) ||
    mime.lookup(sourceName || "") ||
    fallback ||
    "application/octet-stream";
  return guess;
}

async function fetchUrlBuffer(url, fallbackMime) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: Number(config.uploadLimits?.fetchTimeoutMs || 300000),
    maxContentLength: MAX_MISC_FILE_BYTES,
    maxBodyLength: MAX_MISC_FILE_BYTES,
    headers: { Origin: config.baseUrl || "warest" },
  });
  const mimeType =
    resp.headers["content-type"] ||
    mime.lookup(url) ||
    fallbackMime ||
    "application/octet-stream";
  const buffer = Buffer.from(resp.data);
  ensureWithinLimit(buffer, "download");
  return { buffer, mimeType };
}

function ensureWithinLimit(buffer, label = "input") {
  if (buffer.length > MAX_MISC_FILE_BYTES) {
    throw new Error(
      `${label} exceeds limit (${(MAX_MISC_FILE_BYTES / 1024 / 1024).toFixed(
        1
      )} MB)`
    );
  }
  return buffer;
}

async function loadBinaryInput(
  source,
  { encoding = "utf8", sourceHint, allowPath = false, fieldName = "input" } = {}
) {
  if (Buffer.isBuffer(source)) {
    return {
      buffer: ensureWithinLimit(Buffer.from(source)),
      mimeType: "application/octet-stream",
    };
  }
  if (
    source &&
    typeof source === "object" &&
    Array.isArray(source.data) &&
    source.type === "Buffer"
  ) {
    return {
      buffer: ensureWithinLimit(Buffer.from(source.data)),
      mimeType: "application/octet-stream",
    };
  }
  const raw = String(source ?? "").trim();
  if (!raw) {
    throw new Error(`${fieldName} is required`);
  }
  const dataUri = parseDataUri(raw);
  if (dataUri) {
    return {
      buffer: ensureWithinLimit(dataUri.buffer),
      mimeType: dataUri.mimeType,
    };
  }
  if (looksLikeUrl(raw)) {
    return fetchUrlBuffer(raw);
  }
  if (allowPath) {
    try {
      const stat = await fs.stat(raw);
      if (stat.isFile()) {
        const buffer = ensureWithinLimit(await fs.readFile(raw));
        return { buffer, mimeType: detectMime(buffer, null, raw) };
      }
    } catch {}
  }
  const hint = String(sourceHint || "").toLowerCase();
  if (hint.includes("base64") || looksLikeBase64(raw)) {
    try {
      const buffer = ensureWithinLimit(Buffer.from(raw, "base64"));
      return { buffer, mimeType: "application/octet-stream" };
    } catch {}
  }
  if (hint.includes("hex")) {
    try {
      const buffer = ensureWithinLimit(Buffer.from(raw, "hex"));
      return { buffer, mimeType: "application/octet-stream" };
    } catch {}
  }
  const buffer = ensureWithinLimit(Buffer.from(raw, encoding));
  return { buffer, mimeType: "text/plain" };
}

async function deliverBinary(
  buffer,
  {
    output = "base64",
    mimeType = "application/octet-stream",
    extension,
    directory = "misc",
    label = "file",
    metadata: extraMetadata = {},
    temporary = false,
    temporaryTtlMs,
  } = {}
) {
  const mode = String(output || "base64").toLowerCase();
  const baseMeta = { mode, mimeType, size: buffer.length };
  if (temporary) baseMeta.temporary = true;
  if (mode === "string") {
    return { value: buffer.toString("utf8"), meta: baseMeta };
  }
  if (mode === "dataurl") {
    return {
      value: `data:${mimeType};base64,${buffer.toString("base64")}`,
      meta: baseMeta,
    };
  }
  if (mode === "url" || mode === "file") {
    const ext =
      extension ||
      mime.extension(mimeType) ||
      (mimeType.startsWith("image/") ? mimeType.split("/")[1] : "bin");
    const dateSegment = new Date().toISOString().slice(0, 10);
    const directorySegments = Array.isArray(directory)
      ? directory.filter(Boolean)
      : [directory].filter(Boolean);
    if (temporary) directorySegments.push("temp");
    directorySegments.push(dateSegment);
    const ttlMs =
      temporary && Number.isFinite(Number(temporaryTtlMs))
        ? Math.max(1000, Number(temporaryTtlMs))
        : temporary
        ? DEFAULT_TEMP_FILE_TTL_MS
        : null;
    const expiresAt =
      temporary && ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    const saved = await storage.save(buffer, {
      directory: directorySegments,
      extension: ext,
      mimeType,
      visibility: mode === "url" ? "public" : "private",
      metadata: sanitizeMetadata({
        scope: "misc",
        label,
        temporary: temporary || undefined,
        expiresAt,
        ...extraMetadata,
      }),
    });
    const publicUrl =
      saved.url ||
      (mode === "url" ? storage.url(saved.key, { visibility: "public" }) : null);
    if (temporary && saved.key) {
      scheduleTempDeletion(saved.key, ttlMs || DEFAULT_TEMP_FILE_TTL_MS);
    }
    return {
      value: mode === "url" ? publicUrl || saved.key : saved.key,
      meta: {
        ...baseMeta,
        key: saved.key,
        url: publicUrl,
        expiresAt: expiresAt || undefined,
      },
    };
  }
  return { value: buffer.toString("base64"), meta: baseMeta };
}

function sanitizeMetadata(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null)
  );
}

function scheduleTempDeletion(key, ttlMs = DEFAULT_TEMP_FILE_TTL_MS) {
  if (!key) return null;
  const delay = Math.max(1000, Number(ttlMs) || DEFAULT_TEMP_FILE_TTL_MS);
  if (tempStorageTimers.has(key)) {
    clearTimeout(tempStorageTimers.get(key));
  }
  const expiresAt = new Date(Date.now() + delay).toISOString();
  const handle = setTimeout(async () => {
    tempStorageTimers.delete(key);
    try {
      await storage.delete(key);
    } catch (err) {
      logger.warn(
        { err, key },
        "[misc] failed to cleanup temporary storage object"
      );
    }
  }, delay);
  handle.unref?.();
  tempStorageTimers.set(key, handle);
  return { expiresAt, ttlMs: delay };
}

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

function resolveDialCode(value) {
  if (!value) return DEFAULT_COUNTRY_CODE;
  const trimmed = String(value || "").trim();
  if (!trimmed) return DEFAULT_COUNTRY_CODE;
  if (/^\+?\d{1,4}$/.test(trimmed)) return digitsOnly(trimmed);
  const upper = trimmed.toUpperCase();
  return digitsOnly(ISO_TO_DIAL[upper] || DEFAULT_COUNTRY_CODE);
}

function normalizePhoneDigits(value, country) {
  let digits = digitsOnly(value);
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) {
    const cc = resolveDialCode(country);
    return `${cc}${digits.replace(/^0+/, "")}`;
  }
  const cc = resolveDialCode(country);
  if (!digits.startsWith(cc) && digits.length <= 12) {
    return `${cc}${digits}`;
  }
  return digits;
}

function guessCountryFromDigits(digits) {
  const clean = digitsOnly(digits);
  if (!clean) return null;
  for (let len = 4; len >= 1; len--) {
    const prefix = clean.slice(0, len);
    if (DIAL_TO_ISO.has(prefix)) {
      const iso = [...DIAL_TO_ISO.get(prefix)][0];
      if (iso) return iso;
    }
  }
  return null;
}

const formatE164 = (digits) =>
  digits ? (digits.startsWith("+") ? digits : `+${digits}`) : null;

function normalizeUserJid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.endsWith("@s.whatsapp.net"))
    return stripDeviceSuffix(raw.toLowerCase());
  if (raw.endsWith("@c.us"))
    return stripDeviceSuffix(
      raw.replace(/@c\.us$/i, "@s.whatsapp.net").toLowerCase()
    );
  if (raw.endsWith("@lid")) return raw;
  const digits = digitsOnly(raw);
  if (digits) return `${digits}@s.whatsapp.net`;
  return stripDeviceSuffix(raw);
}

function guessJidType(jid) {
  const lower = String(jid || "").toLowerCase();
  if (lower.endsWith("@s.whatsapp.net")) return "user";
  if (lower.endsWith("@g.us")) return "group";
  if (lower.endsWith("@broadcast")) return "broadcast";
  if (lower.endsWith("@newsletter")) return "newsletter";
  if (lower.endsWith("@lid")) return "lid";
  return "unknown";
}

function bufferFromUnknown(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    for (const encoding of ["base64", "hex", "utf8"]) {
      try {
        return Buffer.from(trimmed, encoding);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function normalizeOptionIndexes(values = []) {
  const indexes = [];
  for (const entry of values) {
    let idx = null;
    if (typeof entry === "number") idx = entry;
    else if (typeof entry === "bigint") idx = Number(entry);
    else if (typeof entry === "string") {
      const parsed = Number(entry);
      if (Number.isFinite(parsed)) idx = parsed;
    } else if (
      entry &&
      typeof entry === "object" &&
      typeof entry.toString === "function"
    ) {
      const parsed = Number(entry.toString());
      if (Number.isFinite(parsed)) idx = parsed;
    }
    if (idx != null && Number.isFinite(idx)) indexes.push(idx);
  }
  return indexes;
}

const getContactsContainer = (sock) => {
  try {
    return sock?.store?.contacts || sock?.contacts || null;
  } catch {
    return null;
  }
};

function findLidByJid(sock, jid) {
  try {
    const contacts = getContactsContainer(sock);
    if (!contacts) return null;
    const iterable =
      contacts instanceof Map
        ? contacts.values()
        : Array.isArray(contacts)
        ? contacts
        : Object.values(contacts);
    for (const contact of iterable) {
      const cJid = contact?.jid || contact?.id || "";
      if (stripDeviceSuffix(cJid) === stripDeviceSuffix(jid)) {
        const lid = contact?.lid || contact?.lidJid;
        if (lid && lid.endsWith("@lid")) return lid;
      }
    }
  } catch {}
  return null;
}

function findJidByLid(sock, lid) {
  try {
    const contacts = getContactsContainer(sock);
    if (!contacts) return null;
    const iterable =
      contacts instanceof Map
        ? contacts.values()
        : Array.isArray(contacts)
        ? contacts
        : Object.values(contacts);
    for (const contact of iterable) {
      const cid = contact?.lid || contact?.lidJid;
      if (cid && cid === lid) {
        return normalizeUserJid(contact?.jid || contact?.id || "");
      }
    }
  } catch {}
  return null;
}
async function extractVideoThumbnails(buffer, { width, height, count }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "warest-thumb-"));
  const inputPath = path.join(dir, `source-${Date.now()}.mp4`);
  await fs.writeFile(inputPath, buffer);
  const frames = [];
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .on("error", reject)
        .on("end", resolve)
        .screenshots({
          count,
          filename: "thumb-%i.jpg",
          folder: dir,
          size: `${width}x${height}`,
        });
    });
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (!entry.startsWith("thumb-")) continue;
      const frame = await fs.readFile(path.join(dir, entry));
      frames.push(frame);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return frames;
}

async function withQueue(session, fn) {
  if (!session?.queue) return fn();
  return new Promise((resolve, reject) => {
    session.queue.push(async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function fetchPollMetadataFromSession(session, creationKey) {
  const fallback = {
    pollEncKey: null,
    pollOptions: [],
    pollTitle: null,
    selectableOptionsCount: null,
  };
  if (!session?.store?.getMessage || !creationKey?.id) return fallback;
  try {
    const msg = await session.store.getMessage({
      id: creationKey.id,
      remoteJid: creationKey.remoteJid,
      fromMe: creationKey.fromMe ?? false,
      participant: creationKey.participant,
    });
    if (!msg) return fallback;
    const creation =
      msg?.message?.pollCreationMessage ||
      msg?.message?.pollCreationMessageV2 ||
      msg?.message?.pollCreationMessageV3 ||
      msg?.pollCreationMessage ||
      msg?.pollCreationMessageV2 ||
      msg?.pollCreationMessageV3;
    const candidates = [
      creation?.messageSecret,
      creation?.contextInfo?.messageSecret,
      msg?.message?.messageContextInfo?.messageSecret,
      msg?.messageContextInfo?.messageSecret,
    ].filter(Boolean);
    let pollEncKey = null;
    for (const secret of candidates) {
      const buf = bufferFromUnknown(secret);
      if (buf) {
        pollEncKey = buf;
        break;
      }
    }
    const options = Array.isArray(creation?.options)
      ? creation.options
          .map((opt, index) => ({
            index,
            name:
              opt && opt.optionName != null
                ? String(opt.optionName)
                : opt?.name
                ? String(opt.name)
                : null,
          }))
          .filter((opt) => opt.name)
      : [];
    return {
      pollEncKey,
      pollOptions: options,
      pollTitle:
        creation?.name ||
        creation?.title ||
        creation?.pollTitle ||
        creation?.question ||
        null,
      selectableOptionsCount:
        Number(creation?.selectableOptionsCount || options.length || 0) || null,
    };
  } catch (err) {
    logger.warn(
      { err: err?.message, sessionId: session?.id },
      "[misc] poll metadata lookup failed"
    );
    return fallback;
  }
}

function sanitizePollMessageKey(key = {}, fallbackId = null) {
  const normalized = {};
  if (key.id || fallbackId) normalized.id = key.id || fallbackId;
  if (key.remoteJid) normalized.remoteJid = key.remoteJid;
  if (key.participant) normalized.participant = key.participant;
  if (typeof key.fromMe === "boolean") normalized.fromMe = key.fromMe;
  return normalized;
}

function mapOptionNames(optionIndexes = [], pollOptions = []) {
  if (!Array.isArray(optionIndexes) || !optionIndexes.length) return [];
  const lookup = new Map();
  for (const opt of pollOptions || []) {
    if (
      opt &&
      typeof opt.index === "number" &&
      Number.isFinite(opt.index) &&
      opt.name
    ) {
      lookup.set(Number(opt.index), String(opt.name));
    }
  }
  const names = [];
  for (const idx of optionIndexes) {
    if (lookup.has(idx)) names.push(lookup.get(idx));
  }
  return names;
}

async function resolveSessionFromReq(
  req,
  { optional = false, autoPick = false } = {}
) {
  const ownerId = req?.auth?.ownerId || null;
  const sessionId = readStr(req, ["sessionId", "session", "sid"]);
  const sessionPhone = readStr(req, [
    "sessionPhone",
    "sessionNumber",
    "sessionMsisdn",
    "senderPhone",
  ]);
  if (sessionId) {
    if (!SAFE_ID_REGEX.test(sessionId)) {
      return {
        error: (res) =>
          send(res, "INVALID_PARAMETER", {
            message: "sessionId is invalid",
            result: null,
          }),
      };
    }
    const meta = getSessionMeta(sessionId);
    if (!meta || meta.ownerId !== ownerId) {
      return {
        error: (res) =>
          send(res, "SESSION_NOT_FOUND", {
            message: "Session not found",
            result: null,
          }),
      };
    }
    const session = getSession(sessionId);
    if (!session || session.status !== "open") {
      return {
        error: (res) =>
          send(res, "SESSION_NOT_LOGGED_IN", {
            message: "Session is not ready",
            result: null,
          }),
      };
    }
    return { session, sessionId };
  }
  const digits = digitsOnly(sessionPhone);
  if (digits) {
    const records = await listSessions();
    for (const rec of records) {
      if (rec.status !== "open") continue;
      const meta = getSessionMeta(rec.id);
      if (!meta || meta.ownerId !== ownerId) continue;
      const session = getSession(rec.id);
      const meDigits = digitsOnly(session?.me?.id?.split("@")[0]);
      if (meDigits && meDigits === digits) {
        return { session, sessionId: rec.id };
      }
    }
    return {
      error: (res) =>
        send(res, "SESSION_NOT_FOUND", {
          message: "Matching session not found",
          result: null,
        }),
    };
  }
  if (autoPick) {
    const records = await listSessions();
    for (const rec of records) {
      if (rec.status !== "open") continue;
      const meta = getSessionMeta(rec.id);
      if (!meta || meta.ownerId !== ownerId) continue;
      const session = getSession(rec.id);
      if (session && session.status === "open") {
        return { session, sessionId: rec.id };
      }
    }
    return {
      error: (res) =>
        send(res, "SESSION_NOT_FOUND", {
          message: "No active session available",
          result: null,
        }),
    };
  }
  if (optional) return { session: null, sessionId: null };
  return {
    error: (res) =>
      send(res, "MISSING_PARAMETER", {
        message: "Provide sessionId or sessionPhone",
        result: null,
      }),
  };
}

function readStr(req, keys = []) {
  for (const key of keys) {
    const bodyVal = req.body?.[key];
    if (typeof bodyVal === "string" && bodyVal.trim()) return bodyVal.trim();
    if (
      bodyVal != null &&
      typeof bodyVal !== "object" &&
      bodyVal !== undefined
    ) {
      const str = String(bodyVal).trim();
      if (str) return str;
    }
    const queryVal = req.query?.[key];
    if (typeof queryVal === "string" && queryVal.trim())
      return queryVal.trim();
  }
  return "";
}

const inferMediaCategory = (mimeType) => {
  const m = String(mimeType || "").toLowerCase();
  if (m.startsWith("image/"))
    return m.includes("webp") && !m.includes("gif") ? "sticker" : "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/") || m.includes("ptt")) return "audio";
  return "document";
};

/* -------------------------------------------------------------------------- */
/* Routes                                                                    */
/* -------------------------------------------------------------------------- */
router.post("/convert-string-toqr/:target", async (req, res) => {
  try {
    const targetRaw = String(req.params?.target || "").trim().toLowerCase();
    const inputString = readStr(req, ["string"]);
    const encoding = req.body?.encoding || "utf8";
    if (!targetRaw) {
      return send(res, "INVALID_PARAMETER", {
        message: "Target format is required",
        result: null,
      });
    }
    if (!inputString) {
      return send(res, "MISSING_PARAMETER", {
        message: "string is required",
        result: null,
      });
    }
    const allowedTargets = new Set(["base64", "svg", ...SUPPORTED_IMAGE_FORMATS]);
    if (!allowedTargets.has(targetRaw)) {
      return send(res, "INVALID_PARAMETER", {
        message: "Unsupported target format; use base64, svg, png, jpg, jpeg, or webp",
        result: null,
      });
    }
    const qrOptions = { errorCorrectionLevel: "M", margin: 1, scale: 6 };
    const label = "qr-string";
    if (targetRaw === "base64") {
      const dataUrl = await QRCode.toDataURL(inputString, {
        ...qrOptions,
        type: "image/png",
      });
      return send(res, "SUCCESS", {
        message: "String converted to QR-friendly PNG (base64 data URI)",
        result: {
          data: dataUrl,
          meta: { mode: "dataurl", mimeType: "image/png", format: "png" },
        },
      });
    }
    if (targetRaw === "svg") {
      const svgString = await QRCode.toString(inputString, {
        ...qrOptions,
        type: "svg",
      });
      const svgBuffer = Buffer.from(svgString, encoding);
      const delivered = await deliverBinary(svgBuffer, {
        output: "url",
        mimeType: "image/svg+xml",
        extension: "svg",
        label,
        temporary: true,
        metadata: { purpose: "convert-string-toqr", target: "svg" },
      });
      return send(res, "SUCCESS", {
        message: "String converted to QR-friendly SVG format",
        result: {
          data: delivered.value,
          meta: delivered.meta,
        },
      });
    }
    const pngBuffer = await QRCode.toBuffer(inputString, {
      ...qrOptions,
      type: "png",
    });
    const fmt = targetRaw === "jpg" ? "jpeg" : targetRaw;
    let converted = pngBuffer;
    if (fmt !== "png") {
      const sharpLib = await getSharpInstance();
      if (!sharpLib) {
        return send(res, "SERVICE_UNAVAILABLE", {
          message: "Image conversion requires Sharp",
          result: null,
        });
      }
      converted = await sharpLib(pngBuffer, { failOnError: false })
        .toFormat(fmt)
        .toBuffer();
    }
    const mimeType = fmt === "jpeg" ? "image/jpeg" : `image/${fmt}`;
    const delivered = await deliverBinary(converted, {
      output: "url",
      mimeType,
      extension: fmt === "jpeg" ? "jpg" : fmt,
      label,
      temporary: true,
      metadata: { purpose: "convert-string-toqr", target: fmt },
    });
    return send(res, "SUCCESS", {
      message: `String converted to QR-friendly ${fmt.toUpperCase()} format`,
      result: {
        data: delivered.value,
        meta: delivered.meta,
      },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/whatsapp/file-decrypt", async (req, res) => {
  try {
    const mimeType =
      readStr(req, ["mimeType", "mimetype"]) || "application/octet-stream";
    const mediaKeyRaw = readStr(req, ["mediaKey", "media_key"]);
    const expectedSha = readStr(req, ["fileSha256", "sha256"]);
    const outputMode = readStr(req, ["output"]) || "base64";
    const source =
      req.body?.file ||
      req.body?.data ||
      req.body?.encrypted ||
      req.body?.blob ||
      "";
    if (!mediaKeyRaw) {
      return send(res, "MISSING_PARAMETER", {
        message: "mediaKey is required",
        result: null,
      });
    }
    if (!source) {
      return send(res, "MISSING_PARAMETER", {
        message: "Encrypted file is required",
        result: null,
      });
    }
    const mediaKey = bufferFromUnknown(mediaKeyRaw);
    if (!mediaKey || mediaKey.length < 32) {
      return send(res, "INVALID_PARAMETER", {
        message: "mediaKey is invalid",
        result: null,
      });
    }
    const { buffer: encrypted } = await loadBinaryInput(source, {
      sourceHint: "base64",
      fieldName: "file",
    });
    if (encrypted.length <= 10) {
      return send(res, "INVALID_PARAMETER", {
        message: "Encrypted payload is too small",
        result: null,
      });
    }
    const mac = encrypted.slice(-10);
    const ciphertext = encrypted.slice(0, -10);
    const mediaCategory = inferMediaCategory(mimeType);
    const { cipherKey, iv, macKey } = await getMediaKeys(
      mediaKey,
      mediaCategory
    );
    const computedMac = crypto
      .createHmac("sha256", macKey)
      .update(iv)
      .update(ciphertext)
      .digest()
      .subarray(0, 10);
    if (!crypto.timingSafeEqual(mac, computedMac)) {
      return send(res, "INVALID_PARAMETER", {
        message: "MAC verification failed",
        result: null,
      });
    }
    const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (expectedSha) {
      const expected = bufferFromUnknown(expectedSha);
      const actual = crypto.createHash("sha256").update(decrypted).digest();
      if (
        expected &&
        expected.length === actual.length &&
        !crypto.timingSafeEqual(expected, actual)
      ) {
        return send(res, "INVALID_PARAMETER", {
          message: "fileSha256 does not match decrypted content",
          result: null,
        });
      }
    }
    const delivered = await deliverBinary(decrypted, {
      output: outputMode,
      mimeType,
      extension: mime.extension(mimeType) || "bin",
      label: "wa-decrypt",
    });
    return send(res, "SUCCESS", {
      message: "File decrypted",
      result: { data: delivered.value, meta: delivered.meta },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/whatsapp/poll-update-vote", async (req, res) => {
  try {
    const pollUpdateVote = req.body?.pollUpdateVote;
    if (!pollUpdateVote?.vote) {
      return send(res, "MISSING_PARAMETER", {
        message: "pollUpdateVote is required",
        result: null,
      });
    }
    const encPayload = bufferFromUnknown(pollUpdateVote.vote.encPayload);
    const encIv = bufferFromUnknown(pollUpdateVote.vote.encIv);
    if (!encPayload || !encIv) {
      return send(res, "INVALID_PARAMETER", {
        message: "encPayload and encIv are required",
        result: null,
      });
    }
    const pollKey =
      pollUpdateVote.pollCreationMessageKey ||
      pollUpdateVote.pollMessageKey ||
      {};
    const pollMsgId = pollKey.id || readStr(req, ["pollMsgId"]);
    if (!pollMsgId) {
      return send(res, "INVALID_PARAMETER", {
        message: "poll message id is required",
        result: null,
      });
    }
    pollKey.id = pollMsgId;
    pollKey.remoteJid =
      pollKey.remoteJid ||
      pollUpdateVote.pollCreationMessageKey?.remoteJid ||
      pollUpdateVote.pollMessageKey?.remoteJid ||
      pollUpdateVote.key?.remoteJid ||
      readStr(req, ["pollRemoteJid"]) ||
      "";
    pollKey.participant =
      pollKey.participant ||
      pollUpdateVote.pollCreationMessageKey?.participant ||
      pollUpdateVote.pollMessageKey?.participant ||
      pollUpdateVote.key?.participant ||
      "";
    let pollCreatorJid =
      normalizeUserJid(
        req.body?.pollCreatorJid ||
          pollKey.participant ||
          pollUpdateVote.key?.participant
      ) || "";
    let voterJid =
      normalizeUserJid(
        req.body?.voterJid ||
          pollUpdateVote.key?.participant ||
          pollUpdateVote.key?.remoteJid
      ) || "";
    let pollEncKey = bufferFromUnknown(req.body?.pollEncKey);
    const resolved = await resolveSessionFromReq(req);
    if (resolved.error) return resolved.error(res);
    const session = resolved.session;
    if (!voterJid) {
      voterJid =
        normalizeUserJid(
          pollUpdateVote.key?.participant ||
            pollUpdateVote.key?.remoteJid ||
            session?.me?.id
        ) || "";
    }
    if (!pollCreatorJid) {
      pollCreatorJid =
        normalizeUserJid(
          pollKey.participant ||
            pollUpdateVote.pollCreationMessageKey?.participant ||
            session?.me?.id
        ) || "";
    }
    const pollMeta = await fetchPollMetadataFromSession(session, pollKey);
    if (!pollEncKey && pollMeta.pollEncKey) {
      pollEncKey = pollMeta.pollEncKey;
    }
    if (!pollEncKey) {
      return send(res, "INVALID_PARAMETER", {
        message: "pollEncKey is required",
        result: null,
      });
    }
    const decrypted = decryptPollVote(
      { encPayload, encIv },
      {
        pollCreatorJid: pollCreatorJid || voterJid,
        pollMsgId,
        pollEncKey,
        voterJid: voterJid || pollCreatorJid,
      }
    );
    const optionIndexes = normalizeOptionIndexes(
      decrypted?.selectedOptions ||
        pollUpdateVote.vote?.selectedOptions ||
        []
    );
    const optionNames = mapOptionNames(optionIndexes, pollMeta.pollOptions);
    const payload = {
      messageKey: sanitizePollMessageKey(pollKey, pollMsgId),
      pollCreatorJid: pollCreatorJid || null,
      voterJid: voterJid || null,
      votedOptionIndexes: optionIndexes,
      votedOptionNames: optionNames,
    };
    if (pollMeta.pollTitle) payload.pollTitle = pollMeta.pollTitle;
    if (pollMeta.selectableOptionsCount != null) {
      payload.selectableOptionsCount = pollMeta.selectableOptionsCount;
    }
    if (pollMeta.pollOptions?.length) payload.pollOptions = pollMeta.pollOptions;
    const ts =
      pollUpdateVote?.timestamp ??
      pollUpdateVote?.vote?.timestamp ??
      pollUpdateVote?.vote?.ts;
    if (ts != null) payload.timestampMs = Number(ts);
    return send(res, "SUCCESS", {
      message: "Poll vote decrypted",
      result: payload,
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});
router.post("/whatsapp/validate/phone", async (req, res) => {
  try {
    const phoneInput = readStr(req, ["phone", "number"]);
    const countryInput = readStr(req, ["country", "region"]);
    if (!phoneInput) {
      return send(res, "MISSING_PARAMETER", {
        message: "phone is required",
        result: null,
      });
    }
    const digits = normalizePhoneDigits(phoneInput, countryInput);
    if (!digits) {
      return send(res, "INVALID_PARAMETER", {
        message: "Invalid phone number",
        result: null,
      });
    }
    const resolved = await resolveSessionFromReq(req, { autoPick: true });
    if (resolved.error) return resolved.error(res);
    const session = resolved.session;
    const jid = `${digits}@s.whatsapp.net`;
    let exists = false;
    let finalJid = jid;
    let lid = null;
    try {
      const query = await withQueue(session, async () =>
        session.sock.onWhatsApp(jid)
      );
      const first = Array.isArray(query) ? query[0] : query;
      exists = !!(first?.exists ?? first?.isOnWhatsApp ?? first?.isIn);
      if (first?.jid) finalJid = normalizeUserJid(first.jid);
      lid =
        first?.lid ||
        first?.lidJid ||
        findLidByJid(session.sock, finalJid) ||
        null;
    } catch {}
    return send(res, "SUCCESS", {
      message: "Phone validation complete",
      result: {
        data: {
          exists,
          e164: formatE164(digits),
          jid: finalJid,
          lid,
          country: guessCountryFromDigits(digits),
        },
      },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/whatsapp/validate/jid", async (req, res) => {
  try {
    const input = readStr(req, ["jid", "id", "target"]);
    if (!input) {
      return send(res, "MISSING_PARAMETER", {
        message: "jid is required",
        result: null,
      });
    }
    const normalized = normalizeUserJid(input);
    const type = guessJidType(normalized);
    const resolved = await resolveSessionFromReq(req, { autoPick: true });
    if (resolved.error) return resolved.error(res);
    const session = resolved.session;
    let exists = false;
    try {
      if (type === "user" || type === "unknown") {
        const query = await withQueue(session, async () =>
          session.sock.onWhatsApp(normalized)
        );
        const first = Array.isArray(query) ? query[0] : query;
        exists = !!(first?.exists ?? first?.isOnWhatsApp ?? first?.isIn);
      } else if (type === "group") {
        await withQueue(session, async () =>
          session.sock.groupMetadata(normalized)
        );
        exists = true;
      } else if (type === "broadcast") {
        exists = normalized.toLowerCase() === "status@broadcast";
      } else {
        exists = false;
      }
    } catch {
      exists = false;
    }
    return send(res, "SUCCESS", {
      message: "JID validation complete",
      result: {
        data: {
          exists,
          type: type === "unknown" ? "user" : type,
        },
      },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/whatsapp/resolve/jid-or-lid", async (req, res) => {
  try {
    const input = readStr(req, ["input", "value", "id"]);
    if (!input) {
      return send(res, "MISSING_PARAMETER", {
        message: "input is required",
        result: null,
      });
    }
    const resolved = await resolveSessionFromReq(req, { autoPick: true });
    if (resolved.error) return resolved.error(res);
    const session = resolved.session;
    let type = "invalid";
    let jid = "";
    let lid = "";
    const trimmed = input.trim();
    if (trimmed.endsWith("@lid")) {
      type = "lid";
      lid = trimmed;
      jid = findJidByLid(session.sock, lid) || "";
    } else if (trimmed.includes("@")) {
      type = "jid";
      jid = normalizeUserJid(trimmed);
      lid = findLidByJid(session.sock, jid) || "";
    } else if (digitsOnly(trimmed)) {
      type = "jid";
      const digits = normalizePhoneDigits(trimmed);
      jid = digits ? `${digits}@s.whatsapp.net` : "";
      lid = findLidByJid(session.sock, jid) || "";
    }
    const isValid = type !== "invalid" && (!!jid || !!lid);
    return send(res, "SUCCESS", {
      message: "Identifier resolved",
      result: {
        data: {
          isValid,
          type: isValid ? type : "invalid",
          lid: lid || null,
          jid: jid || null,
          country: jid ? guessCountryFromDigits(jid.split("@")[0]) : null,
        },
      },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});
router.post("/media/thumbnail", async (req, res) => {
  try {
    const fileInput =
      req.body?.file || req.body?.data || req.body?.url || req.body?.source;
    const type = readStr(req, ["type"]);
    const width = clampNumber(req.body?.width ?? 320, 16, 1024, 320);
    const height = clampNumber(req.body?.height ?? width, 16, 1024, width);
    const outputMode = readStr(req, ["output"]) || "base64";
    if (!fileInput) {
      return send(res, "MISSING_PARAMETER", {
        message: "file is required",
        result: null,
      });
    }
    if (!type) {
      return send(res, "INVALID_PARAMETER", {
        message: "type must be image or video",
        result: null,
      });
    }
    const { buffer } = await loadBinaryInput(fileInput, {
      sourceHint: "base64",
      allowPath: true,
      fieldName: "file",
    });
    const data = [];
    if (type.toLowerCase() === "image") {
      const sharpLib = await getSharpInstance();
      if (!sharpLib) {
        return send(res, "SERVICE_UNAVAILABLE", {
          message: "Image thumbnail requires Sharp",
          result: null,
        });
      }
      const thumb = await sharpLib(buffer, { failOnError: false })
        .resize({ width, height, fit: "cover" })
        .toBuffer();
      const delivered = await deliverBinary(thumb, {
        output: outputMode,
        mimeType: "image/jpeg",
        extension: "jpg",
        label: "thumb",
      });
      data.push({ thumbnail: delivered.value, meta: delivered.meta });
    } else if (type.toLowerCase() === "video") {
      if (!ffmpegStatic) {
        return send(res, "SERVICE_UNAVAILABLE", {
          message: "FFmpeg is not available",
          result: null,
        });
      }
      const frames = await extractVideoThumbnails(buffer, {
        width,
        height,
        count: clampNumber(
          req.body?.count ?? VIDEO_THUMB_COUNT,
          1,
          6,
          VIDEO_THUMB_COUNT
        ),
      });
      for (const frame of frames) {
        const delivered = await deliverBinary(frame, {
          output: outputMode,
          mimeType: "image/jpeg",
          extension: "jpg",
          label: "thumb",
        });
        data.push({ thumbnail: delivered.value, meta: delivered.meta });
      }
    } else {
      return send(res, "INVALID_PARAMETER", {
        message: "type must be image or video",
        result: null,
      });
    }
    return send(res, "SUCCESS", {
      message: "Thumbnails generated",
      result: { data },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/media/image", async (req, res) => {
  try {
    const fileInput =
      req.body?.file || req.body?.data || req.body?.url || req.body?.source;
    const actions = req.body?.actions || {};
    const outputMode = readStr(req, ["output"]) || "base64";
    if (!fileInput) {
      return send(res, "MISSING_PARAMETER", {
        message: "file is required",
        result: null,
      });
    }
    const sharpLib = await getSharpInstance();
    if (!sharpLib) {
      return send(res, "SERVICE_UNAVAILABLE", {
        message: "Image processing requires Sharp",
        result: null,
      });
    }
    const { buffer } = await loadBinaryInput(fileInput, {
      sourceHint: "base64",
      allowPath: true,
      fieldName: "file",
    });
    let transformer = sharpLib(buffer, { failOnError: false }).rotate();
    const resize = actions.resize || {};
    const convert = String(actions.convert || "").toLowerCase();
    const compress = actions.compress || {};
    const actionsPerformed = {
      converted: !!convert,
      resized:
        Number.isFinite(resize.width) || Number.isFinite(resize.height),
      compressed: typeof compress.quality === "number",
    };
    if (actionsPerformed.resized) {
      transformer = transformer.resize({
        width: resize.width,
        height: resize.height,
        fit: resize.fit || "cover",
      });
    }
    let targetFormat = convert || (await transformer.metadata()).format || "png";
    if (!SUPPORTED_IMAGE_FORMATS.has(targetFormat)) {
      targetFormat = "png";
    }
    const quality = clampNumber(compress.quality ?? 80, 1, 100, 80);
    transformer = transformer.toFormat(
      targetFormat === "jpg" ? "jpeg" : targetFormat,
      { quality }
    );
    const processed = await transformer.toBuffer();
    const meta = await sharpLib(processed).metadata();
    const delivered = await deliverBinary(processed, {
      output: outputMode,
      mimeType:
        targetFormat === "jpg" || targetFormat === "jpeg"
          ? "image/jpeg"
          : `image/${targetFormat}`,
      extension: targetFormat === "jpeg" ? "jpg" : targetFormat,
      label: "image",
    });
    return send(res, "SUCCESS", {
      message: "Image processed",
      result: {
        data: delivered.value,
        details: {
          format:
            targetFormat === "jpg" || targetFormat === "jpeg"
              ? "jpg"
              : targetFormat,
          width: meta.width,
          height: meta.height,
          size: processed.length,
        },
        actionsPerformed,
        createdAt: new Date().toISOString(),
        meta: delivered.meta,
      },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});
router.post("/uuid/generate", (req, res) => {
  try {
    const type = (readStr(req, ["type"]) || "uuid").toLowerCase();
    const version = (readStr(req, ["version"]) || "v4").toLowerCase();
    const count = clampNumber(req.body?.count ?? 1, 1, 100, 1);
    const format = readStr(req, ["format"]);
    const namespace = readStr(req, ["namespace"]);
    const name = readStr(req, ["name"]);
    const data = [];
    if (type === "ulid") {
      for (let i = 0; i < count; i++) {
        const raw = ulid();
        if (!format) {
          data.push(raw);
        } else {
          let idx = 0;
          let formatted = "";
          for (const ch of format) {
            if (ch === "x" || ch === "X") {
              formatted += raw[idx] || "";
              idx++;
            } else {
              formatted += ch;
            }
          }
          data.push(formatted);
        }
      }
    } else {
      for (let i = 0; i < count; i++) {
        switch (version) {
          case "v1":
            data.push(uuidv1());
            break;
          case "v3":
            if (!namespace || !name) {
              throw new Error("namespace and name required for v3");
            }
            data.push(uuidv3(name, namespace));
            break;
          case "v5":
            if (!namespace || !name) {
              throw new Error("namespace and name required for v5");
            }
            data.push(uuidv5(name, namespace));
            break;
          case "nil":
            data.push(NIL_UUID);
            break;
          default:
            data.push(uuidv4());
        }
      }
    }
    return send(res, "SUCCESS", {
      message: "Identifiers generated",
      result: { data },
    });
  } catch (err) {
    return send(res, "INVALID_PARAMETER", {
      message: err?.message || "Invalid parameters",
      result: null,
    });
  }
});

router.post("/uuid/validate", (req, res) => {
  try {
    const type = (readStr(req, ["type"]) || "uuid").toLowerCase();
    const value = readStr(req, ["value"]);
    if (!value) {
      return send(res, "MISSING_PARAMETER", {
        message: "value is required",
        result: null,
      });
    }
    if (type === "ulid") {
      const isValid = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value);
      return send(res, "SUCCESS", {
        message: "Validation complete",
        result: {
          data: {
            isValid,
            type: "ulid",
            version: null,
          },
        },
      });
    }
    const isValid = uuidValidate(value);
    return send(res, "SUCCESS", {
      message: "Validation complete",
      result: {
        data: {
          isValid,
          type: "uuid",
          version: isValid ? `v${uuidVersion(value)}` : null,
        },
      },
    });
  } catch (err) {
    return send(res, "INVALID_PARAMETER", {
      message: err?.message || "Invalid UUID",
      result: null,
    });
  }
});

router.post("/crypto/hash", async (req, res) => {
  try {
    const algo = readStr(req, ["algo", "algorithm"]) || "sha256";
    const output = readStr(req, ["output"]) || "hex";
    const input =
      req.body?.input || req.body?.data || req.body?.file || req.body?.source;
    if (!input) {
      return send(res, "MISSING_PARAMETER", {
        message: "input is required",
        result: null,
      });
    }
    const { buffer } = await loadBinaryInput(input, {
      sourceHint: "base64",
      allowPath: true,
      fieldName: "input",
    });
    let hash;
    try {
      hash = crypto.createHash(algo.toLowerCase()).update(buffer).digest(output);
    } catch {
      return send(res, "INVALID_PARAMETER", {
        message: "Unsupported hash algorithm",
        result: null,
      });
    }
    return send(res, "SUCCESS", {
      message: "Hash generated",
      result: { data: hash },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/crypto/hmac", async (req, res) => {
  try {
    const algo = readStr(req, ["algo", "algorithm"]) || "sha256";
    const output = readStr(req, ["output"]) || "hex";
    const key = readStr(req, ["key", "secret"]);
    const input =
      req.body?.input || req.body?.data || req.body?.file || req.body?.source;
    if (!input || !key) {
      return send(res, "MISSING_PARAMETER", {
        message: "input and key are required",
        result: null,
      });
    }
    const { buffer } = await loadBinaryInput(input, {
      sourceHint: "base64",
      allowPath: true,
      fieldName: "input",
    });
    let hmac;
    try {
      hmac = crypto
        .createHmac(algo.toLowerCase(), key)
        .update(buffer)
        .digest(output);
    } catch {
      return send(res, "INVALID_PARAMETER", {
        message: "Unsupported HMAC algorithm",
        result: null,
      });
    }
    return send(res, "SUCCESS", {
      message: "HMAC generated",
      result: { data: hmac },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/base64", async (req, res) => {
  try {
    const action = (readStr(req, ["action"]) || "encode").toLowerCase();
    const outputMode = readStr(req, ["output"]) || "string";
    const input =
      req.body?.input || req.body?.data || req.body?.file || req.body?.source;
    if (!input) {
      return send(res, "MISSING_PARAMETER", {
        message: "input is required",
        result: null,
      });
    }
    if (action === "encode") {
      const { buffer } = await loadBinaryInput(input, {
        allowPath: true,
        fieldName: "input",
      });
      return send(res, "SUCCESS", {
        message: "Encoded to base64",
        result: { data: buffer.toString("base64") },
      });
    }
    if (action === "decode") {
      const { buffer } = await loadBinaryInput(input, {
        sourceHint: "base64",
        fieldName: "input",
      });
      const delivered = await deliverBinary(buffer, {
        output: outputMode,
        mimeType: "application/octet-stream",
        extension: "bin",
        label: "base64",
      });
      return send(res, "SUCCESS", {
        message: "Decoded from base64",
        result: { data: delivered.value, meta: delivered.meta },
      });
    }
    return send(res, "INVALID_PARAMETER", {
      message: "action must be encode or decode",
      result: null,
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Internal error",
      result: null,
    });
  }
});

export default router;
