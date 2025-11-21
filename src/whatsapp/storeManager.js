import { logger as appLogger } from "../logger.js";
import {
  getContentType,
  jidDecode,
  updateMessageWithPollUpdate,
  decryptPollVote,
  isJidNewsletter,
  isJidStatusBroadcast,
} from "@whiskeysockets/baileys";
import { ulid } from "ulid";
import { db as knex } from "../database/models/db.js";
import { getMentions } from "./message-utils.js";

/* ========================================================================== *
 * Time utils
 * ========================================================================== */
const SYS_DELETED_TEXT = "[? This message was deleted]";
const nowSec = () => Math.floor(Date.now() / 1000);
const nowMs = () => Date.now();

function tsMsToSec(ts) {
  try {
    if (typeof ts === "number") return Math.floor(ts > 2e12 ? ts / 1000 : ts);
    if (typeof ts === "bigint")
      return Number(ts > 2_000_000_000_000n ? ts / 1000n : ts);
    if (ts && typeof ts === "object") {
      if (typeof ts.toNumber === "function") {
        const n = ts.toNumber();
        return Math.floor(
          Number.isFinite(n) ? (n > 2e12 ? n / 1000 : n) : nowSec()
        );
      }
      if (Number.isInteger(ts.low) && Number.isInteger(ts.high)) {
        const lo = ts.low >>> 0;
        const hi = ts.high >>> 0;
        const n = hi * 4294967296 + lo;
        return Math.floor(n > 2e12 ? n / 1000 : n);
      }
    }
  } catch {}
  return nowSec();
}

/* ========================================================================== *
 * JID & phone normalization
 * ========================================================================== */
const isGroupJid = (j) => {
  if (!j) return false;
  const clean = stripDeviceSuffix(String(j).trim());
  return clean.endsWith("@g.us");
};
const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");
const stripDeviceSuffix = (s) =>
  String(s || "").includes(":")
    ? String(s).replace(/:.*(?=@)/, "")
    : String(s || "");
const isLikelyMsisdn = (digits) =>
  !!digits && /^\d{10,15}$/.test(digits) && !digits.startsWith("0");

function normalizeMsisdnDigitsLocal(rawDigits) {
  let d = onlyDigits(rawDigits);
  if (!d) return null;
  if (d.startsWith("0")) d = `62${d.slice(1)}`;
  else if (d.startsWith("8")) d = `62${d}`;
  return isLikelyMsisdn(d) ? d : null;
}

function normalizeUserJidStrict(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;

  raw = raw.replace(/:.*(?=@)/, "");

  if (raw.endsWith("@g.us")) return raw;
  if (raw.endsWith("@s.whatsapp.net")) {
    const digits = onlyDigits(raw.split("@")[0]);
    if (isLikelyMsisdn(digits)) return `${digits}@s.whatsapp.net`;
    return null;
  }

  if (raw.endsWith("@lid")) {
    try {
      const dec = jidDecode(raw);
      if (dec?.user) {
        const d1 = onlyDigits(dec.user);
        if (isLikelyMsisdn(d1)) return `${d1}@s.whatsapp.net`;
        const d2 = normalizeMsisdnDigitsLocal(dec.user);
        if (d2) return `${d2}@s.whatsapp.net`;
      }
    } catch {}
    return null;
  }

  const local = raw.includes("@") ? raw.split("@")[0] : raw;
  const dLocal = normalizeMsisdnDigitsLocal(local);
  if (dLocal) return `${dLocal}@s.whatsapp.net`;
  const dAny = onlyDigits(local);
  if (isLikelyMsisdn(dAny)) return `${dAny}@s.whatsapp.net`;
  return null;
}

function normalizeVoterJidBestEffort(jid) {
  const j = stripDeviceSuffix(String(jid || "").trim());
  if (!j) return null;
  if (isGroupJid(j)) return null;
  if (j.endsWith("@s.whatsapp.net")) {
    const digits = onlyDigits(j.split("@")[0]);
    return isLikelyMsisdn(digits) ? `${digits}@s.whatsapp.net` : null;
  }
  const strict = normalizeUserJidStrict(j);
  if (strict) return strict;
  const rawUser = onlyDigits(j.split("@")[0]);
  if (rawUser && isLikelyMsisdn(rawUser)) return `${rawUser}@s.whatsapp.net`;
  return null;
}

function isValidUserJid(jid) {
  const clean = stripDeviceSuffix(String(jid || "").trim());
  if (!clean.endsWith("@s.whatsapp.net")) return false;
  const digits = onlyDigits(clean.split("@")[0]);
  return isLikelyMsisdn(digits);
}

function isValidGroupJid(jid) {
  const clean = stripDeviceSuffix(String(jid || "").trim());
  if (!clean.endsWith("@g.us")) return false;
  const digits = onlyDigits(clean);
  return digits.length >= 10 && digits.length <= 22;
}

function normalizeChatJid(raw) {
  const trimmed = stripDeviceSuffix(String(raw || "").trim());
  if (!trimmed) return null;
  if (
    trimmed === "status@broadcast" ||
    isJidStatusBroadcast?.(trimmed) ||
    trimmed.endsWith("@newsletter") ||
    trimmed.endsWith("@broadcast")
  )
    return null;
  if (trimmed.endsWith("@s.whatsapp.net"))
    return isValidUserJid(trimmed) ? trimmed : null;
  if (isGroupJid(trimmed)) return isValidGroupJid(trimmed) ? trimmed : null;
  return normalizeUserJidStrict(trimmed);
}

const canonicalizeJidLoose = (value) => {
  const norm = normalizeChatJid(value);
  if (norm) return norm;
  const stripped = stripDeviceSuffix(String(value || "").trim());
  return stripped || null;
};
function prettyPhoneLabel(digits) {
  if (!digits) return null;
  if (digits.startsWith("62")) {
    const rest = digits.slice(2);
    return `+62 ${rest.replace(/(\d{4})(\d{4})(\d+)?/, (m, a, b, c) =>
      c ? `${a}-${b}-${c}` : `${a}-${b}`
    )}`;
  }
  return `+${digits}`;
}

function pickAnyDigits(obj) {
  const cands = [
    obj?.id,
    obj?.jid,
    obj?.user,
    obj?.phone,
    obj?.wid,
    obj?.waid,
    obj?.number,
    obj?.participant,
  ]
    .filter(Boolean)
    .map(String);
  for (const c of cands) {
    const d = onlyDigits(c);
    if (d) return d;
  }
  return null;
}

/* ========================================================================== *
 * Message unwrap + text extraction
 * ========================================================================== */
function unwrapMessage(original) {
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

function extractTextLike(msg) {
  try {
    const m = unwrapMessage(msg) || msg?.message;
    if (!m) return "";
    const c = getContentType(m);

    if (c === "conversation") return m.conversation || "";
    if (c === "extendedTextMessage") return m.extendedTextMessage?.text || "";
    if (c === "imageMessage" || c === "videoMessage" || c === "documentMessage")
      return m?.[c]?.caption || "";
    if (c === "contactMessage") return m?.contactMessage?.displayName || "";
    if (c === "contactsArrayMessage")
      return `Contacts: ${(m?.contactsArrayMessage?.contacts || []).length}`;
    if (c === "buttonsMessage")
      return m.buttonsMessage?.contentText || m.buttonsMessage?.text || "";
    if (c === "templateMessage")
      return (
        m.templateMessage?.hydratedTemplate?.hydratedContentText ||
        m.templateMessage?.fourRowTemplate?.content?.text ||
        ""
      );
    if (c === "listResponseMessage")
      return (
        m.listResponseMessage?.title ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ""
      );
    if (c === "interactiveResponseMessage")
      return (
        m.interactiveResponseMessage?.body?.text ||
        m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
        ""
      );

    if (
      c === "pollCreationMessage" ||
      c === "pollCreationMessageV2" ||
      c === "pollCreationMessageV3"
    ) {
      const p =
        m?.pollCreationMessage ||
        m?.pollCreationMessageV2 ||
        m?.pollCreationMessageV3 ||
        {};
      const title = p?.name || p?.title || p?.question || p?.pollName || "poll";
      return `poll [${String(title).trim() || "poll"}]`;
    }

    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m?.imageMessage?.caption ||
      m?.videoMessage?.caption ||
      m?.documentMessage?.caption ||
      ""
    );
  } catch {
    return "";
  }
}

const MEDIA_MESSAGE_TYPES_WITH_URL = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "ptvMessage",
]);

const cleanStringValue = (value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const trimmed = String(value).trim();
    return trimmed || null;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
    const trimmed = value.toString("utf8").trim();
    return trimmed || null;
  }
  return null;
};

function resolveMessageId(candidate) {
  try {
    if (!candidate) return null;
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "bigint"
    ) {
      const s = String(candidate).trim();
      return s || null;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(candidate)) {
      const s = candidate.toString("utf8").trim();
      return s || null;
    }
    if (candidate?.id) return resolveMessageId(candidate.id);
    if (candidate?.key?.id) return resolveMessageId(candidate.key.id);
    if (candidate?.keyId) return resolveMessageId(candidate.keyId);
    if (candidate?.message?.key?.id)
      return resolveMessageId(candidate.message.key.id);
    return null;
  } catch {
    return null;
  }
}

function applyMediaDecryptMetadata(container, payload = {}) {
  try {
    if (!container || typeof container !== "object") return false;
    const wrap = container?.message ? container : { message: container };
    const unwrapped = unwrapMessage(wrap);
    if (!unwrapped) return false;
    const ctype = getContentType(unwrapped);
    if (!MEDIA_MESSAGE_TYPES_WITH_URL.has(ctype)) return false;
    const node = unwrapped?.[ctype];
    if (!node || typeof node !== "object") return false;

    let changed = false;
    const urlVal =
      cleanStringValue(payload.urlDecrypt) ||
      cleanStringValue(payload.storageUrl) ||
      cleanStringValue(payload.url);
    if (urlVal && node.urlDecrypt !== urlVal) {
      node.urlDecrypt = urlVal;
      changed = true;
    }
    const storageKey = cleanStringValue(payload.storageKey);
    if (storageKey && node.storageKey !== storageKey) {
      node.storageKey = storageKey;
      changed = true;
    }
    const storageDriver = cleanStringValue(payload.storageDriver);
    if (storageDriver && node.storageDriver !== storageDriver) {
      node.storageDriver = storageDriver;
      changed = true;
    }
    return changed;
  } catch {
    return false;
  }
}

/* ========================================================================== *
 * Edit payload helpers
 * ========================================================================== */
function editTimestampMs(unwrapped) {
  const pm =
    unwrapped?.protocolMessage ||
    unwrapped?.editedMessage?.message?.protocolMessage ||
    unwrapped?.editedMessage?.protocolMessage;
  const raw =
    pm?.timestampMs ||
    unwrapped?.senderTimestampMs ||
    unwrapped?.messageTimestamp ||
    null;
  const n =
    typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : 0;
  return Number.isFinite(n) && n > 0 ? n : nowMs();
}

function extractEditPayload(unwrapped) {
  const p1 = unwrapped?.protocolMessage;
  if (p1?.key?.id && (p1?.editedMessage || p1?.editedMessage?.message)) {
    return {
      targetKey: p1.key,
      edited: p1.editedMessage?.message || p1.editedMessage,
      tsMs: editTimestampMs(unwrapped),
    };
  }
  if (unwrapped?.editedMessage && unwrapped?.protocolMessage?.key?.id) {
    return {
      targetKey: unwrapped.protocolMessage.key,
      edited: unwrapped.editedMessage?.message || unwrapped.editedMessage,
      tsMs: editTimestampMs(unwrapped),
    };
  }
  const p3 = unwrapped?.editedMessage?.message?.protocolMessage;
  if (p3?.key?.id) {
    return {
      targetKey: p3.key,
      edited:
        p3.editedMessage?.message ||
        p3.editedMessage ||
        unwrapped.editedMessage?.message,
      tsMs: editTimestampMs(unwrapped),
    };
  }
  const p4 = unwrapped?.editedMessage?.protocolMessage;
  if (p4?.key?.id) {
    return {
      targetKey: p4.key,
      edited:
        p4.editedMessage?.message ||
        p4.editedMessage ||
        unwrapped.editedMessage,
      tsMs: editTimestampMs(unwrapped),
    };
  }
  return null;
}

/* ========================================================================== *
 * Poll helpers (minimal but safe)
 * ========================================================================== */
function getPollCreation(rawOrMsg) {
  const m =
    rawOrMsg?.message?.pollCreationMessage ||
    rawOrMsg?.message?.pollCreationMessageV2 ||
    rawOrMsg?.message?.pollCreationMessageV3 ||
    rawOrMsg?.pollCreationMessage ||
    rawOrMsg?.pollCreationMessageV2 ||
    rawOrMsg?.pollCreationMessageV3;
  if (!m) return null;
  const options = Array.isArray(m.options) ? m.options : [];
  const maxSelect = Number(m.selectableOptionsCount || 1) || 1;
  return { creation: m, options, maxSelect };
}

function resolveOptionNames(creationOptions = [], selectedOptions = []) {
  const names = [];
  for (const so of selectedOptions || []) {
    let idx = null;
    try {
      if (typeof so === "number") idx = so;
      else if (typeof so === "bigint") idx = Number(so);
      else if (so && typeof so === "object" && "toString" in so) {
        const s = String(so.toString?.("utf8") || so + "");
        const maybe = Number(s);
        if (Number.isFinite(maybe)) idx = maybe;
      }
    } catch {}
    if (
      idx !== null &&
      Number.isFinite(idx) &&
      creationOptions[idx] &&
      creationOptions[idx].optionName
    ) {
      names.push(String(creationOptions[idx].optionName));
    }
  }
  return names;
}

function arrEqUnordered(a = [], b = []) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  if (sa.size !== a.length) return false;
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

function computePollState(rawObj, selfJid) {
  const meta = getPollCreation(rawObj);
  if (!meta) return { results: [], latestByVoter: {} };
  const { creation, options, maxSelect } = meta;

  const latestByVoter = {};
  const updates = Array.isArray(rawObj.pollUpdates) ? rawObj.pollUpdates : [];

  for (const upd of updates) {
    try {
      const byRaw =
        upd?.key?.participant ||
        upd?.key?.remoteJid ||
        upd?.pollCreationMessageKey?.participant ||
        upd?.pollMessageKey?.participant ||
        null;
      const by = normalizeVoterJidBestEffort(byRaw);
      if (!by) continue;

      let selected = [];
      if (creation && selfJid) {
        try {
          const dec = decryptPollVote(upd, creation, selfJid);
          if (dec?.selectedOptions?.length) selected = dec.selectedOptions;
        } catch {}
      }
      if ((!selected || !selected.length) && upd?.vote?.selectedOptions) {
        selected = upd.vote.selectedOptions;
      }
      if (!selected || !selected.length) continue;

      let chosenNames = resolveOptionNames(options, selected);
      if (maxSelect <= 1) chosenNames = chosenNames.slice(-1);
      else if (chosenNames.length > maxSelect)
        chosenNames = chosenNames.slice(-maxSelect);

      latestByVoter[by] = chosenNames;
    } catch {}
  }

  const resultsMap = new Map();
  for (const opt of options) {
    if (!opt?.optionName) continue;
    resultsMap.set(String(opt.optionName), new Set());
  }
  for (const [voter, names] of Object.entries(latestByVoter)) {
    for (const name of names || []) {
      if (resultsMap.has(name)) resultsMap.get(name).add(String(voter));
    }
  }
  const results = [...resultsMap.entries()].map(([name, set]) => ({
    name,
    voters: [...set],
  }));
  return { results, latestByVoter };
}

/* ========================================================================== *
 * Finalization / edit guards
 * ========================================================================== */
const isRawFinalized = (raw) => !!raw?.deletedAt;
const getRawLastEditedMs = (raw) => {
  const ms = Number(raw?.lastEditedMs || 0);
  return Number.isFinite(ms) ? ms : 0;
};

/* ========================================================================== *
 * Reactions normalization (dedupe + forbid null from)
 * ========================================================================== */
function sanitizeReactionsInRaw(raw) {
  if (!raw) return;
  if (!raw.meta || typeof raw.meta !== "object") raw.meta = {};
  const arr = Array.isArray(raw.meta.reactions) ? raw.meta.reactions : [];
  const map = new Map();
  for (const it of arr) {
    const from = normalizeVoterJidBestEffort(it?.from);
    if (!from) continue;
    const emoji = String(it?.emoji || it?.text || "").trim();
    const ts = Number(it?.ts || nowSec()) || nowSec();
    if (!emoji) continue;
    map.set(from, { emoji, text: emoji, from, ts });
  }
  raw.meta.reactions = [...map.values()];
  if (Array.isArray(raw.reactions)) {
    for (const it of raw.reactions) {
      const from = normalizeVoterJidBestEffort(it?.from);
      if (!from) continue;
      const emoji = String(it?.emoji || it?.text || "").trim();
      const ts = Number(it?.ts || nowSec()) || nowSec();
      if (!emoji) continue;
      map.set(from, { emoji, text: emoji, from, ts });
    }
    raw.meta.reactions = [...map.values()];
    delete raw.reactions;
  }
}

function applyReactionToRaw(raw, { from, emoji, ts }) {
  if (!from) return false;
  if (!raw.meta || typeof raw.meta !== "object") raw.meta = {};
  const arr = Array.isArray(raw.meta.reactions) ? raw.meta.reactions : [];
  const list = [];
  let replaced = false;
  for (const it of arr) {
    const f = normalizeVoterJidBestEffort(it?.from);
    if (!f) continue;
    if (f === from) {
      replaced = true;
      if (!emoji) {
      } else {
        list.push({
          emoji,
          text: emoji,
          from,
          ts: Number(ts || nowSec()) || nowSec(),
        });
      }
    } else {
      const e = String(it.emoji || it.text || "");
      if (e) {
        list.push({
          emoji: e,
          text: e,
          from: f,
          ts: Number(it.ts || nowSec()) || nowSec(),
        });
      }
    }
  }
  if (!replaced && emoji) {
    list.push({
      emoji,
      text: emoji,
      from,
      ts: Number(ts || nowSec()) || nowSec(),
    });
  }
  if (list.length) raw.meta.reactions = list;
  else delete raw.meta.reactions;
  return true;
}

/* ========================================================================== *
 * Message type mapping & preview formatting
 * ========================================================================== */
const ALLOWED_DB_TYPES = new Set([
  "conversation",
  "extendedTextMessage",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "ptvMessage",
  "contactMessage",
  "contactsArrayMessage",
  "locationMessage",
  "liveLocationMessage",
  "interactive",
  "event",
  "poll",
  "gif",
  "system",
]);

function mapDbMessageType(unwrapped, ctype) {
  if (!ctype) return null;

  if (
    ctype === "interactiveResponseMessage" ||
    ctype === "buttonsResponseMessage" ||
    ctype === "listResponseMessage" ||
    ctype === "templateButtonReplyMessage" ||
    ctype === "templateMessage" ||
    ctype === "buttonsMessage"
  )
    return "interactive";

  if (
    ctype === "pollCreationMessage" ||
    ctype === "pollCreationMessageV2" ||
    ctype === "pollCreationMessageV3"
  )
    return "poll";

  if (ctype === "eventMessage") return "event";

  if (ctype === "videoMessage" && unwrapped?.videoMessage?.gifPlayback)
    return "gif";

  if (ALLOWED_DB_TYPES.has(ctype)) return ctype;

  if (
    ctype === "protocolMessage" ||
    ctype === "senderKeyDistributionMessage" ||
    ctype === "senderKeyDistributionMessageV2"
  )
    return null;

  return null;
}

function simpleTypeLabelForBody(dbType) {
  switch (dbType) {
    case "imageMessage":
      return "image";
    case "videoMessage":
    case "ptvMessage":
      return "video";
    case "gif":
      return "gif";
    case "audioMessage":
      return "audio";
    case "documentMessage":
      return "document";
    case "stickerMessage":
      return "sticker";
    case "contactMessage":
      return "contact";
    case "contactsArrayMessage":
      return "contacts";
    case "locationMessage":
    case "liveLocationMessage":
      return "location";
    default:
      return dbType;
  }
}

function buildMediaLikeBody(unwrapped, dbType) {
  const label = simpleTypeLabelForBody(dbType);
  const prettyLabel =
    label && label.length
      ? label.charAt(0).toUpperCase() + label.slice(1)
      : "Media";
  const cap =
    unwrapped?.imageMessage?.caption ||
    unwrapped?.videoMessage?.caption ||
    unwrapped?.documentMessage?.caption ||
    "";
  const prefix = `([${prettyLabel}])`;
  return cap ? `${prefix} ${cap}` : `${prefix}`;
}

function buildPollBody(unwrapped) {
  const poll =
    unwrapped?.pollCreationMessage ||
    unwrapped?.pollCreationMessageV2 ||
    unwrapped?.pollCreationMessageV3 ||
    {};
  const title =
    poll.name || poll.title || poll.question || poll.pollName || "Poll";
  return `([Poll]) ${title}`.trim();
}

const CANONICAL_DB_TYPE = {
  conversation: "conversation",
  extendedTextMessage: "extendedtextmessage",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video",
  gif: "gif",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "stickermessage",
  contactMessage: "contact",
  contactsArrayMessage: "contact",
  locationMessage: "location",
  liveLocationMessage: "location",
  interactive: "interactive",
  event: "event",
  poll: "poll",
  system: "system",
};

const canonicalMessageType = (dbType) => {
  if (!dbType) return null;
  const canon = CANONICAL_DB_TYPE[dbType];
  if (canon) return canon;
  if (typeof dbType === "string") return dbType.toLowerCase();
  return null;
};

/* ========================================================================== *
 * Store Manager
 * ========================================================================== */
export function createStoreManager({ sessionId, logger = appLogger }) {
  const chats = new Map();
  const contacts = new Map();
  const lidToJid = new Map();
  const messages = new Map();
  const msgIdIndex = new Map();

  const pendingMsgPatches = new Map();

  let selfJid = null;
  let disposed = false;

  let persistTimer = null;
  let autoPersistTimer = null;

  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const applyMentionReplacements = (text, replacements) => {
    if (typeof text !== "string" || !replacements || !replacements.size)
      return text;
    let result = text;
    for (const [needle, replacement] of replacements.entries()) {
      if (!needle || !replacement || needle === replacement) continue;
      const pattern = new RegExp(`@${escapeRegex(needle)}`, "g");
      result = result.replace(pattern, `@${replacement}`);
    }
    return result;
  };

  const canonicalizeLidKey = (value) => {
    const stripped = stripDeviceSuffix(String(value || "").trim());
    if (!stripped) return null;
    const lower = stripped.toLowerCase();
    if (lower.endsWith("@lid")) return lower;
    if (!lower.includes("@") && /^\d{5,}$/.test(lower)) return `${lower}@lid`;
    return null;
  };

  const rememberLidMapping = (lidValue, resolvedJid) => {
    const key = canonicalizeLidKey(lidValue);
    if (!key) return;
    const normalized = normalizeUserJidStrict(resolvedJid);
    if (!normalized || !normalized.endsWith("@s.whatsapp.net")) return;
    lidToJid.set(key, normalized);
  };

  const resolveMappedLid = (value) => {
    const key = canonicalizeLidKey(value);
    if (!key) return null;
    if (lidToJid.has(key)) return lidToJid.get(key);
    for (const contact of contacts.values()) {
      const hints = [
        contact?.lid,
        contact?.lidJid,
        contact?.lidUser,
        contact?.rawId,
      ];
      for (const hint of hints) {
        if (canonicalizeLidKey(hint) === key) {
          const candidate =
            (typeof contact?.jid === "string" && contact.jid) ||
            (typeof contact?.id === "string" && contact.id) ||
            (typeof contact?.phone === "string"
              ? normalizeUserJidStrict(contact.phone)
              : null);
          const normalized = normalizeUserJidStrict(candidate);
          if (normalized && normalized.endsWith("@s.whatsapp.net")) {
            lidToJid.set(key, normalized);
            return normalized;
          }
        }
      }
    }
    return null;
  };

  const CONTEXT_KEYS = [
    "contextInfo",
    "messageContextInfo",
    "conversationContextInfo",
  ];
  const TEXT_KEYS = new Set([
    "conversation",
    "text",
    "caption",
    "contentText",
    "footerText",
    "body",
    "description",
    "title",
    "buttonText",
  ]);

  const prepareMentions = (list) => {
    const arr = Array.isArray(list) ? list : [];
    const normalizedList = [];
    const replacements = new Map();
    const seen = new Set();
    for (const raw of arr) {
      const trimmed = stripDeviceSuffix(String(raw || "").trim());
      if (!trimmed) continue;
      let resolved = resolveMappedLid(trimmed);
      if (!resolved) {
        if (
          /@lid$/i.test(trimmed) ||
          (!trimmed.includes("@") && /^\d{5,}$/.test(trimmed))
        ) {
          continue;
        }
        resolved = normalizeUserJidStrict(trimmed);
      }
      if (!resolved || !resolved.endsWith("@s.whatsapp.net")) continue;
      if (!isValidUserJid(resolved)) continue;
      rememberLidMapping(trimmed, resolved);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      normalizedList.push(resolved);
      const rawLocal = trimmed.split("@")[0];
      const normLocal = resolved.split("@")[0];
      if (rawLocal && normLocal && rawLocal !== normLocal) {
        replacements.set(rawLocal, normLocal);
        replacements.set(`${rawLocal}@lid`, `${normLocal}@s.whatsapp.net`);
      }
    }
    return { normalized: normalizedList, replacements };
  };

  const applyMentionsToMessageTree = (
    root,
    replacements,
    mentions,
    visited = new WeakSet()
  ) => {
    const hasMentions = Array.isArray(mentions) && mentions.length > 0;
    const hasReplacements = replacements && replacements.size;
    if ((!hasMentions && !hasReplacements) || !root) return;
    if (typeof root !== "object") return;
    if (visited.has(root)) return;
    visited.add(root);

    if (hasMentions) {
      for (const key of CONTEXT_KEYS) {
        if (root[key] && typeof root[key] === "object") {
          root[key].mentionedJid = [...mentions];
        }
      }
    }

    for (const [key, value] of Object.entries(root)) {
      if (typeof value === "string" && hasReplacements && TEXT_KEYS.has(key)) {
        root[key] = applyMentionReplacements(value, replacements);
      } else if (value && typeof value === "object") {
        applyMentionsToMessageTree(value, replacements, mentions, visited);
      }
    }
  };

  const hydrateMentionInfo = (payload) => {
    if (!payload) return null;
    const normalized = Array.isArray(payload.normalized)
      ? payload.normalized
          .map((jid) => normalizeUserJidStrict(jid))
          .filter((jid) => jid && isValidUserJid(jid))
      : [];
    const replacements = new Map();
    if (Array.isArray(payload.replacements)) {
      for (const entry of payload.replacements) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [from, to] = entry;
        if (typeof from === "string" && typeof to === "string") {
          replacements.set(from, to);
        }
      }
    }
    return { normalized, replacements };
  };

  /* ------------------------------------------------------------------------ *
   * Persist scheduling
   * --------------------------------------------------------------------- */
  const schedulePersist = () => {
    if (disposed) return;
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      await persistDb();
    }, 800);
    persistTimer.unref?.();
  };

  const startAutoPersist = () => {
    if (disposed || autoPersistTimer) return;
    autoPersistTimer = setInterval(() => {
      persistDb().catch(() => {});
    }, 15_000);
    autoPersistTimer.unref?.();
  };

  const stopAutoPersist = () => {
    if (autoPersistTimer) {
      clearInterval(autoPersistTimer);
      autoPersistTimer = null;
    }
  };

  /* ------------------------------------------------------------------------ *
   * Contacts & Chats upsert
   * --------------------------------------------------------------------- */
  function isValidPersonalJid(jid) {
    return isValidUserJid(stripDeviceSuffix(String(jid || "")));
  }

  function upsertContact(entry = {}) {
    const rawJ = String(entry?.id || entry?.jid || "").trim();
    let jid =
      normalizeChatJid(rawJ) ||
      (function () {
        const d = pickAnyDigits(entry);
        if (!d) return null;
        const norm = normalizeMsisdnDigitsLocal(d);
        return norm ? `${norm}@s.whatsapp.net` : null;
      })();
    if (!jid) return;
    if (isJidStatusBroadcast?.(jid) || jid === "status@broadcast") return;
    if (isJidNewsletter?.(jid) || jid.endsWith("@newsletter")) return;
    if (!isGroupJid(jid) && !isValidPersonalJid(jid)) return;
    if (jid === selfJid && !entry?.isMe) return;

    const prev = contacts.get(jid) || {};
    const clean = (v) => {
      const s = String(v ?? "").trim();
      if (!s || s === "?") return null;
      return s;
    };

    const push =
      clean(entry?.pushName) ||
      clean(entry?.pushname) ||
      clean(entry?.notify) ||
      clean(entry?.name) ||
      clean(prev.pushName) ||
      clean(prev.pushname) ||
      null;

    const verified = clean(entry?.verifiedName) || clean(prev.verifiedName);
    const numberDigits = isGroupJid(jid) ? null : onlyDigits(jid.split("@")[0]);

    const fallbackName = isGroupJid(jid)
      ? clean(entry?.subject) ||
        clean(entry?.name) ||
        prev.name ||
        jid.split("@")[0]
      : prettyPhoneLabel(numberDigits) || numberDigits || jid.split("@")[0];

    const resolvedName =
      verified ||
      clean(entry?.name) ||
      push ||
      prev.name ||
      prev.notify ||
      fallbackName ||
      "WhatsApp User";

    contacts.set(jid, {
      ...prev,
      ...entry,
      jid,
      id: jid,
      rawId: rawJ || prev.rawId || null,
      verifiedName: verified || prev.verifiedName || null,
      notify: clean(entry?.notify) || prev.notify || null,
      name: resolvedName,
      isMyContact: !!(entry?.isMyContact ?? prev.isMyContact),
      isMe: !!(entry?.isMe ?? prev.isMe),
      __source: entry?.__source || prev.__source || null,
    });

    rememberLidMapping(rawJ, jid);
    rememberLidMapping(entry?.lid, jid);
    rememberLidMapping(entry?.lidJid, jid);
    rememberLidMapping(entry?.lidUser, jid);
  }

  function upsertChat(entry = {}) {
    const rawId = String(entry?.id || entry?.jid || "").trim();
    const jid = normalizeChatJid(rawId);
    if (!jid) return;
    if (!isGroupJid(jid) && !isValidPersonalJid(jid)) return;
    if (jid === selfJid && entry?.allowSelf !== true) return;

    const now = nowSec();
    const prev = chats.get(jid) || { createdAt: now };
    const merged = {
      id: jid,
      jid,
      name:
        entry?.name ||
        prev.name ||
        entry?.subject ||
        entry?.notify ||
        (isGroupJid(jid)
          ? jid.split("@")[0]
          : prettyPhoneLabel(onlyDigits(jid.split("@")[0]))),
      isGroup: isGroupJid(jid),
      unreadCount: Number(entry?.unreadCount ?? prev.unreadCount ?? 0),
      lastMessage: prev.lastMessage || null,
      lastMessageTimestamp: tsMsToSec(
        entry?.conversationTimestamp ?? prev.lastMessageTimestamp ?? 0
      ),
      ephemeralExpiry:
        Number(entry?.ephemeralDuration || entry?.ephemeralExpiration || 0) ||
        0,
      createdAt: prev.createdAt || now,
    };
    chats.set(jid, merged);

    upsertContact({
      id: jid,
      name: merged.name,
      isMyContact: !!entry?.isMyContact,
      __source: "chat",
    });

    schedulePersist();
  }

  /* ------------------------------------------------------------------------ *
   * DB helpers
   * --------------------------------------------------------------------- */
  const patchMessageRaw = async (targetId, patchFn) => {
    try {
      if (!targetId) return false;
      const row = await knex("sync_messages")
        .where({ session_id: sessionId, id: targetId })
        .first();

      if (!row) {
        const key = String(targetId);
        if (!pendingMsgPatches.has(key)) pendingMsgPatches.set(key, []);
        pendingMsgPatches.get(key).push(patchFn);
        schedulePersist();
        return false;
      }

      let rawObj = {};
      try {
        rawObj = JSON.parse(row.raw || "null") || {};
      } catch {}
      sanitizeReactionsInRaw(rawObj);

      const changed = patchFn(rawObj) !== false;
      if (!changed) return true;

      sanitizeReactionsInRaw(rawObj);
      await knex("sync_messages")
        .where({ session_id: sessionId, id: targetId })
        .update({
          raw: JSON.stringify(rawObj),
          updated_at_sec: nowSec(),
          updated_at: knex.fn.now(),
        });
      return true;
    } catch {
      return false;
    }
  };

  const patchMemoryMeta = (targetId, patchFn) => {
    try {
      const m = msgIdIndex.get(String(targetId || ""));
      if (!m) return;
      if (!m.__warestMeta) m.__warestMeta = {};
      patchFn(m.__warestMeta);
    } catch {}
  };

  const updateBodyPreview = async (targetId, preview, forceSystem = false) => {
    try {
      const up = {
        body: preview,
        updated_at_sec: nowSec(),
        updated_at: knex.fn.now(),
      };
      if (forceSystem) up.message_type = "system";
      await knex("sync_messages")
        .where({ session_id: sessionId, id: targetId })
        .update(up);
    } catch {}
  };

  async function recomputeChatLastMessage(chatJid) {
    try {
      const latest = await knex("sync_messages")
        .where({ session_id: sessionId, chat_jid: chatJid })
        .orderBy("timestamp_sec", "desc")
        .first();

      if (latest) {
        let raw = {};
        try {
          raw = JSON.parse(latest.raw || "null") || {};
        } catch {}
        const lastText = raw.editedPreview || latest.body || SYS_DELETED_TEXT;
        await knex("sync_chats")
          .where({ session_id: sessionId, jid: chatJid })
          .update({
            last_message: lastText,
            last_message_ts: Number(latest.timestamp_sec || 0) || 0,
            updated_at_sec: nowSec(),
            updated_at: knex.fn.now(),
          });
      } else {
        await knex("sync_chats")
          .where({ session_id: sessionId, jid: chatJid })
          .update({
            last_message: null,
            last_message_ts: 0,
            updated_at_sec: nowSec(),
            updated_at: knex.fn.now(),
          });
      }
    } catch {}
  }

  const updateChatLastMessageIfLatest = async (chatJid, msgId) => {
    try {
      const latest = await knex("sync_messages")
        .where({ session_id: sessionId, chat_jid: chatJid })
        .orderBy("timestamp_sec", "desc")
        .first();

      if (latest && latest.id === msgId) {
        await recomputeChatLastMessage(chatJid);
      }
    } catch {}
  };

  const setMediaDecryptedUrl = async (target, payload = {}) => {
    try {
      const resolved =
        resolveMessageId(target) ||
        resolveMessageId(target?.key) ||
        resolveMessageId(target?.message?.key);
      if (!resolved) return false;
      const id = String(resolved);

      const normalizedPayload = {
        urlDecrypt:
          cleanStringValue(payload.urlDecrypt) ||
          cleanStringValue(payload.storageUrl) ||
          cleanStringValue(payload.url),
        storageKey: cleanStringValue(payload.storageKey),
        storageDriver: cleanStringValue(payload.storageDriver),
      };
      if (
        !normalizedPayload.urlDecrypt &&
        !normalizedPayload.storageKey &&
        !normalizedPayload.storageDriver
      )
        return false;

      let memChanged = false;
      const memMsg = msgIdIndex.get(id);
      if (memMsg) {
        memChanged =
          applyMediaDecryptMetadata(memMsg, normalizedPayload) || memChanged;
      }

      const patched = await patchMessageRaw(id, (raw) =>
        applyMediaDecryptMetadata(raw, normalizedPayload)
      );
      return !!(memChanged || patched);
    } catch {
      return false;
    }
  };

  const setMessageStarred = async (target, starred = false) => {
    try {
      const resolved =
        resolveMessageId(target) ||
        resolveMessageId(target?.key) ||
        String(target || "");
      const id = String(resolved || "").trim();
      if (!id) return false;

      let memChanged = false;
      const memMsg = msgIdIndex.get(id);
      if (memMsg) {
        const nextStar = !!starred;
        if (nextStar && !memMsg.starred) {
          memMsg.starred = true;
          memChanged = true;
        } else if (!nextStar && memMsg.starred) {
          delete memMsg.starred;
          memChanged = true;
        }
        if (!memMsg.__warestMeta) memMsg.__warestMeta = {};
        if (nextStar) memMsg.__warestMeta.starred = true;
        else delete memMsg.__warestMeta.starred;
      }

      const patched = await patchMessageRaw(id, (raw) => {
        if (isRawFinalized(raw)) return false;
        if (!raw.meta || typeof raw.meta !== "object") raw.meta = {};
        const before = !!raw.starred;
        if (starred) {
          raw.starred = true;
          raw.meta.starredAt = raw.meta.starredAt || nowSec();
        } else {
          if ("starred" in raw) delete raw.starred;
          if (raw.meta.starredAt) delete raw.meta.starredAt;
        }
        return before !== !!raw.starred;
      });

      return !!(memChanged || patched);
    } catch {
      return false;
    }
  };

  function displayNameOf(jid) {
    try {
      const canonical = canonicalizeJidLoose(jid);
      if (!canonical) return String(jid || "");
      const entry = contacts.get(canonical) || {};
      const pick = (...vals) => {
        for (const v of vals) {
          const s = String(v ?? "").trim();
          if (s) return s;
        }
        return null;
      };
      const label =
        pick(
          entry.name,
          entry.pushName,
          entry.pushname,
          entry.notify,
          entry.verifiedName
        ) || null;
      if (label) return label;
      if (!isGroupJid(canonical)) {
        const digits = onlyDigits(canonical.split("@")[0]);
        if (digits) return prettyPhoneLabel(digits) || `+${digits}`;
      }
      return canonical.split("@")[0] || canonical;
    } catch {
      return String(jid || "");
    }
  }

  async function insertSystemEventMessage(chatJid, body, ts = nowSec(), byJid) {
    try {
      const sysId = `sys_${ulid()}`;
      await knex("sync_messages")
        .insert({
          session_id: sessionId,
          id: sysId,
          chat_jid: chatJid,
          from_me: byJid ? byJid === selfJid : false,
          sender_jid: byJid || null,
          to_jid: chatJid,
          message_type: "system",
          body,
          timestamp_sec: ts || nowSec(),
          raw: JSON.stringify({
            system: { type: "event", by: byJid || null, body },
          }),
          updated_at_sec: nowSec(),
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        })
        .onConflict(["session_id", "id"])
        .ignore();

      await recomputeChatLastMessage(chatJid);
    } catch {}
  }

  /* ------------------------------------------------------------------------ *
   * Message ingest & update core
   * --------------------------------------------------------------------- */
  async function upsertMessage(msg) {
    try {
      const jid = canonicalizeJidLoose(msg?.key?.remoteJid);
      const id = String(msg?.key?.id || "").trim();
      if (!jid || !id) return;
      if (!isGroupJid(jid) && !isValidPersonalJid(jid)) return;
      if (jid === selfJid && !chats.has(jid)) return;

      const senderJidCandidate =
        msg?.key?.participant ||
        (msg?.key?.fromMe ? selfJid : msg?.participant) ||
        msg?.key?.remoteJid ||
        null;
      const normalizedSender =
        normalizeUserJidStrict(senderJidCandidate) ||
        (msg?.key?.fromMe ? selfJid : null);
      if (normalizedSender) {
        const lidHints = [
          msg?.key?.senderLid,
          msg?.key?.participantLid,
          msg?.key?.lid,
          msg?.senderLid,
          msg?.participantLid,
        ];
        for (const hint of lidHints) rememberLidMapping(hint, normalizedSender);
        if (msg?.key) {
          if (!msg.key.rawParticipant && msg.key.participant)
            msg.key.rawParticipant = msg.key.participant;
          msg.key.participant = normalizedSender;
        }
      }
      if (msg?.key?.participant && msg?.key?.participantPn) {
        rememberLidMapping(msg.key.participant, msg.key.participantPn);
      }
      if (msg?.participant && msg?.participantPn) {
        rememberLidMapping(msg.participant, msg.participantPn);
      }

      let existingRow = null;
      let existingRaw = null;
      try {
        existingRow = await knex("sync_messages")
          .where({ session_id: sessionId, id })
          .first();
        if (existingRow) {
          existingRaw = JSON.parse(existingRow.raw || "null") || {};
        }
      } catch {}

      const unwrapped = unwrapMessage(msg) || msg?.message || {};
      const ctype = getContentType(unwrapped);
      const dbType = mapDbMessageType(unwrapped, ctype);

      /* -------------------------- REVOKE / DELETE -------------------------- */
      const protoForRevoke = unwrapped?.protocolMessage;
      if (
        protoForRevoke &&
        typeof protoForRevoke.type === "number" &&
        protoForRevoke.type === 0 &&
        protoForRevoke?.key?.id
      ) {
        const targetId = String(protoForRevoke.key.id || "").trim();
        const targetJid = canonicalizeJidLoose(
          protoForRevoke.key.remoteJid || msg?.key?.remoteJid
        );
        if (targetId) {
          const deleterJid =
            normalizeVoterJidBestEffort(
              msg?.key?.fromMe
                ? selfJid
                : msg?.key?.participant ||
                    msg?.key?.remoteJid ||
                    msg?.participant
            ) || (msg?.key?.fromMe ? selfJid : null);
          const deleterLabel =
            deleterJid && deleterJid === selfJid
              ? "(_⊘ You deleted this message_)"
              : "(_⊘ This message was deleted_)";
          const deletionBody = deleterLabel;
          const patched = await patchMessageRaw(targetId, (raw) => {
            if (!raw) return false;
            if (!raw.meta || typeof raw.meta !== "object") raw.meta = {};
            raw.deletedAt = nowSec();
            raw.deleteEvent = {
              by: deleterJid || deleterLabel,
              ts: raw.deletedAt,
            };
            raw.meta.deletedBy = deleterJid || null;
            raw.meta.deletedBody = deletionBody;
            raw.editedPreview = deletionBody;
            raw.messageBeforeDelete = raw.messageBeforeDelete || raw.message;
            return true;
          });
          if (patched) {
            try {
              await knex("sync_messages")
                .where({ session_id: sessionId, id: targetId })
                .update({
                  body: deletionBody,
                  message_type: "system",
                  updated_at_sec: nowSec(),
                  updated_at: knex.fn.now(),
                });
            } catch {}
            if (targetJid)
              await updateChatLastMessageIfLatest(targetJid, targetId);
          }
        }
        schedulePersist();
        return;
      }

      let blockContentApply = false;
      if (existingRaw) {
        if (isRawFinalized(existingRaw)) blockContentApply = true;
        if (existingRaw.lastEditedMs) blockContentApply = true;
      }

      /* -------------------------------- EDIT -------------------------------- */
      const editPayload = extractEditPayload(unwrapped);
      if (editPayload && editPayload.targetKey?.id) {
        const targetId = String(editPayload.targetKey.id).trim();
        const eMs = Number(editPayload.tsMs || nowMs());
        if (targetId) {
          await patchMessageRaw(targetId, (raw) => {
            if (isRawFinalized(raw)) return false;
            const lastMs = getRawLastEditedMs(raw);
            if (eMs <= lastMs) return false;

            const editedMsg =
              editPayload.edited?.message || editPayload.edited || null;
            if (!editedMsg) return false;

            if (!raw.messageBeforeEdit && raw.message)
              raw.messageBeforeEdit = raw.message;
            raw.message = editedMsg;
            raw.lastEditedAt = nowSec();
            raw.lastEditedMs = eMs;

            if (!Array.isArray(raw.editEvents)) raw.editEvents = [];
            raw.editEvents.push({ ts: raw.lastEditedAt, ms: eMs });

            try {
              const tmp = { key: editPayload.targetKey, message: editedMsg };
              raw.editedPreview = extractTextLike(tmp) || null;
            } catch {}
            return true;
          });

          try {
            const fresh = await knex("sync_messages")
              .where({ session_id: sessionId, id: targetId })
              .first();
            if (fresh) {
              let rawObj = {};
              try {
                rawObj = JSON.parse(fresh.raw || "null") || {};
              } catch {}
              const newPreview =
                rawObj.editedPreview ??
                extractTextLike({
                  key: editPayload.targetKey,
                  message: rawObj.message,
                }) ??
                fresh.body ??
                null;
              await updateBodyPreview(targetId, newPreview);
              if (fresh.chat_jid)
                await updateChatLastMessageIfLatest(fresh.chat_jid, targetId);
            }
          } catch {}
          schedulePersist();
          return;
        }
      }

      /* ------------------------------ REACTIONS ---------------------------- */
      const rMsg =
        msg?.message?.reactionMessage || msg?.message?.encReactionMessage;
      if (rMsg) {
        if (existingRaw && isRawFinalized(existingRaw)) return;
        const tKey = rMsg?.key || {};
        const targetId = String(tKey?.id || "").trim();
        if (targetId) {
          const from = msg?.key?.fromMe
            ? selfJid
            : normalizeVoterJidBestEffort(
                String(msg?.key?.participant || msg?.key?.remoteJid || "")
              );
          const emoji = String(rMsg?.text || "");
          await patchMessageRaw(targetId, (raw) => {
            if (isRawFinalized(raw)) return false;
            sanitizeReactionsInRaw(raw);
            if (!emoji) {
              return applyReactionToRaw(raw, { from, emoji: "", ts: nowSec() });
            }
            return applyReactionToRaw(raw, { from, emoji, ts: nowSec() });
          });
          patchMemoryMeta(targetId, (meta) => {
            const f = normalizeVoterJidBestEffort(from);
            if (!f) return;
            const current = Array.isArray(meta.reactions)
              ? [...meta.reactions]
              : [];
            const filtered = current.filter((x) => String(x?.from || "") !== f);
            if (emoji) {
              filtered.push({
                emoji,
                text: emoji,
                from: f,
                ts: nowSec(),
              });
            }
            if (filtered.length) meta.reactions = filtered;
            else delete meta.reactions;
          });
        }
        schedulePersist();
        return;
      }

      /* ------------------------------- PIN/UNPIN --------------------------- */
      const pinMsg = unwrapped?.pinInChatMessage;
      if (pinMsg) {
        try {
          const tKey = pinMsg?.key || {};
          const targetId = String(tKey?.id || pinMsg?.id || "").trim();
          if (targetId) {
            const isPin = Number(pinMsg?.type) === 1;
            const by = normalizeVoterJidBestEffort(
              msg?.key?.fromMe
                ? selfJid
                : String(msg?.key?.participant || msg?.key?.remoteJid || "")
            );
            const expiresAt =
              Number(
                pinMsg?.expirationTimestamp || pinMsg?.expiryTimestamp || 0
              ) || undefined;
            const pinTs = nowSec();

            await patchMessageRaw(targetId, (raw) => {
              if (isRawFinalized(raw)) return false;
              if (!raw.meta || typeof raw.meta !== "object") raw.meta = {};
              if (isPin) {
                const payload = {
                  by,
                  ts: pinTs,
                  expiresAt,
                };
                raw.pinned = payload;
                raw.meta.pinned = payload;
              } else {
                if ("pinned" in raw) delete raw.pinned;
                if (raw.meta.pinned) delete raw.meta.pinned;
                if (raw.pinEvents) delete raw.pinEvents;
                if (raw.meta.pinEvents) delete raw.meta.pinEvents;
              }
              return true;
            });
            patchMemoryMeta(targetId, (meta) => {
              if (isPin) {
                meta.pinned = {
                  by,
                  ts: pinTs,
                  expiresAt,
                };
              } else {
                if (meta.pinned) delete meta.pinned;
                if (meta.pinEvents) delete meta.pinEvents;
              }
            });

            if (isPin) {
              const who = by === selfJid ? "You" : displayNameOf(by);
              const body = `[${who} pinned a message]`;
              await insertSystemEventMessage(jid, body, pinTs, by);
            }
          }
        } catch {}
        schedulePersist();
        return;
      }

      /* ------------------------------ POLL UPDATE -------------------------- */
      if (ctype === "pollUpdateMessage" || ctype === "pollUpdateMessageV2") {
        const pUpd =
          unwrapped.pollUpdateMessage || unwrapped.pollUpdateMessageV2 || {};
        const key =
          pUpd?.key ||
          pUpd?.pollCreationMessageKey ||
          pUpd?.pollMessageKey ||
          {};
        const targetId = String(key?.id || "").trim();
        if (targetId) {
          await patchMessageRaw(targetId, (raw) => {
            try {
              if (isRawFinalized(raw)) return false;
              if (!raw.meta || typeof raw.meta !== "object") raw.meta = {};

              const metaCre = getPollCreation(raw);
              let selectedOpts = [];
              if (metaCre?.creation && selfJid) {
                try {
                  const dec = decryptPollVote(pUpd, metaCre.creation, selfJid);
                  if (dec?.selectedOptions?.length)
                    selectedOpts = dec.selectedOptions;
                } catch {}
              }
              if (
                (!selectedOpts || !selectedOpts.length) &&
                pUpd?.vote?.selectedOptions
              ) {
                selectedOpts = pUpd.vote.selectedOptions;
              }

              const base = {
                message: raw.message,
                pollUpdates: Array.isArray(raw.pollUpdates)
                  ? raw.pollUpdates
                  : [],
              };
              if (Array.isArray(selectedOpts) && selectedOpts.length > 0) {
                const updApply = {
                  ...pUpd,
                  vote: { ...(pUpd.vote || {}), selectedOptions: selectedOpts },
                };
                updateMessageWithPollUpdate(base, updApply);
                raw.message = base.message;
                raw.pollUpdates = base.pollUpdates;
              }

              const prevState = raw.meta?.pollState?.latestByVoter || {};
              const { results, latestByVoter } = computePollState(raw, selfJid);

              raw.meta.pollResults = results.map((r) => ({
                name: r.name,
                voters: (r.voters || []).map((v) => String(v)),
              }));
              raw.meta.pollState = { latestByVoter };

              const by = normalizeVoterJidBestEffort(
                msg?.key?.fromMe
                  ? selfJid
                  : String(
                      msg?.key?.participant || msg?.key?.remoteJid || ""
                    ).trim()
              );
              const before = prevState?.[by] || [];
              const after = latestByVoter?.[by] || [];
              if (!arrEqUnordered(before, after)) {
                if (!Array.isArray(raw.meta.pollEvents))
                  raw.meta.pollEvents = [];
                raw.meta.pollEvents.push({ by, selected: after, ts: nowSec() });
              }
            } catch {}
            return true;
          });

          schedulePersist();
        }
        return;
      }

      const mentionInfo =
        hydrateMentionInfo(msg?.__warestMentionInfo) ||
        prepareMentions(getMentions(msg));
      if (mentionInfo.normalized.length) {
        if (!msg.__warestMeta) msg.__warestMeta = {};
        msg.__warestMeta.mentions = mentionInfo.normalized;
      } else if (msg.__warestMeta && "mentions" in msg.__warestMeta) {
        delete msg.__warestMeta.mentions;
        if (!Object.keys(msg.__warestMeta).length) delete msg.__warestMeta;
      }
      msg.__warestMentionInfo = {
        normalized: [...mentionInfo.normalized],
        replacements: [...mentionInfo.replacements.entries()],
      };
      applyMentionsToMessageTree(
        msg?.message,
        mentionInfo.replacements,
        mentionInfo.normalized
      );

      /* ---------------------------- NORMAL MESSAGE ------------------------- */
      if (!blockContentApply) {
        if (!messages.has(jid)) messages.set(jid, new Map());
        const m = messages.get(jid);
        m.set(id, msg);
        msgIdIndex.set(id, msg);
      }

      const ts = tsMsToSec(msg?.messageTimestamp || 0) || nowSec();

      let text = extractTextLike(msg) || null;
      let finalDbType = dbType;

      if (!finalDbType) {
        return;
      }

      if (
        finalDbType === "imageMessage" ||
        finalDbType === "videoMessage" ||
        finalDbType === "audioMessage" ||
        finalDbType === "documentMessage" ||
        finalDbType === "stickerMessage" ||
        finalDbType === "ptvMessage" ||
        finalDbType === "gif"
      ) {
        text = buildMediaLikeBody(unwrapped, finalDbType);
      }

      if (finalDbType === "poll") {
        text = buildPollBody(unwrapped);
      }

      try {
        if (existingRow && existingRaw) {
          if (isRawFinalized(existingRaw)) {
            finalDbType = "system";
            text = SYS_DELETED_TEXT;
          } else if (existingRaw.lastEditedMs) {
            const prefer =
              existingRaw.editedPreview ||
              extractTextLike({ key: msg.key, message: existingRaw.message }) ||
              text;
            if (prefer) text = prefer;
          }
        }
      } catch {}

      text = applyMentionReplacements(text, mentionInfo.replacements);

      const cprev = chats.get(jid) || {
        id: jid,
        jid,
        createdAt: nowSec(),
        isGroup: isGroupJid(jid),
      };
      const incUnread = !msg?.key?.fromMe ? 1 : 0;
      const unread = Math.max(0, Number(cprev.unreadCount || 0) + incUnread);

      chats.set(jid, {
        ...cprev,
        lastMessage: text,
        lastMessageTimestamp: ts,
        unreadCount: unread,
      });

      try {
        const push = String(msg?.pushName || "").trim();
        if (push) {
          if (isGroupJid(jid)) {
            const author = String(msg?.key?.participant || "").trim();
            if (author)
              upsertContact({ id: author, notify: push, __source: "history" });
          } else {
            upsertContact({ id: jid, notify: push, __source: "history" });
          }
        } else {
          upsertContact({ id: jid, __source: "history" });
        }
      } catch {}

      schedulePersist();
    } catch (e) {
      try {
        logger?.debug?.({ err: e?.message }, "upsertMessage failed");
      } catch {}
    }
  }

  /* ------------------------------------------------------------------------ *
   * Persist to DB
   * --------------------------------------------------------------------- */
  async function persistDb() {
    if (disposed) return;
    try {
      /* ------------------------------ CONTACTS ----------------------------- */
      if (contacts.size) {
        const rows = [];
        for (const ct of contacts.values()) {
          if (selfJid && ct.jid === selfJid && !ct.isMe) continue;

          const finalJid = isGroupJid(ct.jid)
            ? ct.jid
            : normalizeUserJidStrict(ct.jid);
          if (!finalJid) continue;

          const isGroup = isGroupJid(finalJid);
          const digits = isGroup ? null : onlyDigits(finalJid.split("@")[0]);

          const fallbackPhone = digits
            ? prettyPhoneLabel(digits) || digits
            : null;

          const resolvedName =
            ct.verifiedName ||
            ct.name ||
            ct.notify ||
            ct.pushName ||
            ct.pushname ||
            fallbackPhone ||
            finalJid.split("@")[0];

          const notifyVal = ct.notify || null;
          const verifiedVal = ct.verifiedName || null;

          rows.push({
            session_id: sessionId,
            jid: finalJid,
            phone: isGroup ? null : digits || null,
            name: resolvedName,
            notify: notifyVal,
            verified_name: verifiedVal,
            is_me: !!ct.isMe,
            is_my_contact: !!ct.isMyContact,
            is_group: isGroup,
            updated_at_sec: nowSec(),
            created_at: knex.fn.now(),
            updated_at: knex.fn.now(),
          });
        }
        if (rows.length) {
          const updateCols = {
            phone: knex.raw("excluded.phone"),
            name: knex.raw("excluded.name"),
            notify: knex.raw("excluded.notify"),
            verified_name: knex.raw("excluded.verified_name"),
            is_me: knex.raw("excluded.is_me"),
            is_my_contact: knex.raw("excluded.is_my_contact"),
            is_group: knex.raw("excluded.is_group"),
            updated_at_sec: knex.raw("excluded.updated_at_sec"),
            updated_at: knex.fn.now(),
          };
          for (let i = 0; i < rows.length; i += 500) {
            const chunk = rows.slice(i, i + 500);
            await knex("sync_contacts")
              .insert(chunk)
              .onConflict(["session_id", "jid"])
              .merge(updateCols);
          }
        }
      }

      /* -------------------------------- CHATS ------------------------------ */
      const chatRows = [];
      for (const c of chats.values()) {
        let hasMsg = false;
        try {
          const memSize = messages.get(c.jid)?.size || 0;
          if (memSize > 0) hasMsg = true;
          if (!hasMsg) {
            const exists = await knex("sync_messages")
              .where({ session_id: sessionId, chat_jid: c.jid })
              .first();
            hasMsg = !!exists;
          }
        } catch {}
        if (!hasMsg) continue;

        chatRows.push({
          session_id: sessionId,
          jid: c.jid,
          name: c.name || null,
          is_group: !!c.isGroup,
          unread_count: Number(c.unreadCount || 0),
          last_message: c.lastMessage || null,
          last_message_ts: Number(c.lastMessageTimestamp || 0) || 0,
          ephemeral_expiry: Number(c.ephemeralExpiry || 0) || 0,
          created_at_sec: Number(c.createdAt || 0) || nowSec(),
          updated_at_sec: nowSec(),
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        });
      }
      if (chatRows.length) {
        for (let i = 0; i < chatRows.length; i += 500) {
          const chunk = chatRows.slice(i, i + 500);
          await knex("sync_chats")
            .insert(chunk)
            .onConflict(["session_id", "jid"])
            .merge({
              name: knex.raw("excluded.name"),
              is_group: knex.raw("excluded.is_group"),
              unread_count: knex.raw("excluded.unread_count"),
              last_message: knex.raw("excluded.last_message"),
              last_message_ts: knex.raw("excluded.last_message_ts"),
              ephemeral_expiry: knex.raw("excluded.ephemeral_expiry"),
              updated_at_sec: knex.raw("excluded.updated_at_sec"),
              updated_at: knex.fn.now(),
            });
        }
      }

      /* ------------------------------ MESSAGES ----------------------------- */
      for (const [jid, m] of messages.entries()) {
        const arr = [...m.values()];
        if (!arr.length) continue;

        const candidateIds = arr
          .map((x) => String(x?.key?.id || "").trim())
          .filter(Boolean);
        if (!candidateIds.length) continue;

        const existingSet = new Set();
        for (let i = 0; i < candidateIds.length; i += 1000) {
          const slice = candidateIds.slice(i, i + 1000);
          const existing = await knex("sync_messages")
            .select("id")
            .where({ session_id: sessionId })
            .whereIn("id", slice);
          for (const r of existing) existingSet.add(String(r.id));
        }

        const rows = [];
        for (const x of arr) {
          const id = String(x?.key?.id || "").trim();
          if (!id || existingSet.has(id)) continue;

          const mentionInfo =
            hydrateMentionInfo(x?.__warestMentionInfo) ||
            prepareMentions(getMentions(x));
          if (mentionInfo.normalized.length) {
            if (!x.__warestMeta) x.__warestMeta = {};
            x.__warestMeta.mentions = mentionInfo.normalized;
          } else if (x.__warestMeta && "mentions" in x.__warestMeta) {
            delete x.__warestMeta.mentions;
            if (!Object.keys(x.__warestMeta).length) delete x.__warestMeta;
          }
          x.__warestMentionInfo = {
            normalized: [...mentionInfo.normalized],
            replacements: [...mentionInfo.replacements.entries()],
          };
          applyMentionsToMessageTree(
            x?.message,
            mentionInfo.replacements,
            mentionInfo.normalized
          );

          const unwrapped = unwrapMessage(x) || x?.message || {};
          const ctype = getContentType(unwrapped) || "";
          let dbType = mapDbMessageType(unwrapped, ctype);
          if (!dbType) continue;

          let baseRaw = {
            key: x.key,
            message: x.message,
            pollUpdates: x.pollUpdates || undefined,
            receipts: x.receipts || undefined,
            meta: x.__warestMeta || null,
          };
          if (x?.starred) baseRaw.starred = true;

          const pList = pendingMsgPatches.get(id);
          if (pList && pList.length) {
            sanitizeReactionsInRaw(baseRaw);
            for (const fn of pList) {
              try {
                fn(baseRaw);
              } catch {}
            }
            sanitizeReactionsInRaw(baseRaw);
          }

          applyMentionsToMessageTree(
            baseRaw.message,
            mentionInfo.replacements,
            mentionInfo.normalized
          );
          let bodyText =
            baseRaw.editedPreview ??
            extractTextLike({ key: x.key, message: baseRaw.message }) ??
            extractTextLike(x) ??
            null;

          if (
            dbType === "imageMessage" ||
            dbType === "videoMessage" ||
            dbType === "audioMessage" ||
            dbType === "documentMessage" ||
            dbType === "stickerMessage" ||
            dbType === "ptvMessage" ||
            dbType === "gif"
          ) {
            bodyText = buildMediaLikeBody(unwrapped, dbType);
          }

          if (dbType === "poll") {
            bodyText = buildPollBody(unwrapped);
          }

          if (isRawFinalized(baseRaw)) {
            bodyText = SYS_DELETED_TEXT;
            dbType = "system";
          }

          bodyText = applyMentionReplacements(
            bodyText,
            mentionInfo.replacements
          );

          const canonicalType = canonicalMessageType(dbType);
          if (!canonicalType) continue;

          const senderJidRaw =
            x?.key?.participant ||
            (x?.key?.fromMe ? selfJid : x?.participant) ||
            x?.key?.remoteJid ||
            jid;
          const participantPn =
            x?.key?.participantPn ||
            x?.participantPn ||
            x?.key?.senderPn ||
            null;
          const rawIsLid = /@lid$/i.test(String(senderJidRaw || ""));
          let senderJid = x?.key?.fromMe ? selfJid : null;
          if (!senderJid) senderJid = resolveMappedLid(senderJidRaw);
          if (!senderJid && participantPn) {
            const normalizedPn =
              normalizeUserJidStrict(participantPn) || participantPn;
            if (normalizedPn && normalizedPn.endsWith("@s.whatsapp.net")) {
              senderJid = normalizedPn;
              rememberLidMapping(senderJidRaw, normalizedPn);
            }
          }
          if (!senderJid && !rawIsLid) {
            senderJid =
              normalizeChatJid(senderJidRaw) ||
              normalizeUserJidStrict(senderJidRaw);
          }
          if (!senderJid) senderJid = jid;
          if (!isGroupJid(senderJid) && !isValidUserJid(senderJid)) {
            const digits = onlyDigits(senderJid.split("@")[0]);
            if (isLikelyMsisdn(digits)) senderJid = `${digits}@s.whatsapp.net`;
            else senderJid = jid;
          }
          rememberLidMapping(senderJidRaw, senderJid);

          if (baseRaw?.key) {
            if (!baseRaw.key.rawParticipant && baseRaw.key.participant)
              baseRaw.key.rawParticipant = baseRaw.key.participant;
            baseRaw.key.participant = senderJid || baseRaw.key.participant;
          }

          const timestampSec = tsMsToSec(x?.messageTimestamp || 0) || nowSec();

          rows.push({
            session_id: sessionId,
            id,
            chat_jid: jid,
            from_me: !!x?.key?.fromMe,
            sender_jid: senderJid || jid,
            to_jid: jid,
            message_type: canonicalType,
            body: bodyText ?? "",
            timestamp_sec: timestampSec,
            raw: JSON.stringify(baseRaw),
            updated_at_sec: nowSec(),
            created_at: knex.fn.now(),
            updated_at: knex.fn.now(),
          });
        }

        if (rows.length) {
          for (let i = 0; i < rows.length; i += 400) {
            const chunk = rows.slice(i, i + 400);
            await knex("sync_messages")
              .insert(chunk)
              .onConflict(["session_id", "id"])
              .ignore();
          }
          for (const r of rows) pendingMsgPatches.delete(r.id);
        }
      }
    } catch (e) {
      try {
        (logger || appLogger)?.warn?.(
          { err: e?.message },
          "store.persistDb failed"
        );
      } catch {}
    }
  }

  async function flush() {
    if (disposed) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistDb();
  }

  /* ------------------------------------------------------------------------ *
   * Bind Baileys events
   * --------------------------------------------------------------------- */
  function bind(ev) {
    startAutoPersist();

    const onExit = async () => {
      try {
        await flush();
      } catch {}
    };
    try {
      process.once?.("SIGINT", onExit);
    } catch {}
    try {
      process.once?.("SIGTERM", onExit);
    } catch {}

    try {
      ev.on?.("contacts.update", (a) =>
        (a || []).forEach((x) => upsertContact({ ...x, __source: "contacts" }))
      );
      ev.on?.("contacts.upsert", (a) =>
        (a || []).forEach((x) => upsertContact({ ...x, __source: "contacts" }))
      );
      ev.on?.("contacts.set", (p) => {
        const list = Array.isArray(p) ? p : p?.contacts || [];
        (list || []).forEach((x) =>
          upsertContact({ ...x, __source: "contacts" })
        );
        flush().catch(() => {});
      });
    } catch {}

    try {
      ev.on?.("chats.upsert", (a) => (a || []).forEach(upsertChat));
      ev.on?.("chats.update", (a) => (a || []).forEach(upsertChat));
      ev.on?.("chats.set", (p) => {
        const list = Array.isArray(p) ? p : p?.chats || [];
        const me = selfJid;
        for (const it of list || []) {
          const raw = String(it?.id || it?.jid || "").trim();
          const normalized = canonicalizeJidLoose(raw);
          const allow = me && normalized && normalized === me;
          const payload = normalized
            ? { ...it, id: normalized, jid: normalized }
            : it;
          upsertChat(allow ? { ...payload, allowSelf: true } : payload);
        }
        flush().catch(() => {});
      });
      ev.on?.("chats.delete", async (arr) => {
        const removed = [];
        for (const it of arr || []) {
          const rawJid = String(it?.id || it?.jid || it || "");
          const jid = normalizeChatJid(rawJid);
          if (!jid) continue;
          chats.delete(jid);
          messages.delete(jid);
          contacts.delete(jid);
          removed.push(jid);
        }
        if (removed.length) {
          try {
            await knex("sync_messages")
              .where({ session_id: sessionId })
              .whereIn("chat_jid", removed)
              .del();
          } catch {}
          try {
            await knex("sync_chats")
              .where({ session_id: sessionId })
              .whereIn("jid", removed)
              .del();
          } catch {}
          try {
            await knex("sync_contacts")
              .where({ session_id: sessionId })
              .whereIn("jid", removed)
              .del();
          } catch {}
        }
        schedulePersist();
      });
    } catch {}

    try {
      ev.on?.("messaging-history.set", (payload) => {
        try {
          const cts = Array.isArray(payload?.contacts)
            ? payload.contacts
            : payload?.contacts?.contacts || [];
          const chs = Array.isArray(payload?.chats)
            ? payload.chats
            : payload?.chats?.chats || [];
          const msgs = Array.isArray(payload?.messages)
            ? payload.messages
            : payload?.messages?.messages || payload?.messages?.slice?.() || [];

          (cts || []).forEach((x) =>
            upsertContact({ ...x, __source: "history" })
          );
          (chs || []).forEach(upsertChat);
          for (const m of msgs || []) upsertMessage(m);

          flush().catch(() => {});
        } catch (e) {
          logger?.debug?.({ err: e?.message }, "history.set parse failed");
        }
      });
    } catch {}

    try {
      ev.on?.("messages.upsert", (u) => {
        const arr = Array.isArray(u?.messages) ? u.messages : [];
        for (const m of arr) upsertMessage(m);
      });

      ev.on?.("messages.update", async (arr) => {
        for (const it of arr || []) {
          try {
            const unwrapped =
              unwrapMessage(it) || it?.update?.message || it?.message || {};

            const ep = extractEditPayload(unwrapped);
            if (ep?.targetKey?.id) {
              const synthetic = {
                key: it?.key || ep.targetKey,
                message: unwrapped,
              };
              await upsertMessage(synthetic);
              continue;
            }

            if (typeof it?.update?.starred === "boolean") {
              const updated = await setMessageStarred(it, it.update.starred);
              if (updated) continue;
            }

            const pinMsg =
              it?.update?.message?.pinInChatMessage ||
              it?.message?.pinInChatMessage;
            if (pinMsg) {
              const synthetic = {
                key: it?.key || {
                  remoteJid: it?.remoteJid || it?.key?.remoteJid,
                },
                message: { pinInChatMessage: pinMsg },
              };
              await upsertMessage(synthetic);
              continue;
            }

            const updMsg = it?.update?.message || it?.message || {};
            if (updMsg?.pollUpdateMessage || updMsg?.pollUpdateMessageV2) {
              const synthetic = {
                key: it?.key || {
                  remoteJid: it?.remoteJid || it?.key?.remoteJid,
                },
                message: updMsg,
              };
              await upsertMessage(synthetic);
              continue;
            }

            const proto =
              it?.update?.message?.protocolMessage ||
              it?.message?.protocolMessage;
            if (
              proto &&
              typeof proto.type === "number" &&
              proto.type === 0 &&
              (proto?.key?.id || it?.key?.id)
            ) {
              const targetId = String(
                proto?.key?.id || it?.key?.id || ""
              ).trim();
              const targetJid = String(
                proto?.key?.remoteJid || it?.key?.remoteJid || ""
              ).trim();
              if (targetId) {
                try {
                  await knex("sync_messages")
                    .where({ session_id: sessionId, id: targetId })
                    .del();
                } catch {}
                if (targetJid) await recomputeChatLastMessage(targetJid);
                try {
                  if (messages.has(targetJid))
                    messages.get(targetJid).delete(targetId);
                  msgIdIndex.delete(targetId);
                } catch {}
              }
              continue;
            }

            const id = String(it?.key?.id || it?.id || "");
            if (!id) continue;

            const row = await knex("sync_messages")
              .where({ session_id: sessionId, id })
              .first();

            if (row) {
              const r = JSON.parse(row.raw || "null") || {};
              if (isRawFinalized(r) || r.lastEditedMs) continue;
            }

            const prev = msgIdIndex.get(id);
            if (!prev) {
              const mergedFromDb = {
                ...(row ? JSON.parse(row.raw || "null") || {} : {}),
                ...(it?.update || it),
                key: it?.key || it?.update?.key || row?.key,
              };
              await upsertMessage(mergedFromDb);
              continue;
            }

            await upsertMessage({
              ...prev,
              ...(it?.update || it),
              key: it?.key || it?.update?.key || prev.key,
            });
          } catch {}
        }
      });

      ev.on?.("messages.delete", async (item) => {
        const list = Array.isArray(item) ? item : [item];
        for (const it of list) {
          const id = String(it?.key?.id || it?.id || "");
          const jid = canonicalizeJidLoose(
            it?.key?.remoteJid || it?.remoteJid || ""
          );
          if (!id) continue;

          try {
            await knex("sync_messages")
              .where({ session_id: sessionId, id })
              .del();
          } catch {}

          try {
            if (jid && messages.has(jid)) messages.get(jid).delete(id);
            msgIdIndex.delete(id);
            if (jid) await recomputeChatLastMessage(jid);
          } catch {}
        }
        schedulePersist();
      });

      ev.on?.("group-participants.update", async (upd) => {
        try {
          const arr = Array.isArray(upd) ? upd : [upd];
          for (const u of arr) {
            const parts = Array.isArray(u?.participants) ? u.participants : [];
            const groupJid = String(u?.id || "").trim();
            for (const p of parts) {
              const raw =
                typeof p === "string"
                  ? p
                  : p?.id || p?.jid || p?.participant || p?.user || "";
              const strictJid = normalizeUserJidStrict(raw);
              if (!strictJid) continue;
              upsertContact({ id: strictJid, __source: "participants" });
              rememberLidMapping(raw, strictJid);
              rememberLidMapping(p?.lid, strictJid);
              rememberLidMapping(p?.lidJid, strictJid);
            }

            if (
              Array.isArray(u?.participants) &&
              u.action === "remove" &&
              selfJid &&
              u.participants.includes(selfJid)
            ) {
              try {
                await knex("sync_contacts")
                  .where({ session_id: sessionId, jid: groupJid })
                  .del();
              } catch {}
            }
          }
          schedulePersist();
        } catch {}
      });
    } catch {}
  }

  /* ------------------------------------------------------------------------ *
   * Public APIs
   * --------------------------------------------------------------------- */
  async function getMessage(key) {
    try {
      const id = String(key?.id || "");
      if (!id) return null;
      const cached = msgIdIndex.get(id);
      if (cached) return cached;
      const row = await knex("sync_messages")
        .where({ session_id: sessionId, id })
        .first();
      if (!row) return null;
      try {
        const raw = JSON.parse(row.raw || "null");
        return raw || null;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  async function getChats({
    limit = 10,
    offset = 0,
    hasMedia = false,
    sortBy = "lastMessage",
    sortOrder = "desc",
    search = "",
  } = {}) {
    const q = String(search || "").trim();
    const dir =
      String(sortOrder || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const sortCol =
      sortBy === "id"
        ? "jid"
        : sortBy === "name"
        ? "display_name"
        : "last_message_ts";
    const base = knex("sync_chats")
      .leftJoin("sync_contacts", function () {
        this.on("sync_contacts.session_id", "sync_chats.session_id").andOn(
          "sync_contacts.jid",
          "sync_chats.jid"
        );
      })
      .where({ "sync_chats.session_id": sessionId })
      .whereExists(
        knex
          .select(1)
          .from("sync_messages")
          .whereRaw("sync_messages.session_id = sync_chats.session_id")
          .andWhereRaw("sync_messages.chat_jid = sync_chats.jid")
      )
      .select(
        "sync_chats.*",
        knex.raw(
          "COALESCE(sync_contacts.verified_name, sync_contacts.name, sync_contacts.notify, sync_chats.name) as display_name"
        )
      );
    if (selfJid) base.andWhere("sync_chats.jid", "!=", selfJid);
    if (q)
      base.andWhere((b) => {
        b.where("sync_chats.jid", "like", `%${q}%`)
          .orWhere("display_name", "like", `%${q}%`)
          .orWhere("sync_chats.name", "like", `%${q}%`);
      });
    if (hasMedia) {
      base.whereExists(
        knex
          .select(1)
          .from("sync_messages")
          .whereRaw("sync_messages.session_id = sync_chats.session_id")
          .andWhereRaw("sync_messages.chat_jid = sync_chats.jid")
          .whereIn("message_type", [
            "image",
            "video",
            "audio",
            "document",
            "stickermessage",
            "location",
            "contact",
            "gif",
          ])
      );
    }
    const totalRow = await base.clone().count({ c: "*" }).first();
    const items = await base
      .clone()
      .orderBy(sortCol, dir)
      .offset(offset)
      .limit(limit);
    return { total: Number(totalRow?.c || 0), items };
  }

  async function getMessages(
    jidRaw,
    {
      limit = 20,
      offset = 0,
      startTime,
      endTime,
      mediaOnly = false,
      isFromMe = undefined,
      search = "",
    } = {}
  ) {
    const jid = normalizeChatJid(jidRaw);
    const q = knex("sync_messages").where({
      session_id: sessionId,
      chat_jid: jid,
    });
    if (!jid || (selfJid && jid === selfJid)) return { total: 0, items: [] };
    if (startTime)
      q.andWhere(
        "timestamp_sec",
        ">=",
        Math.floor(new Date(startTime).getTime() / 1000)
      );
    if (endTime)
      q.andWhere(
        "timestamp_sec",
        "<=",
        Math.floor(new Date(endTime).getTime() / 1000)
      );
    if (mediaOnly) {
      q.whereIn("message_type", [
        "image",
        "video",
        "audio",
        "document",
        "stickermessage",
        "location",
        "contact",
        "gif",
      ]);
    }
    if (typeof isFromMe === "boolean") q.andWhere("from_me", !!isFromMe);
    if (search) q.andWhere("body", "like", `%${String(search)}%`);
    const totalRow = await q.clone().count({ c: "*" }).first();
    const items = await q
      .clone()
      .orderBy("timestamp_sec", "desc")
      .offset(offset)
      .limit(limit);
    return { total: Number(totalRow?.c || 0), items };
  }

  function setSelfJid(jid) {
    try {
      const v = canonicalizeJidLoose(jid);
      if (v) selfJid = v;
    } catch {}
  }

  async function getChatInfo(jid) {
    const row = await knex("sync_chats")
      .leftJoin("sync_contacts", function () {
        this.on("sync_contacts.session_id", "sync_chats.session_id").andOn(
          "sync_contacts.jid",
          "sync_chats.jid"
        );
      })
      .select(
        "sync_chats.*",
        knex.raw(
          "COALESCE(sync_contacts.verified_name, sync_contacts.name, sync_contacts.notify, sync_chats.name) as display_name"
        )
      )
      .where({ "sync_chats.session_id": sessionId, "sync_chats.jid": jid })
      .first();
    if (!row)
      return {
        jid,
        id: jid,
        name: null,
        isGroup: jid?.endsWith?.("@g.us") || false,
        unreadCount: 0,
        lastMessage: null,
        lastMessageTimestamp: 0,
        ephemeralExpiry: 0,
        createdAt: Math.floor(Date.now() / 1000),
      };
    return {
      id: row.jid,
      jid: row.jid,
      name: row.display_name || row.name || null,
      isGroup: !!row.is_group,
      unreadCount: Number(row.unread_count || 0),
      lastMessage: row.last_message || null,
      lastMessageTimestamp: Number(row.last_message_ts || 0) || 0,
      ephemeralExpiry: Number(row.ephemeral_expiry || 0) || 0,
      createdAt: Number(row.created_at_sec || 0) || 0,
      updatedAt: Number(row.updated_at_sec || 0) || 0,
    };
  }

  async function purgeSelfRows() {
    try {
      if (!selfJid) return;
      await knex("sync_chats")
        .where({ session_id: sessionId, jid: selfJid })
        .del();
      await knex("sync_messages")
        .where({ session_id: sessionId, chat_jid: selfJid })
        .del();
      await knex("sync_chats")
        .where({ session_id: sessionId, jid: "status@broadcast" })
        .del();
      await knex("sync_messages")
        .where({ session_id: sessionId, chat_jid: "status@broadcast" })
        .del();
      await knex("sync_chats")
        .where("session_id", sessionId)
        .andWhere("jid", "like", "%@newsletter")
        .del();
      await knex("sync_messages")
        .where("session_id", sessionId)
        .andWhere("chat_jid", "like", "%@newsletter")
        .del();
    } catch {}
  }

  async function ingestMessages(list = []) {
    for (const m of list) await upsertMessage(m);
    schedulePersist();
  }

  function dispose() {
    disposed = true;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    stopAutoPersist();
  }

  return {
    contacts,
    chats,
    messages,
    bind,
    getMessage,
    getChats,
    getMessages,
    getChatInfo,
    flush,
    dispose,
    setSelfJid,
    setMediaDecryptedUrl,
    setMessageStarred,
    purgeSelf: purgeSelfRows,
    ingestMessages,
  };
}
