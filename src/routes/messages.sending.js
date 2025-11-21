import express from "express";
import axios from "axios";
import mime from "mime-types";

import {
  getSession,
  listSessions,
  getCachedMessage,
} from "../whatsapp/baileysClient.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { normalizePhoneDigits } from "../utils/phone.js";
import {
  formatButtonsMessage,
  formatListMessage,
} from "../whatsapp/interactiveMessages.js";
import { compressByKind, compressAudioBuffer } from "../services/compress.js";

const router = express.Router();
const PER_MEDIA_MB = Number(config.uploadLimits?.perMediaMb || 1024);
const PER_FILE_MB = Number(config.uploadLimits?.perFileMb || 2048);
const PER_MEDIA_BYTES = Math.max(1, PER_MEDIA_MB) * 1024 * 1024;
const PER_FILE_BYTES = Math.max(1, PER_FILE_MB) * 1024 * 1024;
const rawFileMb = Number(config.uploadLimits?.rawFileMb || PER_FILE_MB || 2000);
const rawAny = express.raw({ type: () => true, limit: `${rawFileMb}mb` });

const MIME_EXTENSION_OVERRIDES = new Map(
  Object.entries({
    "video/3gp": "3gp",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/opus": "opus",
    "audio/m4a": "m4a",
    "application/vnd.ms-access": "mdb",
    "application/x-zip-compressed": "zip",
    "application/x-gzip": "gz",
    "application/sql": "sql",
    "application/x-yaml": "yaml",
    "application/x-fictionbook+xml": "fb2",
    "application/illustrator": "ai",
    "application/photoshop": "psd",
    "application/vnd.adobe.photoshop": "psd",
    "application/x-mobipocket-ebook": "mobi",
    "text/markdown": "md",
    "application/postscript": "ps",
  })
);
const FILE_MIME_ALLOWLIST = new Set(
  (Array.isArray(config.files?.mimeAllowlist) ? config.files.mimeAllowlist : [])
    .map((value) => normalizeMimeValue(value))
    .filter(Boolean)
);
const GENERIC_FILE_MIME = "application/octet-stream";
const GENERIC_FILE_MIME_ALLOWED = FILE_MIME_ALLOWLIST.has(GENERIC_FILE_MIME);
const VOICE_NOTE_MIME = "audio/ogg; codecs=opus";

function buildLimitError(limitMb, code, message) {
  return {
    status: false,
    code,
    message: `${message} (limit ${limitMb}MB)`,
    results: null,
  };
}

/* ------------------------ helpers ------------------------ */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendWithRetry(fn, retries = 2, delayMs = 600) {
  let lastErr;
  const attempts = Math.max(0, Number(retries) || 0);
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= attempts) throw lastErr;
      if (delayMs) await sleep(Math.max(0, delayMs));
    }
  }
  throw lastErr;
}

function extractTimestampSeconds(resp) {
  try {
    const ts = resp?.messageTimestamp;
    if (typeof ts === "number") return Math.floor(ts);
    if (typeof ts === "bigint") return Number(ts);
    if (ts && typeof ts === "object") {
      const n =
        typeof ts.toNumber === "function" ? ts.toNumber() : Number(ts.low ?? 0);
      if (Number.isFinite(n)) return Math.floor(n);
    }
  } catch {}
  return Math.floor(Date.now() / 1000);
}

function cacheSentMessage(s, resp) {
  try {
    const id = resp?.key?.id || resp?.message?.key?.id;
    if (!id) return;
    if (!s?.msgCache) return;
    s.msgCache.set(id, resp);
    if (s.msgCache.size > 1000) {
      const oldest = s.msgCache.keys().next().value;
      if (oldest) s.msgCache.delete(oldest);
    }
  } catch {}
}

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
function normalizeBody(body) {
  if (Array.isArray(body)) return body[0] || {};
  if (body && typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body && typeof body === "object" ? body : {};
}

function getBoundary(ct) {
  const s = String(ct || "");
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(s);
  return m ? m[1] || m[2] : null;
}

function parseHeaders(block) {
  const out = {};
  const lines = block.split(/\r?\n/);
  for (const ln of lines) {
    const idx = ln.indexOf(":");
    if (idx < 0) continue;
    const k = ln.slice(0, idx).trim().toLowerCase();
    const v = ln.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

function parseContentDisposition(v = "") {
  const o = {};
  const parts = String(v)
    .split(";")
    .map((s) => s.trim());
  for (const p of parts) {
    const [k, rawVal] = p.split("=");
    if (!k) continue;
    const key = k.toLowerCase();
    if (!rawVal) continue;
    const val = rawVal.replace(/^"|"$/g, "");
    if (key === "name") o.name = val;
    if (key === "filename") o.filename = val;
  }
  return o;
}

function baseNameFromHint(nameHint = "", mimeStr = "", preferredExt = "") {
  try {
    const s = String(nameHint || "");
    const urlIdx = s.indexOf("?");
    const clean = urlIdx >= 0 ? s.slice(0, urlIdx) : s;
    const parts = clean.split("/");
    let last = parts[parts.length - 1] || "";
    if (!last || /^(https?:)?$/i.test(last)) last = "file";
    if (!/\.[A-Za-z0-9]+$/.test(last)) {
      const ext = preferredExt || resolveMimeExtension(mimeStr) || "bin";
      return `${last}.${ext}`;
    }
    return last;
  } catch {
    const ext = preferredExt || resolveMimeExtension(mimeStr) || "bin";
    return `file.${ext}`;
  }
}

function parseMultipartAll(buf, boundary) {
  const out = { fields: {}, files: [] };
  if (!Buffer.isBuffer(buf) || !boundary) return out;

  const bOpen = Buffer.from(`--${boundary}\r\n`);
  const bSep = Buffer.from(`\r\n--${boundary}\r\n`);
  const bEnd = Buffer.from(`\r\n--${boundary}--`);

  let pos = buf.indexOf(bOpen);
  if (pos === -1) return out;
  pos += bOpen.length;

  while (pos < buf.length) {
    const hdrEnd = buf.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (hdrEnd === -1) break;
    const headersRaw = buf.slice(pos, hdrEnd).toString("utf8");
    const headers = parseHeaders(headersRaw);
    pos = hdrEnd + 4;
    let nextSep = buf.indexOf(bSep, pos);
    let nextEnd = buf.indexOf(bEnd, pos);
    let partEnd;
    let isClosing = false;
    if (nextEnd !== -1 && (nextSep === -1 || nextEnd < nextSep)) {
      partEnd = nextEnd;
      isClosing = true;
    } else if (nextSep !== -1) {
      partEnd = nextSep;
    } else {
      partEnd = buf.length;
    }

    const body = buf.slice(pos, partEnd);
    pos = isClosing ? partEnd + bEnd.length : partEnd + bSep.length;

    const cd = headers["content-disposition"] || "";
    const disp = parseContentDisposition(cd);
    const name = disp.name || "file";
    const filename = disp.filename || "";
    const partMime = (headers["content-type"] || "application/octet-stream")
      .split(";")[0]
      .trim();

    if (filename) {
      out.files.push({
        name,
        filename: filename || `file.${mime.extension(partMime) || "bin"}`,
        headers,
        partMime,
        data: Buffer.from(body),
      });
    } else {
      let val = body.toString("utf8");
      if (val.charCodeAt(0) === 0xfeff) val = val.slice(1);
      val = val.replace(/\r?\n$/, "");
      if (name in out.fields) {
        const prev = out.fields[name];
        out.fields[name] = Array.isArray(prev) ? [...prev, val] : [prev, val];
      } else {
        out.fields[name] = val;
      }
    }

    if (isClosing) break;
  }

  return out;
}

function toArrayMaybe(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      const j = JSON.parse(s);
      return Array.isArray(j) ? j : [s];
    } catch {
      if (s.includes(","))
        return s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      return [s];
    }
  }
  return [];
}

function normalizeFilesInput(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((item) => item !== undefined);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (parsed != null) return [parsed];
    } catch {
      return [value];
    }
  }
  return [value];
}

function parseUrlEncodedBody(raw) {
  try {
    const params = new URLSearchParams(raw);
    const fields = {};
    for (const [key, value] of params.entries()) {
      if (key in fields) {
        const prev = fields[key];
        fields[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
      } else {
        fields[key] = value;
      }
    }
    return fields;
  } catch {
    return {};
  }
}

function parseHybridBody(req) {
  const raw = req.body;
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (Buffer.isBuffer(raw)) {
    if (ct.startsWith("multipart/form-data")) {
      const boundary = getBoundary(ct);
      if (!boundary) return { fields: {}, files: [] };
      return parseMultipartAll(raw, boundary);
    }
    if (
      ct.includes("application/json") ||
      ct.includes("+json") ||
      ct.startsWith("text/json")
    ) {
      return { fields: normalizeBody(raw.toString("utf8")), files: [] };
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
      return { fields: parseUrlEncodedBody(raw.toString("utf8")), files: [] };
    }
    if (!raw.length) return { fields: {}, files: [] };
    return {
      fields: {},
      files: [
        {
          name: "file",
          filename: baseNameFromHint(
            "upload",
            ct,
            resolveMimeExtension(ct) || "bin"
          ),
          headers: {},
          partMime: ct || "application/octet-stream",
          data: Buffer.from(raw),
        },
      ],
    };
  }
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) {
    return { fields: raw, files: [] };
  }
  if (typeof raw === "string" && raw.trim()) {
    return { fields: normalizeBody(raw), files: [] };
  }
  return { fields: {}, files: [] };
}

function mergeFieldsWithQuery(fields, query = {}) {
  const merged = { ...(query || {}) };
  if (fields && typeof fields === "object" && !Buffer.isBuffer(fields)) {
    Object.assign(merged, fields);
  }
  return normalizeBody(merged);
}

function selectFileEntry(files, names = []) {
  if (!Array.isArray(files) || !files.length) return null;
  if (Array.isArray(names) && names.length) {
    for (const name of names) {
      const found = files.find(
        (file) =>
          file?.name?.toLowerCase() === String(name || "").toLowerCase() ||
          file?.filename?.toLowerCase() === String(name || "").toLowerCase()
      );
      if (found) return found;
    }
  }
  return files[0];
}

function resolveUploadedFile(entry) {
  if (!entry || !entry.data) return null;
  let data;
  if (Buffer.isBuffer(entry.data)) data = entry.data;
  else if (typeof entry.data === "string") {
    try {
      data = Buffer.from(entry.data, "base64");
    } catch {
      data = Buffer.from(entry.data);
    }
  } else {
    data = Buffer.from(entry.data || []);
  }
  const mimeType =
    entry.partMime ||
    mime.lookup(entry.filename || "") ||
    "application/octet-stream";
  return { buffer: data, mime: mimeType, filename: entry.filename || null };
}

function firstStringValue(val) {
  if (Array.isArray(val)) {
    for (const item of val) {
      const res = firstStringValue(item);
      if (res) return res;
    }
    return null;
  }
  if (
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "bigint" ||
    typeof val === "boolean"
  ) {
    const str = String(val).trim();
    return str || null;
  }
  return null;
}

function pickFirstString(obj, keys = []) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = firstStringValue(obj[key]);
    if (value) return value;
  }
  return null;
}

function normalizeReplyIdInput(value) {
  const str = firstStringValue(value);
  if (!str) return undefined;
  if (/^(?:null|undefined)$/i.test(str)) return undefined;
  return str;
}

function summarizeListStructure({ lists, list, sections }) {
  const summary = { sectionCount: 0, rowCount: 0 };
  const addSections = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const section of entries) {
      if (!section || typeof section !== "object") continue;
      summary.sectionCount += 1;
      const rows = Array.isArray(section.rows)
        ? section.rows.filter((row) => row != null)
        : Array.isArray(section.items)
        ? section.items.filter((row) => row != null)
        : [];
      summary.rowCount += rows.length;
    }
  };
  const addFromContainer = (container) => {
    if (!container || typeof container !== "object") return;
    if (Array.isArray(container.sections) && container.sections.length) {
      addSections(container.sections);
      return;
    }
    if (Array.isArray(container.rows) && container.rows.length) {
      addSections([{ rows: container.rows }]);
    }
  };
  if (Array.isArray(lists) && lists.length) {
    for (const entry of lists) addFromContainer(entry);
  } else if (list && typeof list === "object") {
    addFromContainer(list);
  } else if (Array.isArray(sections) && sections.length) {
    addSections(sections);
  }
  return summary;
}

function parseDataUriString(input) {
  if (typeof input !== "string" || !input.startsWith("data:")) return null;
  const idx = input.indexOf(",");
  if (idx === -1) return null;
  const header = input.slice(5, idx);
  const b64 = input.slice(idx + 1);
  const mimeType = header.split(";")[0] || "application/octet-stream";
  try {
    return { buffer: Buffer.from(b64, "base64"), mime: mimeType };
  } catch {
    return null;
  }
}

function tryDecodeBase64Payload(value) {
  if (typeof value !== "string") return null;
  let trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  if (trimmed.startsWith("data:")) return null;
  trimmed = trimmed.replace(/^base64[,:\s]*/i, "");
  const collapsed = trimmed.replace(/\s+/g, "");
  if (!collapsed) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(collapsed)) return null;
  if (collapsed.length % 4 === 1) return null;
  const isLongEnough = collapsed.length >= 16;
  const hasDistinctChars = /[0-9+/=_-]/.test(collapsed);
  if (!isLongEnough && !hasDistinctChars) return null;
  const sanitized = collapsed.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = sanitized.length % 4 === 0 ? 0 : 4 - (sanitized.length % 4);
  const padded = sanitized + "=".repeat(padLen);
  try {
    const buf = Buffer.from(padded, "base64");
    if (!buf.length) return null;
    const reencoded = buf.toString("base64").replace(/=+$/, "");
    const sanitizedNoPad = sanitized.replace(/=+$/, "");
    if (reencoded !== sanitizedNoPad) return null;
    return buf;
  } catch {
    return null;
  }
}

async function resolveBufferedInput({
  body,
  uploads,
  fieldKeys = [],
  allowDataUri = true,
}) {
  const fileEntry = selectFileEntry(uploads, fieldKeys);
  const resolvedUpload = resolveUploadedFile(fileEntry);
  if (resolvedUpload) {
    return {
      buffer: resolvedUpload.buffer,
      mime: resolvedUpload.mime,
      filename: resolvedUpload.filename || fileEntry?.name || null,
      source: null,
    };
  }
  const raw = pickFirstString(body, fieldKeys);
  if (!raw) return null;
  if (allowDataUri && raw.startsWith("data:")) {
    const parsed = parseDataUriString(raw);
    if (parsed)
      return {
        buffer: parsed.buffer,
        mime: parsed.mime,
        filename: null,
        source: raw,
      };
  }
  const base64Buf = tryDecodeBase64Payload(raw);
  if (base64Buf) {
    return {
      buffer: base64Buf,
      mime: null,
      filename: null,
      source: null,
    };
  }
  try {
    const fetched = await fetchBuffer(raw);
    let inferredName = null;
    try {
      const parsedUrl = new URL(raw);
      const last = parsedUrl.pathname.split("/").pop();
      inferredName = last || null;
    } catch {}
    return {
      buffer: fetched.buffer,
      mime: fetched.mime,
      filename: inferredName,
      source: raw,
    };
  } catch (err) {
    logger.warn(
      { err: err?.message, source: raw },
      "resolveBufferedInput fetch failed"
    );
    throw err;
  }
}

function parseMaybeJSON(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return v;
}

function parseCompressionObject(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    const parsed = parseMaybeJSON(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return { ...parsed };
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  return {};
}

function buildCompressionOptions(defaultEnable, ...inputs) {
  const merged = {};
  for (const input of inputs) {
    Object.assign(merged, parseCompressionObject(input));
  }
  merged.enable = parseBoolean(merged.enable, defaultEnable);
  return merged;
}

function toStringArray(v) {
  if (v == null) return [];
  let val = parseMaybeJSON(v);
  if (Array.isArray(val))
    return val
      .map((x) => String(x))
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof val === "string") {
    if (val.includes(","))
      return val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return [val.trim()].filter(Boolean);
  }
  return [];
}
function parseRecipientStrings(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseRecipientStrings(item));
  }
  const parsed = parseMaybeJSON(value);
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => parseRecipientStrings(item));
  }
  if (
    typeof parsed === "number" ||
    typeof parsed === "bigint" ||
    typeof parsed === "boolean"
  ) {
    return [String(parsed)];
  }
  if (typeof parsed === "string") {
    return parsed
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
function parseDestinationJids(value) {
  const rawList = parseRecipientStrings(value);
  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    const jid = jidify(raw);
    if (jid && !seen.has(jid)) {
      seen.add(jid);
      out.push(jid);
    }
  }
  return out;
}
function formatSendResponse(typeLabel, results) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  const base = typeLabel || "Message";
  return {
    message:
      list.length > 1
        ? `${base} sent (${list.length} recipients)`
        : `${base} sent`,
    results: list,
  };
}

function normalizeLocationFromBody(body) {
  let loc = body.location ?? body.loc ?? null;
  loc = parseMaybeJSON(loc);
  let lat, lng, name, address;
  if (Array.isArray(loc) && loc.length >= 2) {
    lat = Number(loc[0]);
    lng = Number(loc[1]);
  } else if (loc && typeof loc === "object") {
    lat = Number(loc.latitude ?? loc.lat);
    lng = Number(loc.longitude ?? loc.lng);
    name = loc.name || undefined;
    address = loc.address || undefined;
  } else if (typeof loc === "string") {
    if (loc.includes(",")) {
      const [a, b] = loc.split(",").map((s) => s.trim());
      lat = Number(a);
      lng = Number(b);
    }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    lat = Number(body.latitude ?? body.lat);
    lng = Number(body.longitude ?? body.lng);
    name = name ?? body.name;
    address = address ?? body.address;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng, name, address };
}

function normalizePollFromBody(body) {
  let p = parseMaybeJSON(body.poll);
  if (!p) p = {};
  if (Array.isArray(p)) {
    p = {
      question: body.question || body.name || "",
      options: p,
      maxSelection: body.maxSelection ?? body.selectableCount ?? 1,
    };
  }
  if (typeof p === "string") {
    p = {
      question: p,
      options: toStringArray(body.options),
      maxSelection: body.maxSelection ?? body.selectableCount ?? 1,
    };
  }
  const question = String(
    p.question || p.name || body.question || body.name || ""
  ).trim();
  const options = toStringArray(p.options?.length ? p.options : body.options);
  const maxSel = clampNumber(
    p.maxSelection ??
      p.selectableCount ??
      body.maxSelection ??
      body.selectableCount ??
      1,
    1,
    Math.max(1, options.length),
    1
  );
  return { question, options, maxSelection: maxSel };
}
function readAnyStr(req, keys = []) {
  for (const k of keys) {
    const v1 = req?.body?.[k];
    if (typeof v1 === "string" && v1.trim()) return v1.trim();
    const v2 = req?.query?.[k];
    if (typeof v2 === "string" && v2.trim()) return v2.trim();
    const v3 = req?.params?.[k];
    if (typeof v3 === "string" && v3.trim()) return v3.trim();
  }
  return "";
}

function normalizePresenceInputValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed || trimmed === "") return trimmed;
  }
  return undefined;
}

function readPresenceInput(req, fallback) {
  const preferred = normalizePresenceInputValue(fallback);
  if (preferred !== undefined) return preferred;
  const sources = [req?.body, req?.query, req?.params];
  for (const src of sources) {
    if (
      !src ||
      typeof src !== "object" ||
      Buffer.isBuffer(src) ||
      Array.isArray(src)
    ) {
      continue;
    }
    const val = normalizePresenceInputValue(src.presence);
    if (val !== undefined) return val;
  }
  return undefined;
}
async function fetchBuffer(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: Number(config.uploadLimits?.fetchTimeoutMs || 300000),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  let ct = resp.headers["content-type"] || "";
  if (!ct || ct === "application/octet-stream") {
    const guess = mime.lookup(url) || "";
    if (guess) ct = guess;
  }
  return {
    buffer: Buffer.from(resp.data),
    mime: ct || "application/octet-stream",
  };
}

function parseDataUri(dataUri) {
  try {
    const s = String(dataUri || "");
    if (!s.startsWith("data:")) return null;
    const idx = s.indexOf(",");
    if (idx < 0) return null;
    const header = s.slice(5, idx);
    const mimeType = header.split(";")[0] || "application/octet-stream";
    const b64 = s.slice(idx + 1);
    const buf = Buffer.from(b64, "base64");
    return { buffer: buf, mime: mimeType };
  } catch {
    return null;
  }
}

function extFromName(name = "") {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name));
  return m ? m[1].toLowerCase() : null;
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
    if (
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(buf[2]) &&
      [0x04, 0x06, 0x08].includes(buf[3])
    )
      return "application/zip";
    if (buf[0] === 0x1f && buf[1] === 0x8b) return "application/gzip";
    if (buf.slice(0, 4).toString("ascii") === "Rar!")
      return "application/x-rar-compressed";
    if (
      buf.slice(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
    )
      return "application/x-7z-compressed";
    if (buf[0] === 0x4d && buf[1] === 0x5a) return "application/x-msdownload";
  } catch {}
  return null;
}

function normalizeMimeValue(value = "") {
  if (!value) return "";
  return String(value).split(";")[0].trim().toLowerCase();
}

function resolveMimeExtension(mimeStr, fallbackExt = "") {
  const normalized = normalizeMimeValue(mimeStr);
  if (!normalized) return fallbackExt || "";
  return (
    MIME_EXTENSION_OVERRIDES.get(normalized) ||
    mime.extension(normalized) ||
    fallbackExt ||
    ""
  );
}

function coerceMimeToAllowlist(mimeStr) {
  const normalized = normalizeMimeValue(mimeStr);
  if (!FILE_MIME_ALLOWLIST.size) return normalized || GENERIC_FILE_MIME;
  if (normalized && FILE_MIME_ALLOWLIST.has(normalized)) return normalized;
  if (GENERIC_FILE_MIME_ALLOWED) return GENERIC_FILE_MIME;
  return normalized || GENERIC_FILE_MIME;
}

function isMimeAllowed(mimeStr) {
  if (!FILE_MIME_ALLOWLIST.size) return true;
  const normalized = normalizeMimeValue(mimeStr);
  if (normalized && FILE_MIME_ALLOWLIST.has(normalized)) return true;
  if (GENERIC_FILE_MIME_ALLOWED) return true;
  return false;
}
function detectMimeFrom(urlOrName, headerCT, buffer) {
  const byHeader = String(headerCT || "").toLowerCase();
  if (byHeader && !byHeader.startsWith("multipart/")) return byHeader;
  const fromExt = extFromName(urlOrName || "");
  if (fromExt) return mime.lookup(fromExt) || null;
  const magic = magicMime(buffer);
  if (magic) return magic;
  const fromUrl = mime.lookup(String(urlOrName || "")) || null;
  return fromUrl;
}

function normalizeMediaType(mimeStr, hint) {
  const m = String(mimeStr || "").toLowerCase();
  if (
    !m &&
    hint &&
    ["image", "video", "audio", "gif", "document"].includes(hint)
  )
    return hint;
  if (m.includes("gif")) return "gif";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (hint && ["image", "video", "audio", "gif", "document"].includes(hint))
    return hint;
  if (m === "application/pdf" || m.startsWith("application/"))
    return "document";
  return "document";
}

function coerceAudioMime(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("audio/")) return raw;
  if (raw.includes("ogg") || raw.includes("opus")) return "audio/ogg";
  if (raw.includes("mpeg") || raw.includes("mp3")) return "audio/mpeg";
  if (raw.includes("wav")) return "audio/wav";
  if (raw.includes("aac")) return "audio/aac";
  if (raw.includes("m4a") || raw.includes("mp4")) return "audio/mp4";
  if (raw.includes("3gp")) return "audio/3gpp";
  if (raw.includes("amr")) return "audio/amr";
  return "";
}

function resolveAudioMimeType(preferredMime, descriptor = {}) {
  const lookup = (hint) => {
    if (!hint) return "";
    try {
      const looked = mime.lookup(hint);
      return typeof looked === "string" ? looked : "";
    } catch {
      return "";
    }
  };
  const candidates = [
    preferredMime,
    descriptor.mime,
    lookup(descriptor.filename),
    lookup(descriptor.source),
    lookup(descriptor.ext),
  ];
  for (const cand of candidates) {
    const normalized = coerceAudioMime(cand);
    if (normalized) return normalized;
  }
  return "audio/mpeg";
}

function describeBinaryInput(input, { fallbackName = "file", label } = {}) {
  if (!input || !Buffer.isBuffer(input.buffer)) return null;
  const hint =
    input.filename || input.source || fallbackName || `file-${Date.now()}`;
  const detectedMime =
    normalizeMimeValue(
      detectMimeFrom(hint, input.mime, input.buffer) ||
        input.mime ||
        GENERIC_FILE_MIME
    ) || GENERIC_FILE_MIME;
  const hintExt = extFromName(hint || "");
  const ext = hintExt || resolveMimeExtension(detectedMime) || "bin";
  const allowedMime = coerceMimeToAllowlist(detectedMime);
  const filename = baseNameFromHint(hint || fallbackName, allowedMime, ext);
  return {
    buffer: input.buffer,
    mime: allowedMime,
    filename,
    ext,
    kind: normalizeMediaType(allowedMime || detectedMime, label),
    size: input.buffer.length,
    source: input.source || null,
  };
}

const SUSPICIOUS_MIME_PATTERNS = [
  /^application\/x-msdownload/i,
  /^application\/x-ms-dos-executable/i,
  /^application\/x-msdos-program/i,
  /^application\/x-msi/i,
  /^application\/x-ms-installer/i,
  /^application\/x-executable/i,
  /^application\/x-dosexec/i,
  /^application\/x-shellscript/i,
  /^application\/javascript/i,
  /^text\/javascript/i,
  /^text\/x-script/i,
  /^text\/x-shellscript/i,
  /^text\/x-powershell/i,
  /^text\/x-python/i,
  /^application\/java-archive/i,
];
const SUSPICIOUS_EXTENSION_SET = new Set([
  "exe",
  "msi",
  "scr",
  "bat",
  "cmd",
  "sh",
  "ps1",
  "psm1",
  "psd1",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "com",
  "dll",
  "sys",
  "js",
  "jse",
  "msh",
  "msh1",
  "reg",
  "pif",
  "gadget",
  "jar",
  "apk",
]);
const SUSPICIOUS_NAME_REGEX =
  /\.(?:exe|scr|bat|cmd|sh|ps1|psm1|vbs|vbe|wsf|wsh|com|dll|sys|js|jse|msh|msh1|reg|pif|jar|apk)$/i;

function detectSuspiciousFile(descriptor) {
  if (!descriptor) return null;
  const mimeStr = normalizeMimeValue(descriptor.mime);
  const filename = String(descriptor.filename || "").toLowerCase();
  const ext = String(descriptor.ext || "").toLowerCase();
  if (SUSPICIOUS_EXTENSION_SET.has(ext)) {
    return `Files with .${ext} extensions are not allowed`;
  }
  if (SUSPICIOUS_NAME_REGEX.test(filename)) {
    return "This file appears to be an executable or script and was blocked";
  }
  if (SUSPICIOUS_MIME_PATTERNS.some((pattern) => pattern.test(mimeStr))) {
    return "This file type is blocked for security reasons";
  }
  if (
    descriptor.buffer &&
    Buffer.isBuffer(descriptor.buffer) &&
    descriptor.buffer.length >= 2 &&
    descriptor.buffer[0] === 0x4d &&
    descriptor.buffer[1] === 0x5a
  ) {
    return "Executable binaries are blocked";
  }
  if (!isMimeAllowed(mimeStr)) {
    const label = mimeStr || "unknown";
    return `MIME type "${label}" is not allowed (configure WAREST_MIMETYPE_FILES_ALLOWLIST)`;
  }
  return null;
}

function buildQuotedOpt(sctx, jid, replyMessageId) {
  const id = normalizeReplyIdInput(replyMessageId);
  if (!id) return undefined;
  try {
    const cached = getCachedMessage(sctx?.id, id);
    if (cached && cached.message) {
      return { quoted: cached };
    }
  } catch {}
  return {
    quoted: {
      key: { id, remoteJid: jid, fromMe: false },
      message: { conversation: "" },
    },
  };
}

function buildMediaSendOptions(sctx, jid, replyMessageId, extra = {}) {
  const opts = { ...(buildQuotedOpt(sctx, jid, replyMessageId) || {}) };
  if (typeof sctx?.sock?.waUploadToServer === "function") {
    opts.upload = sctx.sock.waUploadToServer;
  }
  const uploadTimeout = Number(config.uploadLimits?.mediaUploadTimeoutMs || 0);
  if (uploadTimeout > 0) opts.mediaUploadTimeoutMs = uploadTimeout;
  return { ...opts, ...extra };
}

function autoDetectMentions(text) {
  const s = String(text || "");
  const found = [];
  const re = /@(\d{6,20})/g;
  let m;
  while ((m = re.exec(s))) found.push(m[1]);
  return found;
}

const EMOJI_SHORTCODES = new Map(
  Object.entries({
    smile: "??",
    sad: "??",
    heart: "??",
    thumbsup: "??",
    clap: "??",
    fire: "??",
    star: "?",
    laugh: "??",
    wink: "??",
    cry: "??",
    angry: "??",
    party: "??",
    cool: "??",
    kiss: "??",
    thinking: "??",
    pray: "??",
    ok_hand: "??",
    muscle: "??",
    wave: "??",
    poop: "??",
    angry: "??",
    hungry: "??",
    badge: "??",
    badboy: "??",
    bomb: "??",
  })
);
function replaceEmojiShortcodes(text) {
  return String(text || "").replace(/:([a-z0-9_+\-]+):/gi, (m, p1) => {
    const key = String(p1 || "").toLowerCase();
    return EMOJI_SHORTCODES.get(key) || m;
  });
}

function htmlToMarkdown(text) {
  let s = String(text || "");
  s = s.replace(/<br\s*\/?>(\r?\n)?/gi, "\n");
  s = s.replace(/<b>([\s\S]*?)<\/b>/gi, "*$1*");
  s = s.replace(/<strong>([\s\S]*?)<\/strong>/gi, "*$1*");
  s = s.replace(/<i>([\s\S]*?)<\/i>/gi, "_$1_");
  s = s.replace(/<em>([\s\S]*?)<\/em>/gi, "_$1_");
  s = s.replace(/<(s|strike|del)>([\s\S]*?)<\/(s|strike|del)>/gi, "~$2~");
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, "```$1```");
  s = s.replace(/<[^>]+>/g, "");
  return s;
}

function normalizeTextMessage(raw) {
  if (raw == null) return "";
  let s = String(raw);
  s = s.replace(/\[(https?:\/\/[^\]\s]+)\]/gi, "$1");
  s = htmlToMarkdown(s);
  s = replaceEmojiShortcodes(s);
  return s;
}

const PRESENCE_STATE_ALIASES = new Map(
  Object.entries({
    typing: "composing",
    compose: "composing",
    writing: "composing",
    text: "composing",
    composing: "composing",
    recording: "recording",
    rec: "recording",
    audio: "recording",
    voice: "recording",
    mic: "recording",
    microphone: "recording",
    ptt: "recording",
    available: "available",
    online: "available",
    unavailable: "unavailable",
    offline: "unavailable",
    paused: "paused",
  })
);
const GLOBAL_PRESENCE_STATES = new Set(["available", "unavailable"]);
const CHAT_PRESENCE_STATES = new Set(["composing", "recording", "paused"]);
const PRESENCE_DELAY_RANGES = {
  available: [280, 420],
  composing: [1200, 1850],
  recording: [2200, 3600],
  paused: [260, 520],
  unavailable: [220, 360],
  fallback: [900, 1400],
};

function randomInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  if (hi === lo) return Math.max(0, Math.floor(lo));
  return Math.max(0, lo + Math.floor(Math.random() * (hi - lo + 1)));
}

function presenceDelayFor(state) {
  const [min, max] =
    PRESENCE_DELAY_RANGES[state] || PRESENCE_DELAY_RANGES.fallback;
  return randomInt(min, max);
}

function normalizePresenceState(state, fallback = "composing") {
  if (!state && fallback) return fallback;
  const key = String(state || "")
    .trim()
    .toLowerCase();
  if (!key) return fallback;
  if (PRESENCE_STATE_ALIASES.has(key)) return PRESENCE_STATE_ALIASES.get(key);
  if (GLOBAL_PRESENCE_STATES.has(key) || CHAT_PRESENCE_STATES.has(key)) {
    return key;
  }
  return fallback;
}

function resolvePresencePreference(value, fallbackState) {
  const normalizedFallback = normalizePresenceState(
    fallbackState || "composing"
  );
  if (typeof value === "boolean") {
    return { enabled: value, state: normalizedFallback };
  }
  if (typeof value === "number") {
    return {
      enabled: Number.isFinite(value) ? value > 0 : false,
      state: normalizedFallback,
    };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { enabled: false, state: normalizedFallback };
    const lowered = trimmed.toLowerCase();
    if (["0", "false", "no", "n", "off"].includes(lowered)) {
      return { enabled: false, state: normalizedFallback };
    }
    const alias = PRESENCE_STATE_ALIASES.get(lowered);
    if (alias) {
      return { enabled: true, state: alias };
    }
    if (["1", "true", "yes", "y", "on"].includes(lowered)) {
      return { enabled: true, state: normalizedFallback };
    }
    return { enabled: true, state: normalizedFallback };
  }
  if (value == null) {
    return { enabled: false, state: normalizedFallback };
  }
  return { enabled: true, state: normalizedFallback };
}

async function sendPresenceSafe(sock, state, jid) {
  if (!sock?.sendPresenceUpdate) return;
  try {
    if (GLOBAL_PRESENCE_STATES.has(state)) {
      await sock.sendPresenceUpdate(state);
    } else {
      await sock.sendPresenceUpdate(state, jid);
    }
  } catch {}
}

function buildPresenceSequence(targetState) {
  const seq = [{ state: "available", delay: presenceDelayFor("available") }];
  if (targetState === "available") {
    return seq;
  }
  if (GLOBAL_PRESENCE_STATES.has(targetState)) {
    seq.push({ state: targetState, delay: presenceDelayFor(targetState) });
    return seq;
  }
  seq.push({ state: targetState, delay: presenceDelayFor(targetState) });
  seq.push({ state: "paused", delay: presenceDelayFor("paused") });
  return seq;
}

async function applyPresenceAndDelay(s, jid, state, presence) {
  const sock = s?.sock;
  const queue = s?.queue;
  const normalizedJid = sanitizeJid(jid);
  if (!sock || !queue || !normalizedJid) return;
  const fallbackState = normalizePresenceState(state || "composing");
  const pref = resolvePresencePreference(presence, fallbackState);
  if (!pref.enabled) return;
  const targetState = normalizePresenceState(pref.state, fallbackState);
  try {
    await sock.presenceSubscribe?.(normalizedJid);
  } catch {}
  await queue.push(async () => {
    const steps = buildPresenceSequence(targetState);
    for (const step of steps) {
      await sendPresenceSafe(sock, step.state, normalizedJid);
      const wait = Math.max(0, step.delay || 0);
      if (wait) await sleep(wait);
    }
  });
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

function jidToPlain(jid) {
  const sanitized = sanitizeJid(jid);
  if (!sanitized) return null;
  const [num] = sanitized.split("@");
  return num || null;
}

function buildAdvancedInfo(extra = {}) {
  if (!extra || typeof extra !== "object") return null;
  const clean = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue;
    }
    clean[key] = value;
  }
  return Object.keys(clean).length ? clean : null;
}

function resolveSenderIdentity(session, fallbackPhone) {
  const rawJid = String(session?.me?.id || session?.sock?.user?.id || "")
    .trim()
    .toLowerCase();
  const sessionJid = sanitizeJid(rawJid);
  const sessionPhone = sessionJid ? sessionJid.split("@")[0] : null;
  let fallback = null;
  if (!sessionPhone && fallbackPhone) {
    fallback = normalizePhoneDigits(fallbackPhone);
  }
  return {
    phone: sessionPhone || fallback || null,
    jid: sessionJid || (sessionPhone ? `${sessionPhone}@s.whatsapp.net` : null),
  };
}

function buildResultEntry({
  sender,
  recipientJid,
  messageId,
  status,
  timestamp,
  isForwarded,
  quotedMessageId,
  extraInfo,
}) {
  const cleanJid = sanitizeJid(recipientJid);
  const to = cleanJid ? jidToPlain(cleanJid) : null;
  const sanitizedExtra = buildAdvancedInfo(extraInfo) || {};
  const advancedInfo = {
    isForwarded: Boolean(isForwarded),
    quotedMessageId:
      quotedMessageId == null ? null : String(quotedMessageId).trim() || null,
    ...sanitizedExtra,
  };
  const resolvedStatus =
    typeof status === "string" && status.trim()
      ? status.trim()
      : buildStatusLabel("message");
  return {
    phone: sender?.phone || null,
    to,
    toJid: cleanJid || null,
    messageId: messageId || null,
    status: resolvedStatus,
    timestamp: Number.isFinite(timestamp)
      ? Number(timestamp)
      : Math.floor(Date.now() / 1000),
    advancedInfo,
  };
}

function normalizeStatusFragment(value, fallback) {
  const raw = String(value ?? "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return raw || fallback;
}

function buildStatusLabel(messageType, outcome = true) {
  const typeLabel = normalizeStatusFragment(messageType, "message");
  const suffix =
    typeof outcome === "boolean"
      ? outcome
        ? "success"
        : "failed"
      : normalizeStatusFragment(outcome, "status");
  return `${typeLabel} ${suffix}`.trim();
}

function buildContextInfo({ isForwarded, mentionsJids }) {
  const ctx = {};
  if (parseBoolean(isForwarded, false)) {
    ctx.forwardingScore = 1;
    ctx.isForwarded = true;
  }
  if (Array.isArray(mentionsJids) && mentionsJids.length) {
    ctx.mentionedJid = mentionsJids;
  }
  return Object.keys(ctx).length ? { contextInfo: ctx } : {};
}

/* ------------------------ routes ------------------------ */

// POST&GET /api/(v1)/messages/send/text
const sendMessageText = async (req, res) => {
  try {
    const sessionId = readAnyStr(req, ["sessionId"]);
    const phone = readAnyStr(req, ["phone"]);
    const toRaw = readAnyStr(req, ["to", "jid", "target", "number"]);
    const messageRaw = readAnyStr(req, ["message", "text"]);
    const presence = readPresenceInput(req);
    const replyMessageId = readAnyStr(req, [
      "replyMessageId",
      "quotedMessageId",
      "replyId",
    ]);
    const isForwardedStr = readAnyStr(req, ["isForwarded", "forwarded"]);
    const s = await resolveSession({ sessionId, phone });
    if (!s) {
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    }

    if (!messageRaw) {
      return res.status(400).json({
        status: false,
        code: 1100,
        message: "Parameter 'message' is required",
        results: null,
      });
    }
    if (!toRaw) {
      return res.status(400).json({
        status: false,
        code: 1100,
        message: "Parameter 'to' is required",
        results: null,
      });
    }
    const recipients = parseDestinationJids(toRaw);
    if (!recipients.length) {
      return res.status(400).json({
        status: false,
        code: 1100,
        message: "Invalid 'to' value",
        results: null,
      });
    }

    const text = normalizeTextMessage(messageRaw);

    const autoMentions = autoDetectMentions(text);
    const mentionPhones = Array.from(
      new Set(autoMentions.map(digitsOnly))
    ).filter(Boolean);
    const mentionsJids = mentionPhones.map((p) => `${p}@s.whatsapp.net`);

    const isForwarded = (() => {
      const s = String(isForwardedStr || "")
        .trim()
        .toLowerCase();
      if (!s) return undefined;
      return ["1", "true", "yes", "y", "on"].includes(s);
    })();

    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);

    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const rawJid of recipients) {
      const jid = String(rawJid || "")
        .replace(/@c\.us$/i, "@s.whatsapp.net")
        .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");

      await applyPresenceAndDelay(s, jid, "composing", presence);

      const sendFn = async () => {
        const content = { text, mentions: mentionsJids };
        const extra = buildContextInfo({ isForwarded, mentionsJids });
        return s.sock.sendMessage(
          jid,
          { ...content, ...extra },
          buildQuotedOpt(s, jid, normalizedReplyId)
        );
      };

      const resp = s?.queue?.push ? await s.queue.push(sendFn) : await sendFn();

      cacheSentMessage(s, resp);

      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel("text", true),
          timestamp: extractTimestampSeconds(resp),
          quotedMessageId: normalizedReplyId ?? null,
          isForwarded,
          extraInfo: {
            mentions: mentionsJids.length ? mentionsJids : undefined,
          },
        })
      );
    }

    const payload = formatSendResponse("Text message", outputs);
    return res.status(200).json({
      status: true,
      code: 1000,
      ...payload,
    });
  } catch (e) {
    logger?.warn?.({ err: e?.message }, "send/text error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
};
router.post(["/send/text"], sendMessageText);
router.get(["/send/text"], sendMessageText);

// POST /api/(v1)/messages/send/files
router.post(["/send/files"], rawAny, async (req, res) => {
  try {
    const parsedBody = parseHybridBody(req);
    const fields = mergeFieldsWithQuery(parsedBody.fields || {}, req.query);
    const uploads = parsedBody.files || [];
    const inputs = [];

    const pushBufferInput = (buffer, meta = {}) => {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;
    inputs.push({
      data: buffer,
      filename: meta.filename || null,
      partMime: meta.partMime || null,
      source: meta.source || null,
      replyMessageId:
        normalizeReplyIdInput(
          meta.replyMessageId ?? meta.quotedMessageId ?? null
        ) || null,
    });
  };
  const pushUrlInput = (value, meta = {}) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    inputs.push({
      url: trimmed,
      filename: meta.filename || null,
      partMime: meta.partMime || null,
      source: meta.source || trimmed,
      replyMessageId:
        normalizeReplyIdInput(
          meta.replyMessageId ?? meta.quotedMessageId ?? null
        ) || null,
    });
  };
    const tryInlineString = (value, meta = {}) => {
      if (typeof value !== "string") return false;
      const trimmed = value.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("data:")) {
        const parsed = parseDataUriString(trimmed);
        if (parsed?.buffer) {
          pushBufferInput(parsed.buffer, {
            ...meta,
            partMime: meta.partMime || parsed.mime,
          });
          return true;
        }
      }
      const decoded = tryDecodeBase64Payload(trimmed);
      if (decoded) {
        pushBufferInput(decoded, meta);
        return true;
      }
      pushUrlInput(trimmed, meta);
      return true;
    };
    const coerceToBuffer = (value) => {
      if (!value) return null;
      if (Buffer.isBuffer(value)) return value;
      if (Array.isArray(value)) {
        const numeric = value.every(
          (num) =>
            typeof num === "number" &&
            Number.isFinite(num) &&
            num >= 0 &&
            num <= 255
        );
        if (numeric) {
          try {
            return Buffer.from(Uint8Array.from(value));
          } catch {
            return Buffer.from(value);
          }
        }
      }
      if (
        value &&
        typeof value === "object" &&
        value.type === "Buffer" &&
        Array.isArray(value.data)
      ) {
        try {
          return Buffer.from(value.data);
        } catch {}
      }
      if (typeof ArrayBuffer !== "undefined") {
        if (value instanceof ArrayBuffer) return Buffer.from(value);
        if (
          typeof ArrayBuffer.isView === "function" &&
          ArrayBuffer.isView(value)
        ) {
          return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        }
      }
      return null;
    };

    const inlineEntries = [...normalizeFilesInput(fields.files)];
    const fallbackKeys = ["file", "media", "document", "upload", "source"];
    for (const key of fallbackKeys) {
      if (fields[key] != null) inlineEntries.push(fields[key]);
    }

    for (const entry of inlineEntries) {
      if (entry == null) continue;
      const type = typeof entry;
      if (type === "string" || type === "number" || type === "boolean") {
        const strVal = String(entry);
        tryInlineString(strVal, { source: strVal });
        continue;
      }
      const directBuffer = coerceToBuffer(entry);
      if (directBuffer) {
        pushBufferInput(directBuffer, {});
        continue;
      }
      if (entry && typeof entry === "object") {
        const meta = {
          filename:
            firstStringValue(
              entry.filename ?? entry.name ?? entry.fileName ?? entry.label
            ) || null,
          partMime:
            firstStringValue(
              entry.mimetype ??
                entry.mimeType ??
                entry.contentType ??
                entry.partMime ??
                entry.type
            ) || null,
          source:
            firstStringValue(
              entry.source ?? entry.reference ?? entry.ref ?? entry.origin
            ) || null,
        };
        const entryReply =
          firstStringValue(entry.replyMessageId) ??
          firstStringValue(entry.quotedMessageId) ??
          firstStringValue(entry.quoteMessageId) ??
          firstStringValue(entry.replyId) ??
          firstStringValue(entry.quoteId);
        const normalizedEntryReply = normalizeReplyIdInput(entryReply);
        if (normalizedEntryReply) {
          meta.replyMessageId = normalizedEntryReply;
        }

        const objectBuffer =
          coerceToBuffer(entry.buffer) ||
          coerceToBuffer(entry.data) ||
          coerceToBuffer(entry.file) ||
          coerceToBuffer(entry.binary) ||
          coerceToBuffer(entry.blob);
        if (objectBuffer) {
          pushBufferInput(objectBuffer, meta);
          continue;
        }

        const inlineValue =
          firstStringValue(
            entry.file ??
              entry.base64 ??
              entry.upload ??
              entry.value ??
              entry.contents ??
              entry.body ??
              entry.payload ??
              entry.dataUri ??
              entry.dataURI ??
              entry.uri
          ) || null;
        if (inlineValue) {
          const src = meta.source || inlineValue;
          if (tryInlineString(inlineValue, { ...meta, source: src })) {
            continue;
          }
        }

        const urlValue =
          firstStringValue(entry.url) ||
          firstStringValue(entry.href) ||
          firstStringValue(entry.link);
        if (urlValue) {
          pushUrlInput(urlValue, { ...meta, source: urlValue });
          continue;
        }
      }
    }

    const urlList = toArrayMaybe(fields.urls || fields.url);
    for (const u of urlList) {
      tryInlineString(u, { source: u });
    }

    for (const f of uploads) {
      const buf = coerceToBuffer(f.data) || Buffer.from(f.data || []);
      pushBufferInput(buf, {
        filename: f.filename || f.name || null,
        partMime: f.partMime,
        source: f.filename || f.name || null,
        replyMessageId:
          normalizeReplyIdInput(
            f.replyMessageId ??
              f.quotedMessageId ??
              f.quoteMessageId ??
              f.replyId ??
              f.quoteId
          ) || null,
      });
    }

    if (!inputs.length) {
      const raw = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : req.body;
      if (typeof raw === "string" && raw.trim()) {
        raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((entry) => {
            tryInlineString(entry, { source: entry });
          });
      }
    }

    const {
      sessionId,
      phone,
      to,
      quotedMessageId,
      replyMessageId: replyMessageIdField,
      presence: bodyPresence,
      isForwarded,
    } = fields;
    const presence = readPresenceInput(req, bodyPresence);

    if (!inputs.length)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "No files or URLs provided",
        results: null,
      });

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });

    const normalizedReplyId = normalizeReplyIdInput(
      quotedMessageId ?? replyMessageIdField
    );
    const forwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);

    const arrayLimit = Math.max(1, Math.min(inputs.length, 20));
    const successEntries = [];
    const failedEntries = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "composing", presence);

      const results = [];
      const filesOut = [];
      const blockedFiles = [];
      let index = 0;
      for (const item of inputs) {
        if (index >= arrayLimit) break;
        const itemReplyId = normalizeReplyIdInput(item.replyMessageId);
        const effectiveReplyId = itemReplyId || normalizedReplyId;
        let usedBuffer = null;
        let usedMime = null;
        let usedName = null;
        if (item.url) {
          try {
            const fetched = await fetchBuffer(item.url);
            usedBuffer = fetched.buffer;
            usedMime = fetched.mime;
            usedName = baseNameFromHint(
              item.url,
              usedMime,
              resolveMimeExtension(usedMime) || "bin"
            );
          } catch (err) {
            logger.warn({ err: err?.message }, "send/files: fetch failed");
            index++;
            continue;
          }
        } else if (item.data) {
          usedBuffer = Buffer.isBuffer(item.data)
            ? item.data
            : Buffer.from(item.data);
          usedMime =
            item.partMime ||
            mime.lookup(item.filename || "") ||
            "application/octet-stream";
          usedName =
            item.filename ||
            baseNameFromHint(
              "upload",
              usedMime,
              resolveMimeExtension(usedMime) || "bin"
            );
        }
        if (!usedBuffer) {
          index++;
          continue;
        }
        const descriptor = describeBinaryInput(
          {
            buffer: usedBuffer,
            mime: usedMime,
            filename: usedName,
            source: item.url || item.source || usedName,
          },
          {
            fallbackName:
              usedName || item.source || `file-${filesOut.length + 1}`,
            label: "document",
          }
        );
        if (!descriptor) {
          index++;
          continue;
        }
        const blockedReason = detectSuspiciousFile(descriptor);
        if (blockedReason) {
          blockedFiles.push({
            name: descriptor.filename,
            mimetype: descriptor.mime,
            size: descriptor.size,
            reason: blockedReason,
          });
          index++;
          continue;
        }
        if (descriptor.size > PER_FILE_BYTES)
          return res.status(413).json({
            status: false,
            code: 2009,
            message: `File too large (limit ${PER_FILE_MB}MB)`,
            results: null,
          });
        try {
          const resp = await s.queue.push(async () => {
            const extra = buildContextInfo({ isForwarded: forwardedFlag });
            return await s.sock.sendMessage(
              jid,
              {
                document: descriptor.buffer,
                mimetype: descriptor.mime,
                fileName: descriptor.filename,
                ...extra,
              },
              buildMediaSendOptions(s, jid, effectiveReplyId)
            );
          });
          cacheSentMessage(s, resp);
          results.push(resp);
          const key = resp?.key || resp?.message?.key || {};
          const fileEntry = {
            name: descriptor.filename,
            mimetype: descriptor.mime,
            size: descriptor.size,
            messageId: key.id || null,
          };
          if (itemReplyId) {
            fileEntry.quotedMessageId = itemReplyId;
          }
          fileEntry.timestamp = extractTimestampSeconds(resp);
          filesOut.push(fileEntry);
        } catch (err) {
          logger.debug?.(
            { err: err?.message, idx: index, jid },
            "send/file: per-file send failed"
          );
        }
        index++;
      }
      if (!filesOut.length) {
        failedEntries.push(
          buildResultEntry({
            sender: senderIdentity,
            recipientJid: jid,
            messageId: null,
            status: buildStatusLabel("file", false),
            timestamp: Math.floor(Date.now() / 1000),

            isForwarded: forwardedFlag,

            quotedMessageId: normalizedReplyId ?? null,
            extraInfo: {
              error:
                blockedFiles.length > 0
                  ? "All files were blocked by security policy"
                  : "No files were sent to this recipient",
              blockedFiles: blockedFiles.length ? blockedFiles : undefined,
            },
          })
        );
        continue;
      }
      const last = results[results.length - 1];
      const key = last?.key || last?.message?.key || {};
      const actualJid = sanitizeJid(key?.remoteJid || jid);
      successEntries.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: null,
          status: buildStatusLabel(
            filesOut.length > 1 ? "files" : "file",
            true
          ),
          timestamp: extractTimestampSeconds(last),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            files: filesOut,
            blockedFiles: blockedFiles.length ? blockedFiles : undefined,
          },
        })
      );
    }
    if (!successEntries.length) {
      return res.status(502).json({
        status: false,
        code: 3002,
        message: "Failed to send files to all recipients",
        results: failedEntries,
      });
    }
    const payload = formatSendResponse("File message", successEntries);
    if (failedEntries.length > 0) {
      return res.status(207).json({
        status: true,
        code: 1004,
        ...payload,
        failed: failedEntries,
      });
    }
    return res.status(200).json({ status: true, code: 1000, ...payload });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/file error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/media
router.post(["/send/media"], rawAny, async (req, res) => {
  try {
    const parsedBody = parseHybridBody(req);
    const body = mergeFieldsWithQuery(parsedBody.fields || {}, req.query);
    const uploads = parsedBody.files || [];
    const {
      sessionId,
      phone,
      to,
      caption,
      compress = true,
      viewOnce = false,

      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = body;
    const presence = readPresenceInput(req, bodyPresence);

    const compressionOptions = buildCompressionOptions(
      parseBoolean(compress, true),
      body.compression,
      body.compressOptions,
      req.query?.compression,
      req.query?.compressOptions
    );

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });

    let resolvedInput;
    try {
      resolvedInput = await resolveBufferedInput({
        body,
        uploads,
        fieldKeys: ["media", "url", "mediaUrl", "file", "source"],
      });
    } catch {
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid media input",
        results: null,
      });
    }

    if (!resolvedInput)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid media input",
        results: null,
      });

    const mediaDescriptor = describeBinaryInput(resolvedInput, {
      fallbackName:
        resolvedInput?.filename ||
        pickFirstString(body, ["media", "url", "mediaUrl", "file", "source"]) ||
        "media",
      label: "media",
    });
    if (!mediaDescriptor)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid media input",
        results: null,
      });

    if (mediaDescriptor.size > PER_MEDIA_BYTES)
      return res
        .status(413)
        .json(buildLimitError(PER_MEDIA_MB, 2009, "Media too large"));

    if (!["image", "video"].includes(mediaDescriptor.kind)) {
      return res.status(415).json({
        status: false,
        code: 2007,
        message: "Unsupported media type for this route",
        results: null,
      });
    }

    let sendBuf = mediaDescriptor.buffer;
    let sendMime = mediaDescriptor.mime;
    let mediaKind = mediaDescriptor.kind;
    if (compressionOptions.enable) {
      try {
        const out = await compressByKind(
          sendBuf,
          sendMime,
          mediaKind,
          compressionOptions
        );
        sendBuf = out.buffer || sendBuf;
        sendMime = out.mime || sendMime;
        mediaKind = normalizeMediaType(sendMime, mediaKind);
      } catch {}
    }

    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const forwardedFlag = parseBoolean(isForwarded, false);
    const captionText = caption ? normalizeTextMessage(caption) : undefined;
    const viewOnceFlag = parseBoolean(viewOnce, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(
        s,
        jid,
        mediaKind === "video" ? "recording" : "composing",
        presence
      );

      const sendAttempt = async () => {
        const extra = buildContextInfo({
          isForwarded: forwardedFlag,
        });
        const base = {
          caption: captionText,
          viewOnce: viewOnceFlag,
        };
        const payload =
          mediaKind === "image"
            ? { image: sendBuf, mimetype: sendMime }
            : { video: sendBuf, mimetype: sendMime };
        return await s.sock.sendMessage(
          jid,
          { ...payload, ...base, ...extra },
          buildMediaSendOptions(s, jid, normalizedReplyId)
        );
      };

      const resp = await sendWithRetry(() => s.queue.push(sendAttempt), 2, 800);
      cacheSentMessage(s, resp);
      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel(mediaKind, true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            viewOnce: viewOnceFlag || undefined,
            caption: captionText,
            compression: compressionOptions.enable
              ? compressionOptions
              : undefined,
            mediaKind,
          },
        })
      );
    }
    const payload = formatSendResponse("Media message", outputs);
    return res.status(200).json({ status: true, code: 1000, ...payload });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/media error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/audio
router.post(["/send/audio"], rawAny, async (req, res) => {
  try {
    const parsedBody = parseHybridBody(req);
    const body = mergeFieldsWithQuery(parsedBody.fields || {}, req.query);
    const uploads = parsedBody.files || [];
    const {
      sessionId,
      phone,
      to,
      isVN,
      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = body;
    const presence = readPresenceInput(req, bodyPresence);

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });

    let resolvedAudio;
    try {
      resolvedAudio = await resolveBufferedInput({
        body,
        uploads,
        fieldKeys: ["audio", "url", "media", "file", "source"],
      });
    } catch {
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid audio input",
        results: null,
      });
    }

    if (!resolvedAudio)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid audio input",
        results: null,
      });

    const audioDescriptor = describeBinaryInput(resolvedAudio, {
      fallbackName:
        resolvedAudio?.filename ||
        pickFirstString(body, ["audio", "url", "media", "file", "source"]) ||
        "audio",
      label: "audio",
    });
    if (!audioDescriptor)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid audio input",
        results: null,
      });

    if (audioDescriptor.size > PER_MEDIA_BYTES)
      return res
        .status(413)
        .json(buildLimitError(PER_MEDIA_MB, 2010, "Audio too large"));

    if (audioDescriptor.kind !== "audio") {
      return res.status(415).json({
        status: false,
        code: 2007,
        message: "Unsupported audio type",
        results: null,
      });
    }

    const userAudioMime = pickFirstString(body, [
      "mime",
      "mimetype",
      "mimeType",
      "contentType",
      "audioMime",
      "audioMimeType",
    ]);
    let sendMime = resolveAudioMimeType(
      userAudioMime || audioDescriptor.mime,
      audioDescriptor
    );

    let sendBuf = audioDescriptor.buffer;
    if (!Buffer.isBuffer(sendBuf)) {
      sendBuf = Buffer.from(sendBuf || []);
    }

    const isVoiceNote = parseBoolean(isVN, false);
    if (isVoiceNote) {
      try {
        const converted = await compressAudioBuffer(sendBuf, sendMime, {
          enable: true,
          preferOpus: true,
          minSavingsRatio: 0,
          minBytes: 0,
          audioBitrateK: config?.compress?.audioBitrateK ?? 96,
          sampleRate: 48000,
          channels: 1,
          opusApplication: "voip",
          force: true,
        });
        const normalizedMime = normalizeMimeValue(
          converted?.mime || sendMime
        );
        if (!converted?.buffer || !Buffer.isBuffer(converted.buffer)) {
          throw new Error("voice note conversion returned empty buffer");
        }
        if (!/ogg/.test(normalizedMime || "")) {
          throw new Error("voice note conversion output is not ogg");
        }
        sendBuf = converted.buffer;
        sendMime = VOICE_NOTE_MIME;
      } catch (err) {
        logger.warn(
          { err: err?.message },
          "send/audio: voice note conversion failed"
        );
        return res.status(422).json({
          status: false,
          code: 2014,
          message: "Failed to convert audio to WhatsApp voice note format",
          results: null,
        });
      }
    }

    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const forwardedFlag = parseBoolean(isForwarded, false);
    const outputs = [];
    const senderIdentity = resolveSenderIdentity(s, phone);
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "recording", presence);

      const resp = await s.queue.push(async () => {
        const extra = buildContextInfo({
          isForwarded: forwardedFlag,
        });
        return await s.sock.sendMessage(
          jid,
          {
            audio: sendBuf,
            mimetype: sendMime,
            ptt: isVoiceNote,
            ...extra,
          },
          buildMediaSendOptions(s, jid, normalizedReplyId)
        );
      });
      cacheSentMessage(s, resp);
      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel(isVoiceNote ? "ptt" : "audio", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            isVoiceNote: isVoiceNote || undefined,
            mimeType: sendMime || undefined,
          },
        })
      );
    }
    const payload = formatSendResponse("Audio message", outputs);
    return res.status(200).json({ status: true, code: 1000, ...payload });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/audio error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/document
router.post(["/send/document"], rawAny, async (req, res) => {
  try {
    const parsedBody = parseHybridBody(req);
    const body = mergeFieldsWithQuery(parsedBody.fields || {}, req.query);
    const uploads = parsedBody.files || [];
    const fileUpload = resolveUploadedFile(
      selectFileEntry(uploads, ["document", "file", "upload", "media"])
    );
    const {
      sessionId,
      phone,
      to,
      filename,
      caption,

      presence: bodyPresence,
      replyMessageId,
      quotedMessageId,
      isForwarded,
    } = body;
    const presence = readPresenceInput(req, bodyPresence);

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });

    let resolvedDoc;
    try {
      resolvedDoc = await resolveBufferedInput({
        body,
        uploads,
        fieldKeys: ["document", "url", "media", "file", "source", "upload"],
      });
    } catch {
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid document input",
        results: null,
      });
    }

    if (!resolvedDoc)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid document input",
        results: null,
      });

    const documentDescriptor = describeBinaryInput(resolvedDoc, {
      fallbackName:
        filename ||
        resolvedDoc?.filename ||
        pickFirstString(body, ["document", "url", "media", "file", "source"]) ||
        "document",
      label: "document",
    });
    if (!documentDescriptor)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid document input",
        results: null,
      });
    const blockedReason = detectSuspiciousFile(documentDescriptor);
    if (blockedReason)
      return res.status(415).json({
        status: false,
        code: 2007,
        message: blockedReason,
        results: null,
      });

    if (documentDescriptor.size > PER_MEDIA_BYTES)
      return res
        .status(413)
        .json(buildLimitError(PER_MEDIA_MB, 2011, "Document too large"));

    let sendBuf = documentDescriptor.buffer;
    let sendMime = documentDescriptor.mime;
    let sendName = documentDescriptor.filename;
    let sendExt = documentDescriptor.ext;

    const ext = sendExt || resolveMimeExtension(sendMime) || "bin";
    const fileName = filename
      ? baseNameFromHint(String(filename), sendMime, ext)
      : sendName || `file.${ext}`;

    const captionText = caption ? normalizeTextMessage(caption) : undefined;
    const normalizedReplyId = normalizeReplyIdInput(
      replyMessageId ?? quotedMessageId
    );
    const forwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "composing", presence);

      const resp = await s.queue.push(async () => {
        const extra = buildContextInfo({
          isForwarded: forwardedFlag,
        });
        return await s.sock.sendMessage(
          jid,
          {
            document: sendBuf,
            mimetype: sendMime,
            fileName,
            caption: captionText,
            ...extra,
          },
          buildMediaSendOptions(s, jid, normalizedReplyId)
        );
      });
      cacheSentMessage(s, resp);
      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel(ext ? `document ${ext}` : "document", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            caption: captionText,
            filename: fileName,
            mimetype: sendMime,
          },
        })
      );
    }
    const payload = formatSendResponse("Document message", outputs);
    return res.status(200).json({
      status: true,
      code: 1000,
      ...payload,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/document error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/sticker
router.post(["/send/sticker"], rawAny, async (req, res) => {
  try {
    const parsedBody = parseHybridBody(req);
    const body = mergeFieldsWithQuery(parsedBody.fields || {}, req.query);
    const uploads = parsedBody.files || [];
    const {
      sessionId,
      phone,
      to,
      compress = true,

      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = body;
    const presence = readPresenceInput(req, bodyPresence);

    const compressionOptions = buildCompressionOptions(
      parseBoolean(compress, true),
      body.compression,
      body.compressOptions,
      req.query?.compression,
      req.query?.compressOptions
    );

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });

    let resolvedSticker;
    try {
      resolvedSticker = await resolveBufferedInput({
        body,
        uploads,
        fieldKeys: ["sticker", "url", "media", "file", "source", "upload"],
      });
    } catch {
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid sticker input",
        results: null,
      });
    }

    if (!resolvedSticker)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid sticker input",
        results: null,
      });

    const stickerDescriptor = describeBinaryInput(resolvedSticker, {
      fallbackName:
        resolvedSticker?.filename ||
        pickFirstString(body, ["sticker", "url", "media", "file", "source"]) ||
        "sticker",
      label: "image",
    });
    if (!stickerDescriptor)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid sticker input",
        results: null,
      });

    if (stickerDescriptor.size > PER_MEDIA_BYTES)
      return res
        .status(413)
        .json(buildLimitError(PER_MEDIA_MB, 2012, "Sticker too large"));

    let webpBuf = stickerDescriptor.buffer;
    if (!/image\/webp/i.test(String(stickerDescriptor.mime || ""))) {
      try {
        const { default: sharp } = await import("sharp");
        const quality = clampNumber(
          compressionOptions.quality,
          1,
          100,
          compressionOptions.enable ? 80 : 95
        );
        const size = clampNumber(
          compressionOptions.maxDimension ?? compressionOptions.size,
          96,
          1024,
          512
        );
        const effort = clampNumber(
          compressionOptions.webpEffort,
          0,
          6,
          compressionOptions.enable ? 4 : 3
        );
        webpBuf = await sharp(stickerDescriptor.buffer)
          .resize(size, size, { fit: "inside", withoutEnlargement: true })
          .webp({
            quality,
            effort,
          })
          .toBuffer();
      } catch (e) {
        logger.warn({ err: e?.message }, "sticker convert failed");
        return res.status(502).json({
          status: false,
          code: 3013,
          message: "Sticker conversion failed",
          results: null,
        });
      }
    }

    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const forwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "composing", presence);

      const resp = await s.queue.push(async () => {
        const extra = buildContextInfo({
          isForwarded: forwardedFlag,
        });
        return await s.sock.sendMessage(
          jid,
          { sticker: webpBuf, ...extra },
          buildMediaSendOptions(s, jid, normalizedReplyId)
        );
      });
      cacheSentMessage(s, resp);
      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel("sticker", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            compression: compressionOptions.enable
              ? compressionOptions
              : undefined,
          },
        })
      );
    }
    const payload = formatSendResponse("Sticker message", outputs);
    return res.status(200).json({
      status: true,
      code: 1000,
      ...payload,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/sticker error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

function buildVCard({ name, fullName, phone, organization, org, email }) {
  const num = digitsOnly(phone);
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${fullName || name || ""}`,
    organization || org ? `ORG:${organization || org}` : "",
    num ? `TEL;type=CELL;type=VOICE;waid=${num}:${num}` : "",
    email ? `EMAIL:${email}` : "",
    "END:VCARD",
  ]
    .filter(Boolean)
    .join("\n");
}

// POST /api/(v1)/messages/send/contact
router.post(["/send/contact"], async (req, res) => {
  try {
    const body = normalizeBody(req.body);
    const {
      sessionId,
      phone,
      to,
      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = body || {};
    const presence = readPresenceInput(req, bodyPresence);

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });
    const contactRaw = parseMaybeJSON(body.contact) || {
      name: body.name || body.fullName || body.contactName,
      fullName: body.fullName || body.name || body.contactName,
      phone: body.phone || body.contactPhone,
      organization: body.organization || body.org,
      email: body.email || body.contactEmail,
    };
    const vc = buildVCard(contactRaw || {});

    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const displayName = contactRaw?.name || contactRaw?.fullName || "Contact";
    const forwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "composing", presence);

      const resp = await s.queue.push(async () => {
        const extra = buildContextInfo({ isForwarded: forwardedFlag });
        return await s.sock.sendMessage(
          jid,
          { contacts: { displayName, contacts: [{ vcard: vc }] }, ...extra },
          buildQuotedOpt(s, jid, normalizedReplyId)
        );
      });

      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel("contact", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            displayName,
          },
        })
      );
    }
    const payload = formatSendResponse("Contact message", outputs);
    return res.status(200).json({ status: true, code: 1000, ...payload });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/contact error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/location
router.post(["/send/location"], async (req, res) => {
  try {
    const body = normalizeBody(req.body);
    const {
      sessionId,
      phone,
      to,
      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = body || {};
    const presence = readPresenceInput(req, bodyPresence);

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });
    const loc = normalizeLocationFromBody(body);
    if (!loc)
      return res.status(400).json({
        status: false,
        code: 3012,
        message: "Invalid location payload",
        results: null,
      });
    const locationPayload = {
      degreesLatitude: Number(loc.latitude),
      degreesLongitude: Number(loc.longitude),
      name: loc.name || undefined,
      address: loc.address || undefined,
    };

    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const forwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "composing", presence);
      const resp = await s.queue.push(async () => {
        const extra = buildContextInfo({ isForwarded: forwardedFlag });
        return await s.sock.sendMessage(
          jid,
          { location: locationPayload, ...extra },
          buildQuotedOpt(s, jid, normalizedReplyId)
        );
      });
      cacheSentMessage(s, resp);
      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel("location", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            location: locationPayload,
          },
        })
      );
    }
    const responsePayload = formatSendResponse("Location message", outputs);
    return res.status(200).json({
      status: true,
      code: 1000,
      ...responsePayload,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/location error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/poll
router.post(["/send/poll"], async (req, res) => {
  try {
    const body = normalizeBody(req.body);
    const {
      sessionId,
      phone,
      to,
      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = body || {};
    const presence = readPresenceInput(req, bodyPresence);

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });
    const { question, options, maxSelection } = normalizePollFromBody(body);
    if (!question || options.length === 0)
      return res.status(400).json({
        status: false,
        code: 3012,
        message: "Poll payload invalid",
        results: null,
      });

    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const forwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "composing", presence);
      const resp = await s.queue.push(async () => {
        const extra = buildContextInfo({ isForwarded: forwardedFlag });
        return await s.sock.sendMessage(
          jid,
          {
            poll: {
              name: question,
              values: options,
              selectableCount: maxSelection ?? 1,
            },
            ...extra,
          },
          buildQuotedOpt(s, jid, normalizedReplyId)
        );
      });
      cacheSentMessage(s, resp);
      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel("poll", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            question,
            options,
            maxSelection,
          },
        })
      );
    }
    const payload = formatSendResponse("Poll message", outputs);
    return res.status(200).json({ status: true, code: 1000, ...payload });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/poll error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/gif
router.post(["/send/gif"], rawAny, async (req, res) => {
  try {
    const parsedBody = parseHybridBody(req);
    const body = mergeFieldsWithQuery(parsedBody.fields || {}, req.query);
    const uploads = parsedBody.files || [];
    const {
      sessionId,
      phone,
      to,
      compress = true,

      presence: bodyPresence,
      replyMessageId,
      isForwarded,
      caption,
    } = body;
    const presence = readPresenceInput(req, bodyPresence);

    const compressionOptions = buildCompressionOptions(
      parseBoolean(compress, true),
      body.compression,
      body.compressOptions,
      req.query?.compression,
      req.query?.compressOptions
    );

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });
    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing or invalid 'to'",
        results: null,
      });

    let resolvedGif;
    try {
      resolvedGif = await resolveBufferedInput({
        body,
        uploads,
        fieldKeys: ["gif", "url", "media", "file", "source", "upload"],
      });
    } catch {
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid gif input",
        results: null,
      });
    }

    if (!resolvedGif)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid gif input",
        results: null,
      });
    const gifDescriptor = describeBinaryInput(resolvedGif, {
      fallbackName:
        resolvedGif?.filename ||
        pickFirstString(body, ["gif", "url", "media", "file", "source"]) ||
        "gif",
      label: "video",
    });
    if (!gifDescriptor)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid gif input",
        results: null,
      });

    if (gifDescriptor.size > PER_MEDIA_BYTES)
      return res
        .status(413)
        .json(buildLimitError(PER_MEDIA_MB, 2013, "GIF too large"));

    if (!["video", "gif"].includes(gifDescriptor.kind)) {
      return res.status(415).json({
        status: false,
        code: 2007,
        message: "Unsupported gif type",
        results: null,
      });
    }

    let buffer = gifDescriptor.buffer;
    let mimeStr = gifDescriptor.mime;
    if (compressionOptions.enable) {
      try {
        const out = await compressByKind(
          buffer,
          mimeStr,
          "video",
          compressionOptions
        );
        buffer = out.buffer || buffer;
        mimeStr = out.mime || mimeStr;
      } catch {}
    }

    const captionText = caption ? normalizeTextMessage(caption) : undefined;
    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const forwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      await applyPresenceAndDelay(s, jid, "composing", presence);
      const resp = await s.queue.push(async () => {
        const extra = buildContextInfo({
          isForwarded: forwardedFlag,
        });
        return await s.sock.sendMessage(
          jid,
          {
            video: buffer,
            mimetype: mimeStr,
            gifPlayback: true,
            caption: captionText,
            ...extra,
          },
          buildMediaSendOptions(s, jid, normalizedReplyId)
        );
      });
      cacheSentMessage(s, resp);
      const key = resp?.key || resp?.message?.key || {};
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || null,
          status: buildStatusLabel("gif", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: forwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            caption: captionText,
            compression: compressionOptions.enable
              ? compressionOptions
              : undefined,
          },
        })
      );
    }
    const payload = formatSendResponse("GIF message", outputs);
    return res.status(200).json({ status: true, code: 1000, ...payload });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/gif error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/button
router.post(["/send/button"], async (req, res) => {
  try {
    const {
      sessionId,
      phone,
      to,
      text,
      message,
      footer,
      buttons,
      image,

      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = req.body || {};
    const presence = readPresenceInput(req, bodyPresence);

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });

    const recipients = parseDestinationJids(to);
    const normalized = (Array.isArray(buttons) ? buttons : [])
      .slice(0, 10)
      .map((b) => {
        if (!b) return null;
        if (b.type) return b;
        const displayText = b.text || b.displayText || String(b);
        if (!displayText) return null;
        return { type: "reply", displayText, id: b.id };
      })
      .filter(Boolean);

    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid destination",
        results: null,
      });
    if (!normalized.length)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "buttons must be a non-empty array",
        results: null,
      });

    let imageInput = image;
    try {
      if (typeof image === "string" && image.startsWith("data:")) {
        const parsed = parseDataUri(image);
        if (parsed && parsed.buffer) imageInput = parsed.buffer;
      }
    } catch {}

    const { ulid } = await import("ulid");
    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const isForwardedFlag = parseBoolean(isForwarded, false);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];
    for (const jid of recipients) {
      const quotedOpt = buildQuotedOpt(s, jid, normalizedReplyId);
      const quoted = quotedOpt?.quoted;

      await applyPresenceAndDelay(s, jid, "composing", presence);

      const payload = await formatButtonsMessage(s.sock, {
        text: text ?? message ?? "",
        footer,
        buttons: normalized,
        image: imageInput,
        quoted,
      });

      if (isForwardedFlag) {
        try {
          const ig = payload?.viewOnceMessage?.message?.interactiveMessage;
          if (ig) {
            ig.contextInfo = {
              ...(ig.contextInfo || {}),
              forwardingScore: 1,
              isForwarded: true,
            };
          }
        } catch {}
      }

      const msgId = ulid();
      const resp = await s.queue.push(async () => {
        try {
          return await s.sock.relayMessage(jid, payload, { messageId: msgId });
        } catch (e) {
          throw e;
        }
      });

      cacheSentMessage(
        s,
        resp || {
          key: { id: msgId, remoteJid: jid },
          messageTimestamp: Math.floor(Date.now() / 1000),
        }
      );
      const key = resp?.key ||
        resp?.message?.key || { id: msgId, remoteJid: jid };
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || msgId,
          status: buildStatusLabel("interactive button", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: isForwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            buttonCount: normalized.length,
          },
        })
      );
    }
    const payloadResponse = formatSendResponse(
      "Interactive button message",
      outputs
    );
    return res.status(200).json({
      status: true,
      code: 1000,
      ...payloadResponse,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/button error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

// POST /api/(v1)/messages/send/list
router.post(["/send/list"], async (req, res) => {
  try {
    const {
      sessionId,
      phone,
      to,
      title,
      text,
      message,
      footer,
      buttonText,
      sections,
      list,
      lists,
      image,

      presence: bodyPresence,
      replyMessageId,
      isForwarded,
    } = req.body || {};
    const presence = readPresenceInput(req, bodyPresence);

    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        results: null,
      });

    const recipients = parseDestinationJids(to);
    if (!recipients.length)
      return res.status(400).json({
        status: false,
        code: 2000,
        message: "Invalid destination",
        results: null,
      });

    let imgInput = image;
    try {
      if (typeof image === "string" && image.startsWith("data:")) {
        const parsed = parseDataUri(image);
        if (parsed && parsed.buffer) imgInput = parsed.buffer;
      }
    } catch {}

    const listSummary = summarizeListStructure({ lists, list, sections });

    const { ulid } = await import("ulid");
    const isForwardedFlag = parseBoolean(isForwarded, false);
    const normalizedReplyId = normalizeReplyIdInput(replyMessageId);
    const senderIdentity = resolveSenderIdentity(s, phone);
    const outputs = [];

    for (const jid of recipients) {
      const quotedOpt = buildQuotedOpt(s, jid, normalizedReplyId);
      const quoted = quotedOpt?.quoted;

      const buildOpts = () => {
        if (Array.isArray(lists)) {
          return {
            text: text ?? title ?? message ?? "",
            footer,
            lists,
            image: imgInput,
            quoted,
          };
        }
        if (list && typeof list === "object") {
          return {
            text: text ?? title ?? message ?? "",
            footer,
            list,
            image: imgInput,
            quoted,
          };
        }
        return {
          text: text ?? title ?? message ?? "",
          footer,
          list: {
            buttonText: buttonText || "Open",
            sections: Array.isArray(sections) ? sections : [],
          },
          image: imgInput,
          quoted,
        };
      };

      await applyPresenceAndDelay(s, jid, "composing", presence);

      let payload;
      try {
        payload = await formatListMessage(s.sock, buildOpts());
      } catch (err) {
        return res.status(400).json({
          status: false,
          code: 2000,
          message: String(err?.message || "Invalid list payload"),
          results: null,
        });
      }

      if (isForwardedFlag) {
        try {
          const ig = payload?.viewOnceMessage?.message?.interactiveMessage;
          if (ig) {
            ig.contextInfo = {
              ...(ig.contextInfo || {}),
              forwardingScore: 1,
              isForwarded: true,
            };
          }
        } catch {}
      }

      const msgId = ulid();
      const resp = await s.queue.push(async () => {
        try {
          return await s.sock.relayMessage(jid, payload, { messageId: msgId });
        } catch (e) {
          throw e;
        }
      });

      cacheSentMessage(
        s,
        resp || {
          key: { id: msgId, remoteJid: jid },
          messageTimestamp: Math.floor(Date.now() / 1000),
        }
      );
      const key = resp?.key ||
        resp?.message?.key || { id: msgId, remoteJid: jid };
      const actualJid = sanitizeJid(key.remoteJid || jid);
      outputs.push(
        buildResultEntry({
          sender: senderIdentity,
          recipientJid: actualJid,
          messageId: key.id || msgId,
          status: buildStatusLabel("interactive list", true),
          timestamp: extractTimestampSeconds(resp),

          isForwarded: isForwardedFlag,

          quotedMessageId: normalizedReplyId ?? null,
          extraInfo: {
            sectionCount: listSummary.sectionCount,
            rowCount: listSummary.rowCount,
          },
        })
      );
    }
    const payloadResponse = formatSendResponse(
      "Interactive list message",
      outputs
    );
    return res.status(200).json({
      status: true,
      code: 1000,
      ...payloadResponse,
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "send/list error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      results: null,
    });
  }
});

export default router;

