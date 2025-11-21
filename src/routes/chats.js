import express from "express";
import { getContentType } from "@whiskeysockets/baileys";
import {
  getSession,
  listSessions,
  getCachedMessage,
} from "../whatsapp/baileysClient.js";
import { logger } from "../logger.js";
import { db } from "../database/index.js";
import { normalizePhoneDigits } from "../utils/phone.js";

const router = express.Router();
const DB_MEDIA_TYPES = [
  "image",
  "video",
  "audio",
  "document",
  "stickermessage",
  "location",
  "contact",
  "gif",
];
const NODE_MEDIA_TYPES = [
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "locationMessage",
  "liveLocationMessage",
  "contactMessage",
  "contactsArrayMessage",
];
const MAX_MARK_READ_BATCH = 500;
const MAX_MARK_READ_DAYS = 365;
const SECONDS_IN_DAY = 86400;

function readInput(req, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(req.query || {}, key))
      return req.query[key];
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key))
      return req.body[key];
    if (Object.prototype.hasOwnProperty.call(req.params || {}, key))
      return req.params[key];
  }
  return undefined;
}

function digitsOnly(v) {
  return String(v || "").replace(/\D+/g, "");
}
function jidify(to) {
  const raw = String(to || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) {
    const lower = raw.toLowerCase();
    if (/(?:@s\.whatsapp\.net|@g\.us|@newsletter|@broadcast)$/i.test(lower))
      return raw;
    if (/@c\.us$/i.test(lower))
      return raw.replace(/@c\.us$/i, "@s.whatsapp.net");
    const d = normalizePhoneDigits(raw);
    if (d) return `${d}@s.whatsapp.net`;
    return raw;
  }
  const digits = normalizePhoneDigits(raw);
  return digits ? `${digits}@s.whatsapp.net` : "";
}
function parseBoolean(v, def = false) {
  if (typeof v === "boolean") return v;
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}
function clampNumber(n, min, max, fb = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fb;
  return Math.min(Math.max(v, min), max);
}
function deriveNameFromJid(jid, currentName) {
  const name = String(currentName || "").trim();
  if (name) return name;
  const s = String(jid || "");
  const local = s.split("@")[0] || s;
  return local || name || "";
}

function lookupDisplayNameFromSock(session, jid) {
  try {
    const sock = session?.sock;
    const contacts = sock?.store?.contacts || sock?.contacts || null;
    if (!contacts) return null;
    const id = String(jid || "").trim();
    let c = null;
    if (contacts instanceof Map) {
      c = contacts.get(id) || null;
    } else if (contacts && typeof contacts === "object") {
      c = contacts[id] || null;
    }
    const val = c?.verifiedName || c?.name || c?.notify || null;
    const s = typeof val === "string" ? val.trim() : null;
    if (!s || s === "?") return null;
    return s;
  } catch {
    return null;
  }
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
      const local = me.split("@")[0] || "";
      const base = local.split(":")[0] || local;
      const meDigits = base.replace(/\D+/g, "");
      if (meDigits && meDigits === p) return s;
    }
  } catch {}
  return null;
}

function mePhoneOf(s) {
  try {
    const jid = String(s?.me?.id || "");
    const local = jid.split("@")[0] || "";
    const noDevice = local.split(":")[0] || local;
    const digits = noDevice.replace(/\D+/g, "");
    return digits || null;
  } catch {
    return null;
  }
}

function safeJsonParse(payload, fallback = null) {
  if (payload == null) return fallback;
  if (typeof payload !== "string") return fallback;
  try {
    return JSON.parse(payload);
  } catch {
    return fallback;
  }
}

const CONTEXT_TYPES = [
  "extendedTextMessage",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "contactMessage",
  "contactsArrayMessage",
  "locationMessage",
  "liveLocationMessage",
  "buttonsMessage",
  "listMessage",
  "interactiveMessage",
];

function extractContextInfoFromMessage(msg = {}) {
  if (!msg || typeof msg !== "object") return null;
  for (const type of CONTEXT_TYPES) {
    const node = msg[type];
    if (node?.contextInfo) return node.contextInfo;
  }
  if (msg?.contextInfo) return msg.contextInfo;
  if (msg?.conversationContextInfo) return msg.conversationContextInfo;
  return null;
}

function stringifyMaybeBuffer(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value))
      return value.toString("utf8");
  } catch {}
  try {
    if (value?.type === "Buffer" && Array.isArray(value?.data)) {
      return Buffer.from(value.data).toString("utf8");
    }
  } catch {}
  try {
    if (typeof value.toString === "function") {
      return String(value.toString());
    }
  } catch {}
  return "";
}

function buildReactions(meta = {}) {
  const list = Array.isArray(meta.reactions) ? meta.reactions : [];
  const out = [];
  for (const it of list) {
    const emoji = stringifyMaybeBuffer(it?.emoji || it?.text || "");
    const from = String(it?.from || "").trim();
    if (!emoji || !from) continue;
    const ts = Number(it?.ts || 0);
    out.push({
      from,
      emoji,
      timestamp: Number.isFinite(ts) ? ts : null,
    });
  }
  return out;
}

function cleanupDetails(obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const nested = cleanupDetails(value);
      if (nested) out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

function buildEditDetails(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lastEditedAt = toTimestampSec(raw.lastEditedAt);
  const lastEditedMs = Number(raw.lastEditedMs || 0);
  const events = Array.isArray(raw.editEvents)
    ? raw.editEvents.map((evt) => ({
        ts: Number(evt?.ts || evt?.timestamp || 0) || null,
        ms: Number(evt?.ms || 0) || null,
      }))
    : [];
  const messageBeforeEdit = raw.messageBeforeEdit || null;
  const preview = raw.editedPreview || null;
  if (
    !lastEditedAt &&
    !lastEditedMs &&
    !events.length &&
    !messageBeforeEdit &&
    !preview
  ) {
    return null;
  }
  return cleanupDetails({
    lastEditedAt: lastEditedAt || null,
    lastEditedMs: lastEditedMs || null,
    events: events.length ? events : null,
    messageBeforeEdit,
    preview,
  });
}

function buildPollSummary(raw, meta = {}) {
  if (!raw || typeof raw !== "object") return null;
  const message = raw.message || {};
  const creation =
    message.pollCreationMessage ||
    message.pollCreationMessageV2 ||
    message.pollCreationMessageV3 ||
    null;
  const summary = {};
  if (creation) {
    const question =
      stringifyMaybeBuffer(
        creation?.title || creation?.name || creation?.pollName || ""
      ) || null;
    const options = Array.isArray(creation?.options)
      ? creation.options.map((opt, idx) => ({
          index: idx,
          name: stringifyMaybeBuffer(opt?.optionName || opt),
        }))
      : [];
    summary.creation = cleanupDetails({
      question,
      options,
      selectableCount:
        creation?.selectableOptionsCount ??
        creation?.selectableOptionsCountV2 ??
        creation?.selectableCount ??
        null,
    });
  }
  const results = Array.isArray(meta?.pollResults)
    ? meta.pollResults.map((it) => ({
        name: stringifyMaybeBuffer(it?.name || ""),
        voters: Array.isArray(it?.voters)
          ? it.voters.map((v) => String(v || ""))
          : [],
      }))
    : null;
  const latestByVoter =
    meta?.pollState && typeof meta.pollState === "object"
      ? meta.pollState.latestByVoter || meta.pollState
      : null;
  const events = Array.isArray(meta?.pollEvents) ? meta.pollEvents : null;
  const updates = Array.isArray(raw?.pollUpdates) ? raw.pollUpdates : null;
  const out = {};
  if (summary.creation) out.creation = summary.creation;
  if (updates && updates.length) out.updates = updates;
  if (results) out.results = results;
  if (latestByVoter && Object.keys(latestByVoter).length)
    out.latestByVoter = latestByVoter;
  if (events && events.length) out.events = events;
  return Object.keys(out).length ? out : null;
}

function toTimestampSec(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 20_000_000_000
      ? Math.floor(value / 1000)
      : Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return toTimestampSec(numeric);
    const d = new Date(trimmed);
    const t = d.getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  return null;
}

async function fetchChatsFromDb({
  sessionId,
  selfJid,
  limit = 10,
  offset = 0,
  hasMedia = false,
  sortBy = "lastMessage",
  sortOrder = "desc",
  search = "",
}) {
  if (!sessionId) return { total: 0, items: [] };
  try {
    const dir =
      String(sortOrder || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const sortCol =
      sortBy === "id"
        ? "sync_chats.jid"
        : sortBy === "name"
        ? "display_name"
        : "sync_chats.last_message_ts";
    const base = db("sync_chats")
      .leftJoin("sync_contacts", function () {
        this.on("sync_contacts.session_id", "sync_chats.session_id").andOn(
          "sync_contacts.jid",
          "sync_chats.jid"
        );
      })
      .where({ "sync_chats.session_id": sessionId })
      .whereExists(
        db
          .select(1)
          .from("sync_messages")
          .whereRaw("sync_messages.session_id = sync_chats.session_id")
          .andWhereRaw("sync_messages.chat_jid = sync_chats.jid")
      )
      .select(
        "sync_chats.*",
        db.raw(
          "COALESCE(sync_contacts.verified_name, sync_contacts.name, sync_contacts.notify, sync_chats.name) as display_name"
        )
      );
    if (selfJid) base.andWhere("sync_chats.jid", "!=", selfJid);
    const q = String(search || "").trim();
    if (q) {
      base.andWhere((b) => {
        b.where("sync_chats.jid", "like", `%${q}%`)
          .orWhere("display_name", "like", `%${q}%`)
          .orWhere("sync_chats.name", "like", `%${q}%`);
      });
    }
    if (parseBoolean(hasMedia, false)) {
      base.whereExists(
        db
          .select(1)
          .from("sync_messages")
          .whereRaw("sync_messages.session_id = sync_chats.session_id")
          .andWhereRaw("sync_messages.chat_jid = sync_chats.jid")
          .andWhereIn("message_type", DB_MEDIA_TYPES)
      );
    }
    const totalRow = await base.clone().count({ c: "*" }).first();
    const items = await base
      .clone()
      .orderBy(sortCol, dir)
      .offset(offset)
      .limit(limit);
    return { total: Number(totalRow?.c || 0), items };
  } catch (err) {
    logger.warn({ err: err?.message }, "chats.fetchChatsFromDb failed");
    return { total: 0, items: [] };
  }
}

async function fetchMessagesFromDb({
  sessionId,
  chatId,
  limit = 20,
  offset = 0,
  startTime,
  endTime,
  mediaOnly = false,
  isFromMe,
  search = "",
}) {
  if (!sessionId || !chatId) return { total: 0, items: [] };
  try {
    const q = db("sync_messages").where({
      session_id: sessionId,
      chat_jid: chatId,
    });
    const startTs = toTimestampSec(startTime);
    if (startTs) q.andWhere("timestamp_sec", ">=", startTs);
    const endTs = toTimestampSec(endTime);
    if (endTs) q.andWhere("timestamp_sec", "<=", endTs);
    if (parseBoolean(mediaOnly, false))
      q.andWhereIn("message_type", DB_MEDIA_TYPES);
    if (typeof isFromMe === "boolean") q.andWhere("from_me", isFromMe);
    const qSearch = String(search || "").trim();
    if (qSearch) q.andWhere("body", "like", `%${qSearch}%`);
    const totalRow = await q.clone().count({ c: "*" }).first();
    const items = await q
      .clone()
      .orderBy("timestamp_sec", "desc")
      .offset(offset)
      .limit(limit);
    return { total: Number(totalRow?.c || 0), items };
  } catch (err) {
    logger.warn({ err: err?.message }, "chats.fetchMessagesFromDb failed");
    return { total: 0, items: [] };
  }
}

async function fetchChatInfoFromDb(sessionId, jid) {
  if (!sessionId || !jid) return null;
  try {
    const row = await db("sync_chats")
      .leftJoin("sync_contacts", function () {
        this.on("sync_contacts.session_id", "sync_chats.session_id").andOn(
          "sync_contacts.jid",
          "sync_chats.jid"
        );
      })
      .select(
        "sync_chats.*",
        db.raw(
          "COALESCE(sync_contacts.verified_name, sync_contacts.name, sync_contacts.notify, sync_chats.name) as display_name"
        )
      )
      .where({ "sync_chats.session_id": sessionId, "sync_chats.jid": jid })
      .first();
    if (!row) return null;
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
  } catch (err) {
    logger.warn({ err: err?.message }, "chats.fetchChatInfoFromDb failed");
    return null;
  }
}

router.get(["/"], async (req, res) => {
  try {
    const sessionId = readInput(req, ["sessionId", "session", "id"]);
    const phone = readInput(req, ["phone"]);
    const limit = readInput(req, ["limit"]);
    const offset = readInput(req, ["offset"]);
    const hasMedia = readInput(req, ["hasMedia"]);
    const sortBy = readInput(req, ["sortBy"]);
    const sortOrder = readInput(req, ["sortOrder"]);
    const search = readInput(req, ["search"]);
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        result: null,
      });

    const lim = clampNumber(limit ?? 10, 1, 500, 10);
    const off = clampNumber(offset ?? 0, 0, 1_000_000, 0);
    const store = s.store;
    const selfJid = s?.me?.id || null;
    let q = null;
    if (typeof store?.getChats === "function") {
      try {
        q = await store.getChats({
          limit: lim,
          offset: off,
          hasMedia: parseBoolean(hasMedia, false),
          sortBy: sortBy || "lastMessage",
          sortOrder: sortOrder || "desc",
          search: search || "",
        });
      } catch (err) {
        logger.warn(
          { err: err?.message },
          "store.getChats failed, fallback to DB"
        );
      }
    }
    if (!q || !Array.isArray(q?.items)) {
      q = await fetchChatsFromDb({
        sessionId: s.id,
        selfJid,
        limit: lim,
        offset: off,
        hasMedia: parseBoolean(hasMedia, false),
        sortBy: sortBy || "lastMessage",
        sortOrder: sortOrder || "desc",
        search: search || "",
      });
    }

    const rows = (q.items || []).filter((c) => !selfJid || c.jid !== selfJid);
    const data = rows.map((c) => ({
      id: c.jid,
      jid: c.jid,
      displayName:
        c.display_name ||
        c.name ||
        lookupDisplayNameFromSock(s, c.jid) ||
        deriveNameFromJid(c.jid, null),
      name:
        c.display_name ||
        c.name ||
        lookupDisplayNameFromSock(s, c.jid) ||
        deriveNameFromJid(c.jid, null),
      isGroup: !!c.is_group,
      unreadCount: Number(c.unread_count || 0),
      lastMessage: c.last_message || null,
      lastMessageTimestamp: Number(c.last_message_ts || 0),
      ephemeralExpiry: Number(c.ephemeral_expiry || 0) || 0,
      createdAt: Number(c.created_at_sec || 0) || 0,
      updatedAt:
        Number(
          c.updated_at_sec || c.last_message_ts || c.created_at_sec || 0
        ) || 0,
    }));

    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Chats list fetched",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        data,
        pagination: { limit: lim, offset: off, total: q.total || 0 },
      },
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "chats.list error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      result: null,
    });
  }
});

router.get(["/:chatId/messages"], async (req, res) => {
  try {
    const sessionId = readInput(req, ["sessionId", "session", "id"]);
    const phone = readInput(req, ["phone"]);
    const limit = readInput(req, ["limit"]);
    const offset = readInput(req, ["offset"]);
    const startTime = readInput(req, ["startTime"]);
    const endTime = readInput(req, ["endTime"]);
    const mediaOnly = readInput(req, ["mediaOnly"]);
    const isFromMe = readInput(req, ["isFromMe"]);
    const search = readInput(req, ["search"]);
    const chatIdRaw = readInput(req, ["chatId"]);
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        result: null,
      });
    const chatId = jidify(chatIdRaw);
    if (!chatId)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing chatId",
        result: null,
      });

    const lim = clampNumber(limit ?? 20, 1, 500, 20);
    const off = clampNumber(offset ?? 0, 0, 1_000_000, 0);
    const mediaOnlyB = parseBoolean(mediaOnly, false);
    const isFromMeB = typeof isFromMe === "boolean" ? isFromMe : undefined;
    const store = s.store;
    const opts = {
      limit: lim,
      offset: off,
      startTime,
      endTime,
      mediaOnly: mediaOnlyB,
      isFromMe: mediaOnlyB ? undefined : isFromMeB,
      search: search || "",
    };
    let q = null;
    if (typeof store?.getMessages === "function") {
      try {
        q = await store.getMessages(chatId, opts);
      } catch (err) {
        logger.warn(
          { err: err?.message },
          "store.getMessages failed, fallback to DB"
        );
      }
    }
    if (!q || !Array.isArray(q?.items)) {
      q = await fetchMessagesFromDb({
        sessionId: s.id,
        chatId,
        ...opts,
      });
    }

    const items = (q.items || []).map((row) => {
      const raw = safeJsonParse(row.raw, null);
      const msg = raw?.message || {};
      const meta =
        raw && raw.meta && typeof raw.meta === "object" ? raw.meta : {};
      let mediaMeta = null;
      const ctype = getContentType(msg || {});
      const node = msg?.[ctype] || {};
      if (NODE_MEDIA_TYPES.includes(ctype)) {
        mediaMeta = {
          url: node?.url || null,
          mimeType: node?.mimetype || null,
          fileName: node?.fileName || null,
          fileSize: Number(node?.fileLength || 0) || null,
        };
      }
      const ctx = extractContextInfoFromMessage(msg) || {};
      let mentioned = [];
      if (Array.isArray(ctx?.mentionedJid))
        mentioned = ctx.mentionedJid.map((jid) => String(jid || ""));
      if (Array.isArray(meta?.mentions))
        mentioned = mentioned.concat(
          meta.mentions.map((jid) => String(jid || ""))
        );
      mentioned = Array.from(
        new Set(mentioned.map((jid) => jid.trim()).filter(Boolean))
      );
      const quotedId =
        ctx?.stanzaId ||
        ctx?.quotedMessageId ||
        meta?.quotedMessageId ||
        raw?.quotedMessageId ||
        null;

      const canonicalType = String(row.message_type || "text").toLowerCase();
      const isMedia = DB_MEDIA_TYPES.includes(canonicalType);
      const reactionsList = buildReactions(meta);
      const pollSummary = buildPollSummary(raw, meta);
      const editDetails = buildEditDetails(raw);
      const deletedAt = toTimestampSec(raw?.deletedAt);
      const receipts = Array.isArray(raw?.receipts) ? raw.receipts : null;
      const starredAt = toTimestampSec(meta?.starredAt);
      const messageDetails =
        cleanupDetails({
          edit: editDetails,
          poll: pollSummary,
          receipts,
          starredAt,
          deletedAt,
        }) || {};
      const isEdited = !!(
        editDetails &&
        (editDetails.lastEditedAt ||
          (editDetails.events && editDetails.events.length) ||
          editDetails.preview)
      );

      return {
        id: row.id,
        toJid: row.to_jid || chatId,
        senderJid: row.sender_jid || chatId,
        fromMe: !!row.from_me,
        messageType: canonicalType || "text",
        body: row.body || "",
        timestamp: Number(row.timestamp_sec || 0),
        isMedia,
        mediaType: isMedia ? canonicalType : null,
        mediaMetadata: isMedia ? mediaMeta : null,
        messageTypeDetails: messageDetails,
        quotedMessageId: quotedId,
        mentionedJids: mentioned,
        reactions: reactionsList,
        isEdited,
        isDeleted: !!deletedAt,
        deletedAt: deletedAt || null,
        poll: pollSummary,
        createdAt: Number(row.timestamp_sec || 0),
        updatedAt: Number(row.updated_at_sec || row.timestamp_sec || 0),
      };
    });

    let cinfo = null;
    if (typeof store?.getChatInfo === "function") {
      try {
        cinfo = await store.getChatInfo(chatId);
      } catch (err) {
        logger.warn(
          { err: err?.message },
          "store.getChatInfo failed, fallback to DB"
        );
      }
    }
    if (!cinfo) {
      cinfo = (await fetchChatInfoFromDb(s.id, chatId)) || {
        jid: chatId,
        name: null,
        lastMessage: null,
        isGroup: chatId.endsWith("@g.us"),
        unreadCount: 0,
        lastMessageTimestamp: 0,
        ephemeralExpiry: 0,
        createdAt: 0,
        updatedAt: 0,
      };
    }

    return res.status(200).json({
      status: true,
      code: 1000,
      message: "Messages list fetched",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        data: items,
        pagination: { limit: lim, offset: off, total: q.total || 0 },
        chatInfo: {
          jid: cinfo.jid || chatId,
          name: cinfo.name || null,
          lastMessage: cinfo.lastMessage || null,
          isGroup: !!cinfo.isGroup,
          unreadCount: Number(cinfo.unreadCount || 0),
          lastMessageTimestamp: Number(cinfo.lastMessageTimestamp || 0) || 0,
          ephemeralExpiry: Number(cinfo.ephemeralExpiry || 0) || 0,
          createdAt: Number(cinfo.createdAt || 0) || 0,
          updatedAt:
            Number(cinfo.updatedAt || cinfo.lastMessageTimestamp || 0) || 0,
        },
      },
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "chats.messages error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      result: null,
    });
  }
});

router.post(["/:chatId/read"], async (req, res) => {
  try {
    const { sessionId, phone } = req.body || {};
    const chatIdRaw = req.params?.chatId || req.body?.chatId;

    const s = await resolveSession({ sessionId, phone });
    if (!s) {
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        result: null,
      });
    }

    const chatId = jidify(chatIdRaw);
    if (!chatId) {
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing chatId",
        result: null,
      });
    }

    const rawMessages = Number.isFinite(+req.body?.messages)
      ? Number(req.body.messages)
      : 0;
    const rawDays = Number.isFinite(+req.body?.days)
      ? Number(req.body.days)
      : 1;

    const messageCount = clampNumber(rawMessages, 0, MAX_MARK_READ_BATCH, 0); // 0 = infinity
    const daysCount = clampNumber(rawDays, 0, MAX_MARK_READ_DAYS, 1);

    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffTs =
      messageCount === 0 && daysCount > 0
        ? Math.max(0, nowSec - daysCount * SECONDS_IN_DAY)
        : null;

    let baseQ = db("sync_messages")
      .select("id", "from_me", "sender_jid", "timestamp_sec")
      .where({ session_id: s.id, chat_jid: chatId })
      .andWhere("from_me", false);

    if (cutoffTs) baseQ = baseQ.andWhere("timestamp_sec", ">=", cutoffTs);

    const HARD_CAP = Math.max(MAX_MARK_READ_BATCH * 20, 1000);
    const isGroupChat = chatId.endsWith("@g.us");
    let rows = [];

    if (messageCount > 0) {
      rows = await baseQ.orderBy("timestamp_sec", "desc").limit(messageCount);
    } else {
      rows = await baseQ.orderBy("timestamp_sec", "desc").limit(HARD_CAP);
    }

    if (!rows.length) {
      return res.status(404).json({
        status: false,
        code: 2004,
        message: "No inbound messages available to mark as read",
        result: null,
      });
    }

    const lastMessages = rows
      .map((row) => {
        const id = String(row.id || "").trim();
        if (!id) return null;
        const ts = Number(row.timestamp_sec || 0) || nowSec;
        const keyBase = {
          id,
          remoteJid: chatId,
          fromMe: false,
        };
        if (isGroupChat && row.sender_jid) {
          keyBase.participant = String(row.sender_jid);
        }
        return {
          key: keyBase,
          messageTimestamp: ts,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const at = Number(a.messageTimestamp || 0);
        const bt = Number(b.messageTimestamp || 0);
        return at - bt;
      });

    if (!lastMessages.length) {
      return res.status(404).json({
        status: false,
        code: 2004,
        message: "Unable to build message list to mark as read",
        result: null,
      });
    }

    function inferKey(s, jid, item) {
      const messageId = item?.key?.id;
      const cached = getCachedMessage(s?.id, messageId);
      const base = (cached?.key && {
        ...cached.key,
        id: messageId,
        remoteJid: jid,
      }) || { ...item.key };

      base.fromMe = false;

      if (isGroupChat && item?.key?.participant) {
        base.participant = item.key.participant;
      } else if (isGroupChat && !base.participant) {
        const srcRow = rows.find((r) => String(r.id) === String(messageId));
        if (srcRow?.sender_jid) base.participant = String(srcRow.sender_jid);
      }

      return base;
    }

    const dedup = new Set();
    const keysAsc = lastMessages
      .map((m) => {
        const k = inferKey(s, chatId, m);
        if (!k?.id) return null;
        if (dedup.has(k.id)) return null;
        dedup.add(k.id);
        return k;
      })
      .filter(Boolean);

    if (!keysAsc.length) {
      return res.status(404).json({
        status: false,
        code: 2004,
        message: "No valid keys to mark as read",
        result: null,
      });
    }

    const CHUNK_SIZE = 50;
    await s.queue.push(async () => {
      for (let i = 0; i < keysAsc.length; i += CHUNK_SIZE) {
        const chunk = keysAsc.slice(i, i + CHUNK_SIZE);
        await s.sock.readMessages(chunk);
      }
    });

    const marked = lastMessages.map((item) => ({
      id: item.key.id,
      fromMe: false,
      timestamp: Number(item.messageTimestamp || 0),
    }));

    return res.status(200).json({
      status: true,
      code: 1000,
      message:
        messageCount > 0
          ? `Marked last ${keysAsc.length} inbound message(s) as read`
          : `Marked inbound messages as read in the last ${daysCount} day(s)`,
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        chatId,
        totalMarked: keysAsc.length,
        mode: messageCount > 0 ? "by_messages" : "by_days",
        parameters: {
          messages: messageCount,
          days: daysCount,
        },
        marked,
        partial:
          messageCount === 0 && rows.length >= HARD_CAP
            ? { capped: true, cap: HARD_CAP }
            : undefined,
      },
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "chats.read error");
    return res.status(500).json({
      status: false,
      code: 8000,
      message: "Internal server error",
      result: null,
    });
  }
});

router.post(["/:chatId/pin"], async (req, res) => {
  try {
    const { sessionId, phone, pin } = req.body || {};
    const chatIdRaw = req.params?.chatId || req.body?.chatId;
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        result: null,
      });
    const chatId = jidify(chatIdRaw);
    if (!chatId || pin == null)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing chatId or pin flag",
        result: null,
      });
    const pinBool = parseBoolean(pin, false);

    await s.queue.push(async () =>
      s.sock.chatModify({ pin: !!pinBool }, chatId)
    );
    return res.status(200).json({
      status: true,
      code: 1000,
      message: pinBool ? "Chat pinned" : "Chat unpinned",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        chatId,
        pinned: pinBool,
        message: pinBool
          ? "Chat pinned successfully"
          : "Chat unpinned successfully",
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "chats.pin error");
    return res.status(403).json({
      status: false,
      code: 4003,
      message: "Pin/unpin not allowed",
      result: null,
    });
  }
});

router.post(["/:chatId/messages/:messageId/pin"], async (req, res) => {
  try {
    const { sessionId, phone, pin } = req.body || {};
    const chatIdRaw = req.params?.chatId || req.body?.chatId;
    const messageId = req.params?.messageId || req.body?.messageId;
    const s = await resolveSession({ sessionId, phone });
    if (!s)
      return res.status(404).json({
        status: false,
        code: 1101,
        message: "Session not found",
        result: null,
      });
    const chatId = jidify(chatIdRaw);
    if (!chatId || !messageId || pin == null)
      return res.status(400).json({
        status: false,
        code: 2001,
        message: "Missing chatId, messageId or pin flag",
        result: null,
      });
    const pinBool = parseBoolean(pin, false);

    const cached = getCachedMessage(s.id, messageId);
    const key = cached?.key || {
      id: messageId,
      remoteJid: chatId,
      fromMe: cached?.key?.fromMe ?? false,
    };
    const type = pinBool ? 1 : 2;
    await s.queue.push(async () =>
      s.sock.sendMessage(chatId, {
        pin: { id: key.id, fromMe: !!key.fromMe, remoteJid: chatId },
        type,
      })
    );

    return res.status(200).json({
      status: true,
      code: 1000,
      message: pinBool ? "Message pinned" : "Message unpinned",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        chatId,
        messageId: key.id,
        pinned: !!pinBool,
        message: pinBool
          ? "Message pinned successfully"
          : "Message unpinned successfully",
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  } catch (e) {
    logger.warn({ err: e?.message }, "chats.msg.pin error");
    return res.status(403).json({
      status: false,
      code: 4003,
      message: "Pin/unpin not allowed",
      result: null,
    });
  }
});

export default router;
