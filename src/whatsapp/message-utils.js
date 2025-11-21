import { getContentType } from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";

export function unwrapMessage(original) {
  let m = original?.message;
  if (!m) return undefined;

  const wrappers = [
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "ephemeralMessage",
    "deviceSentMessage",
  ];

  let changed = true;
  while (changed && m) {
    changed = false;
    for (const k of wrappers) {
      const inner = m?.[k]?.message;
      if (inner) {
        m = inner;
        changed = true;
      }
    }
  }
  return m;
}

function getCaption(m) {
  return (
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    ""
  );
}

export function getContextInfo(original) {
  const m = unwrapMessage(original) || {};
  return (
    m?.extendedTextMessage?.contextInfo ||
    m?.imageMessage?.contextInfo ||
    m?.videoMessage?.contextInfo ||
    m?.documentMessage?.contextInfo ||
    {}
  );
}

export function extractTextObject(original) {
  const m = unwrapMessage(original);
  if (!m) {
    return {
      text: "",
      type: undefined,
      contentType: undefined,
      raw: original?.message,
    };
  }

  const ctype = getContentType(m);

  if (ctype === "conversation") {
    return {
      text: m.conversation || "",
      type: "text",
      contentType: ctype,
      raw: m,
    };
  }
  if (ctype === "extendedTextMessage") {
    return {
      text: m.extendedTextMessage?.text || "",
      type: "text",
      contentType: ctype,
      raw: m,
    };
  }

  if (
    ctype === "imageMessage" ||
    ctype === "videoMessage" ||
    ctype === "documentMessage"
  ) {
    return { text: getCaption(m), type: "caption", contentType: ctype, raw: m };
  }

  if (ctype === "contactMessage") {
    const v = m.contactMessage || {};
    const display =
      v.displayName || v.vcard?.match(/FN:(.*)/)?.[1]?.trim() || v.vcard || "";
    return { text: display, type: "contact", contentType: ctype, raw: m };
  }

  if (ctype === "contactsArrayMessage") {
    const arr = m.contactsArrayMessage?.contacts || [];
    return {
      text: `Contacts: ${arr.length}`,
      type: "contacts",
      contentType: ctype,
      raw: m,
    };
  }

  if (ctype === "protocolMessage") {
    return { text: "", type: "protocol", contentType: ctype, raw: m };
  }

  const fallback =
    m.conversation || m.extendedTextMessage?.text || getCaption(m) || "";
  return { text: fallback, type: "unknown", contentType: ctype, raw: m };
}

export function extractText(msg) {
  return extractTextObject(msg).text || "";
}

export function extractQuotedTextObject(original) {
  const quoted = getContextInfo(original)?.quotedMessage;
  if (!quoted) {
    return {
      text: "",
      type: undefined,
      contentType: undefined,
      raw: undefined,
    };
  }
  return extractTextObject({ message: quoted });
}

export function getChatId(msg) {
  return msg?.key?.remoteJid || "";
}
export function isGroupJid(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}
export function getSenderJid(msg) {
  return msg?.key?.participant || msg?.key?.remoteJid || "";
}
export function getFromMe(msg) {
  return !!msg?.key?.fromMe;
}
export function getSenderInfo(msg) {
  const chatId = getChatId(msg);
  const fromMe = getFromMe(msg);
  const participant = msg?.key?.participant || undefined;
  return {
    chatId,
    fromMe,
    isGroup: isGroupJid(chatId),
    authorJid: participant || chatId,
  };
}

export function getMentions(msg) {
  const arr = getContextInfo(msg)?.mentionedJid || [];
  return Array.isArray(arr) ? arr : [];
}
export function getQuotedMessage(msg) {
  const quoted = getContextInfo(msg)?.quotedMessage;
  return quoted ? { message: quoted } : undefined;
}

const MEDIA_EXTENSION_BY_MIME = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/3gp": "3gp",
  "audio/ogg; codecs=opus": "ogg",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
};

const MEDIA_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "liveLocationMessage",
  "contactMessage",
  "contactsArrayMessage",
]);

const MEDIA_TYPE_FALLBACK_EXTENSION = {
  imageMessage: "jpeg",
  videoMessage: "mp4",
  audioMessage: "ogg",
  stickerMessage: "webp",
};

const WHATSAPP_MEDIA_HOST = "https://mmg.whatsapp.net";

function buildWhatsappMediaUrl(node = {}) {
  if (node?.url) return node.url;
  const direct = String(node?.directPath || "").trim();
  if (!direct) return "";
  if (/^https?:\/\//i.test(direct)) return direct;
  if (direct.startsWith("/")) return `${WHATSAPP_MEDIA_HOST}${direct}`;
  return `${WHATSAPP_MEDIA_HOST}/${direct}`;
}

function inferMediaExtension(node = {}, ctype) {
  const mime = String(node?.mimetype || node?.mimeType || "").toLowerCase();
  if (mime && MEDIA_EXTENSION_BY_MIME[mime])
    return MEDIA_EXTENSION_BY_MIME[mime];
  const name = String(node?.fileName || "").trim();
  if (name.includes(".")) {
    const ext = name.split(".").pop();
    if (ext) return ext.toLowerCase();
  }
  if (ctype && MEDIA_TYPE_FALLBACK_EXTENSION[ctype]) {
    return MEDIA_TYPE_FALLBACK_EXTENSION[ctype];
  }
  return null;
}

function sanitizeWhatsappMediaUrl(node, ctype) {
  const rawUrl = buildWhatsappMediaUrl(node);
  if (!rawUrl) return { url: "", rawUrl: "" };
  const extension = inferMediaExtension(node, ctype);
  if (!extension) return { url: rawUrl, rawUrl };
  try {
    const parsed = new URL(rawUrl);
    if (/\.enc$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\.enc$/i, `.${extension}`);
    } else if (!/\.[^./]+$/.test(parsed.pathname)) {
      parsed.pathname = `${parsed.pathname}.${extension}`;
    }
    return { url: parsed.toString(), rawUrl };
  } catch {
    return { url: rawUrl, rawUrl };
  }
}

export function extractMediaInfo(msg) {
  const m = unwrapMessage(msg);
  if (!m) return { hasMedia: false };

  const ctype = getContentType(m);
  if (!MEDIA_TYPES.has(ctype)) return { hasMedia: false };
  const node = m[ctype] || {};
  const toB64 = (buf) =>
    buf ? Buffer.from(buf).toString("base64") : undefined;
  const { url: cleanUrl, rawUrl } = sanitizeWhatsappMediaUrl(node, ctype);

  return {
    hasMedia: true,
    type: ctype,
    mimeType: node?.mimetype,
    caption: getCaption(m),
    fileSha256: toB64(node?.fileSha256),
    mediaKey: toB64(node?.mediaKey),
    url: cleanUrl || rawUrl,
    rawUrl: rawUrl || undefined,
    cleanUrl: cleanUrl && cleanUrl !== rawUrl ? cleanUrl : undefined,
    directPath: node?.directPath,
    fileLength: node?.fileLength,
    fileName: node?.fileName,
    seconds: node?.seconds,
    pageCount: node?.pageCount,
    width: node?.width,
    height: node?.height,
    gifPlayback: node?.gifPlayback,
  };
}

export function guessMediaExtension(info = {}) {
  return (
    inferMediaExtension(
      { mimetype: info?.mimeType, fileName: info?.fileName },
      info?.type
    ) || null
  );
}

export function getTimestamp(msg) {
  const ts = msg?.messageTimestamp;
  if (typeof ts === "number") return ts * 1000;
  if (typeof ts === "bigint") return Number(ts) * 1000;
  if (ts && typeof ts === "object") {
    const n =
      typeof ts.toNumber === "function" ? ts.toNumber() : Number(ts.low ?? 0);
    return (Number.isFinite(n) ? n : Date.now() / 1000) * 1000;
  }
  return Date.now();
}

export function normalizeMsisdnToJid(msisdn) {
  const digits = String(msisdn || "").replace(/\D+/g, "");
  let num = digits;
  if (num.startsWith("0")) num = "62" + num.slice(1);
  return `${num}@s.whatsapp.net`;
}

export function parseCommand(text, prefixes = ["/", "!", "."]) {
  const s = String(text || "").trim();
  const prefix = prefixes.find((p) => s.startsWith(p));
  if (!prefix) return null;
  const parts = s.slice(prefix.length).trim().split(/\s+/);
  const cmd = (parts.shift() || "").toLowerCase();
  return { prefix, cmd, args: parts, argsText: parts.join(" ") };
}

export function isIgnorableJid(jid) {
  if (!jid) return true;
  return (
    jid.endsWith("@newsletter") ||
    jid.endsWith("@broadcast") ||
    jid === "status@broadcast"
  );
}
