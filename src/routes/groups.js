import express from "express";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

import { apiKeyAuth } from "../middleware/auth.js";
import { dynamicRateLimit } from "../middleware/ratelimit.js";
import { send } from "../utils/code.js";

import { getSession, listSessions } from "../whatsapp/baileysClient.js";
import { getSessionMeta } from "../whatsapp/sessionRegistry.js";
import { fetchAllGroupsSafe } from "../whatsapp/profile.js";

const router = express.Router();

router.use(apiKeyAuth("user"), dynamicRateLimit());

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;
const isValidId = (v) => SAFE_ID_REGEX.test(String(v || ""));
const normStr = (v) => (typeof v === "string" ? v.trim() : "");
const normId = (v) => normStr(v);
const toDigits = (v) => String(v || "").replace(/\D+/g, "");
const isValidLid = (v) => typeof v === "string" && /@lid$/i.test(v.trim());
const parseBoolean = (v, def = false) => {
  if (typeof v === "boolean") return v;
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
};

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

function ensureGroupJid(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.includes("@")) return /@g\.us$/i.test(s) ? s : "";
  return `${s}@g.us`;
}

function mePhoneOf(s) {
  try {
    const raw = String(s?.me?.id || s?.user?.id || "");
    const local = raw.split("@")[0] || "";
    const noDevice = local.split(":")[0] || local;
    const digits = noDevice.replace(/\D+/g, "");
    return digits || null;
  } catch {
    return null;
  }
}

function getContactsContainer(sock) {
  try {
    return sock?.store?.contacts || sock?.contacts || null;
  } catch {
    return null;
  }
}

function toSWhatsAppUserJid(idOrPhone) {
  const s = String(idOrPhone || "").trim();
  if (!s) return null;
  if (!s.includes("@")) {
    const d = toDigits(s);
    return d ? `${d}@s.whatsapp.net` : null;
  }
  const lower = s.toLowerCase();
  if (lower.endsWith("@s.whatsapp.net"))
    return s.replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
  if (lower.endsWith("@c.us"))
    return s
      .replace(/@c\.us$/i, "@s.whatsapp.net")
      .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
  if (lower.endsWith("@g.us")) return null;
  if (lower.endsWith("@lid")) return null;
  return null;
}

function buildLidJidMaps(sock) {
  const mapLidToJid = new Map();
  const mapJidToLid = new Map();
  try {
    const src = getContactsContainer(sock);
    const iter =
      src instanceof Map
        ? [...src.values()]
        : src && typeof src === "object"
        ? Object.values(src)
        : [];
    for (const c of iter) {
      const lid = String(c?.lid || "").trim();
      const id = c?.id || c?.jid || null;
      const jid = toSWhatsAppUserJid(id);
      if (isValidLid(lid) && jid) {
        if (!mapLidToJid.has(lid)) mapLidToJid.set(lid, jid);
        if (!mapJidToLid.has(jid)) mapJidToLid.set(jid, lid);
      }
    }
  } catch {}
  return { mapLidToJid, mapJidToLid };
}

function findJidByLid(sock, lid, maps) {
  const lidStr = String(lid || "").trim();
  if (!isValidLid(lidStr)) return null;
  if (maps?.mapLidToJid?.has(lidStr)) return maps.mapLidToJid.get(lidStr);
  try {
    const src = getContactsContainer(sock);
    const iter =
      src instanceof Map
        ? [...src.values()]
        : src && typeof src === "object"
        ? Object.values(src)
        : [];
    for (const c of iter) {
      const cLid = String(c?.lid || "").trim();
      if (isValidLid(cLid) && cLid === lidStr) {
        const id = c?.id || c?.jid || null;
        const j = toSWhatsAppUserJid(id);
        if (j) return j;
      }
    }
  } catch {}
  return null;
}

function findLidByJid(sock, jid, maps) {
  const j = toSWhatsAppUserJid(jid);
  if (!j) return null;
  if (maps?.mapJidToLid?.has(j)) return maps.mapJidToLid.get(j);
  try {
    const src = getContactsContainer(sock);
    const iter =
      src instanceof Map
        ? [...src.values()]
        : src && typeof src === "object"
        ? Object.values(src)
        : [];
    for (const c of iter) {
      const id = c?.id || c?.jid || null;
      const norm = toSWhatsAppUserJid(id);
      if (norm && norm === j) {
        const lid = String(c?.lid || "").trim();
        if (isValidLid(lid)) return lid;
      }
    }
  } catch {}
  return null;
}

async function withQueue(session, fn) {
  return await fn();
}

async function resolveJidFromAny(s, any, maps) {
  const raw = String(any || "").trim();
  if (!raw) return null;

  if (!raw.includes("@")) {
    const d = toDigits(raw);
    return d ? `${d}@s.whatsapp.net` : null;
  }

  const lower = raw.toLowerCase();
  if (lower.endsWith("@s.whatsapp.net"))
    return raw.replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
  if (lower.endsWith("@c.us"))
    return raw
      .replace(/@c\.us$/i, "@s.whatsapp.net")
      .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
  if (lower.endsWith("@lid")) {
    const viaContacts = findJidByLid(s.sock, raw, maps);
    if (viaContacts) return viaContacts;

    const d = toDigits(raw.split("@")[0]);
    if (d) {
      try {
        const check = await withQueue(s, async () =>
          s.sock.onWhatsApp(`${d}@s.whatsapp.net`)
        );
        const first = Array.isArray(check) ? check[0] : check;
        if (first?.jid && (first.exists || first.isIn || first.isOnWhatsApp)) {
          return String(first.jid)
            .replace(/@c\.us$/i, "@s.whatsapp.net")
            .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
        }
      } catch {}
    }
    return null;
  }
  return null;
}

async function resolveSessionByParam(req) {
  const sessionId = normId(
    readAnyStr(req, ["sessionId", "sessionid", "id", "session"]) || ""
  );
  const phoneRaw = normId(
    readAnyStr(req, ["phone", "number", "user", "msisdn", "phonenumber"]) || ""
  );
  const phoneDigits = toDigits(phoneRaw);
  const ownerId = req?.auth?.ownerId;

  if (sessionId) {
    if (!isValidId(sessionId)) {
      return {
        error: (res) =>
          send(res, "INVALID_PARAMETER", {
            message: "sessionId is invalid",
            result: null,
          }),
      };
    }
    const meta = getSessionMeta(sessionId);
    if (!meta) {
      return {
        error: (res) =>
          send(res, "SESSION_NOT_FOUND", {
            message: "Session not found",
            result: null,
          }),
      };
    }
    if (meta.ownerId !== ownerId) {
      return {
        error: (res) =>
          send(res, "FORBIDDEN", { message: "Forbidden", result: null }),
      };
    }
    const s = getSession(sessionId);
    if (!s || s.status !== "open") {
      return {
        error: (res) =>
          send(res, "SESSION_NOT_LOGGED_IN", {
            message: "Login required (scan QR or pairing)",
            result: null,
          }),
      };
    }
    return { session: s, sessionId, phoneDigits };
  }

  if (phoneDigits) {
    const items = await listSessions();
    for (const it of items) {
      if (it.status !== "open") continue;
      const s = getSession(it.id);
      const me = String(s?.me?.id || s?.user?.id || "");
      const local = me.split("@")[0] || "";
      const base = local.split(":")[0] || local;
      const meDigits = base.replace(/\D+/g, "");
      if (meDigits && meDigits === phoneDigits) {
        const meta = getSessionMeta(it.id);
        if (!meta || meta.ownerId !== ownerId) break;
        return { session: s, sessionId: it.id, phoneDigits };
      }
    }
  }
  return {
    error: (res) =>
      send(res, "SESSION_NOT_FOUND", {
        message: "Session not found",
        result: null,
      }),
  };
}

function extractInviteCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const m = raw.match(/[A-Za-z0-9]{10,}/);
  return m ? m[0] : "";
}

async function loadImageBufferFromInput(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  try {
    if (s.startsWith("data:image/")) {
      const base64 = s.split(",")[1] || "";
      return base64 ? Buffer.from(base64, "base64") : null;
    }
    if (/^https?:\/\//i.test(s)) {
      const resp = await axios.get(s, { responseType: "arraybuffer" });
      return resp?.data ? Buffer.from(resp.data) : null;
    }
    const p = path.resolve(process.cwd(), s);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch {}
  return null;
}

async function applyParticipantsUpdate(
  s,
  groupJid,
  numbersOrJids,
  action,
  maps
) {
  const raw = Array.isArray(numbersOrJids) ? numbersOrJids : [];

  const dedup = new Set();
  const resolved = [];
  const invalid = [];

  for (const val of raw) {
    const sVal = String(val || "").trim();
    if (!sVal) continue;

    const j = await resolveJidFromAny(s, sVal, maps);
    if (!j || !/@s\.whatsapp\.net$/i.test(j)) {
      invalid.push(toDigits(sVal) || sVal);
      continue;
    }
    const jidNorm = j.replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
    if (!dedup.has(jidNorm)) {
      dedup.add(jidNorm);
      resolved.push(jidNorm);
    }
  }

  let currentByJid = null;
  if (action !== "add") {
    try {
      const meta = await withQueue(s, async () =>
        s.sock.groupMetadata(groupJid)
      );
      const arr = Array.isArray(meta?.participants) ? meta.participants : [];
      currentByJid = new Map(
        arr.map((p) => {
          const rid = String(p?.jid || p?.id || "")
            .trim()
            .replace(/@c\.us$/i, "@s.whatsapp.net")
            .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
          const role = p?.role || p?.admin;
          const isSuper = role === "superadmin" || role === "super-admin";
          const isAdmin = isSuper || role === "admin" || p?.isAdmin === true;
          return [rid, { isAdmin, isSuper }];
        })
      );
    } catch {
      currentByJid = new Map();
    }
  }
  const toProcess = [];
  const notInGroup = [];
  const notPermitted = [];

  for (const jid of resolved) {
    if (action === "add") {
      toProcess.push(jid);
      continue;
    }
    if (!currentByJid?.has(jid)) {
      notInGroup.push(jid.split("@")[0]);
      continue;
    }
    if (action === "demote") {
      const info = currentByJid.get(jid);
      if (info?.isSuper) {
        notPermitted.push(jid.split("@")[0]);
        continue;
      }
    }
    if (action === "promote") {
      const info = currentByJid.get(jid);
      if (info?.isSuper) {
        notPermitted.push(jid.split("@")[0]);
        continue;
      }
    }

    toProcess.push(jid);
  }
  const ok = [];
  const bad = [];

  for (const j of toProcess) {
    try {
      await withQueue(s, async () =>
        s.sock.groupParticipantsUpdate(groupJid, [j], action)
      );
      ok.push(j.split("@")[0]);
    } catch {
      bad.push(j.split("@")[0]);
    }
  }
  return { ok, bad, invalid, notInGroup, notPermitted };
}

router.get(["/groups"], async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;

    const meta = await withQueue(s, async () => fetchAllGroupsSafe(s.sock));
    const data = (meta || []).map((g) => {
      const { participants, size, ...metaGroup } = g || {};
      return {
        ...metaGroup,
        participantsCount: Number(
          Array.isArray(g?.participants) ? g.participants.length : g?.size || 0
        ),
      };
    });

    return send(res, "SUCCESS", {
      message: "Groups list fetched",
      result: { sessionId: s.id, phone: mePhoneOf(s), data },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get(["/group/picture"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    let pictureUrl = null;
    try {
      const url = await withQueue(s, async () =>
        s.sock.profilePictureUrl(groupId, "image")
      );
      pictureUrl = url || null;
    } catch {}
    return send(res, "SUCCESS", {
      message: "Group picture",
      result: { sessionId: s.id, phone: mePhoneOf(s), groupId, pictureUrl },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/picture"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const rawPic = readAnyStr(req, ["picture", "image", "photo", "avatar"]);
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    if (!rawPic)
      return send(res, "MISSING_PARAMETER", {
        message: "picture is required",
        result: null,
      });

    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;

    const buf = await loadImageBufferFromInput(rawPic);
    if (!buf)
      return send(res, "INVALID_PARAMETER", {
        message: "picture is invalid or unreadable",
        result: null,
      });

    try {
      await withQueue(s, async () => s.sock.updateProfilePicture(groupId, buf));
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to update group picture",
        result: null,
      });
    }

    let pictureUrl = null;
    try {
      const url = await withQueue(s, async () =>
        s.sock.profilePictureUrl(groupId, "image")
      );
      pictureUrl = url || null;
    } catch {}
    return send(res, "SUCCESS", {
      message: "Group picture updated",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        pictureUrl,
        status: "success update group picture",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.delete(["/group/picture"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    let status = "failed";
    try {
      await withQueue(s, async () => s.sock.removeProfilePicture(groupId));
      status = "success remove group picture";
    } catch {}
    return send(
      res,
      status.startsWith("success") ? "SUCCESS" : "PARTIAL_SUCCESS",
      {
        message: status.startsWith("success")
          ? "Group picture removed"
          : "Failed to remove group picture",
        result: { sessionId: s.id, phone: mePhoneOf(s), groupId, status },
      }
    );
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/name"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const groupName =
      normStr(readAnyStr(req, ["groupName", "name", "subject"])) || "";
    if (!groupId || !groupName)
      return send(res, "MISSING_PARAMETER", {
        message: !groupId ? "groupId" : "groupName" + " is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;

    try {
      await withQueue(s, async () =>
        s.sock.groupUpdateSubject(groupId, groupName)
      );
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to update group name",
        result: null,
      });
    }

    return send(res, "SUCCESS", {
      message: "Group name updated",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        groupName,
        status: "success update group name",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/description"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const groupDescription =
      normStr(readAnyStr(req, ["groupDescription", "description", "desc"])) ||
      "";
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;

    try {
      await withQueue(s, async () =>
        s.sock.groupUpdateDescription(groupId, groupDescription)
      );
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to update group description",
        result: null,
      });
    }

    return send(res, "SUCCESS", {
      message: "Group description updated",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        groupDescription,
        status: "success update group description",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/locked"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const locked = parseBoolean(
      readAnyStr(req, ["locked"]) || req.body?.locked,
      false
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const tag = locked ? "locked" : "unlocked";
    try {
      await withQueue(s, async () => s.sock.groupSettingUpdate(groupId, tag));
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to set locked",
        result: null,
      });
    }
    return send(res, "SUCCESS", {
      message: locked ? "Group locked" : "Group unlocked",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        status: locked ? "success locked group" : "success unlocked group",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/announcement"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const announcement = parseBoolean(
      readAnyStr(req, ["announcement"]) || req.body?.announcement,
      false
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const tag = announcement ? "announcement" : "not_announcement";
    try {
      await withQueue(s, async () => s.sock.groupSettingUpdate(groupId, tag));
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to set announcement",
        result: null,
      });
    }
    return send(res, "SUCCESS", {
      message: announcement
        ? "Announcement mode enabled"
        : "Announcement mode disabled",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        status: "success set announcement mode",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get(["/group/invite"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    let code = null;
    try {
      code = await withQueue(s, async () => s.sock.groupInviteCode(groupId));
    } catch {}
    const inviteLink = code ? `https://chat.whatsapp.com/${code}` : null;
    return send(res, "SUCCESS", {
      message: "Invite link fetched",
      result: { sessionId: s.id, phone: mePhoneOf(s), groupId, inviteLink },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/invite/revoke"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    let code = null;
    try {
      code = await withQueue(s, async () => s.sock.groupRevokeInvite(groupId));
    } catch {}
    const inviteLink = code ? `https://chat.whatsapp.com/${code}` : null;
    return send(res, "SUCCESS", {
      message: "Invite link revoked",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        inviteLink,
        status: inviteLink ? "success revoke invite link" : "failed",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/join-via-link"], async (req, res) => {
  try {
    const inviteLink =
      normStr(readAnyStr(req, ["inviteLink", "link", "code"])) || "";
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const code = extractInviteCode(inviteLink);
    if (!code)
      return send(res, "MISSING_PARAMETER", {
        message: "inviteLink is required",
        result: null,
      });
    let groupId = null;
    try {
      groupId = await withQueue(s, async () => s.sock.groupAcceptInvite(code));
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to join via link",
        result: null,
      });
    }
    return send(res, "SUCCESS", {
      message: "Joined group via link",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        status: groupId ? "success joined group" : "pending approval to join",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get(["/group/join-via-link"], async (req, res) => {
  try {
    const inviteLink =
      normStr(readAnyStr(req, ["inviteLink", "link", "code"])) || "";
    const code = extractInviteCode(inviteLink);
    if (!code)
      return send(res, "MISSING_PARAMETER", {
        message: "inviteLink is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    let info = null;
    try {
      info = await withQueue(s, async () => s.sock.groupGetInviteInfo(code));
    } catch {}
    const participants = Array.isArray(info?.participants)
      ? info.participants
      : [];
    const result = {
      sessionId: s.id,
      phone: mePhoneOf(s),
      groupId: info?.id || null,
      groupName: info?.subject || null,
      groupDescription: info?.desc || null,
      participantsCount: Number(participants?.length || info?.size || 0),
      isGroupLocked: !!(info?.locked || info?.restrict),
      isAnnouncement: !!(info?.announce || info?.announcement),
      isEphemeral: Number(info?.ephemeralDuration || info?.ephemeral || 0) > 0,
      inviteLink:
        inviteLink || (code ? `https://chat.whatsapp.com/${code}` : null),
    };
    try {
      const url = await withQueue(s, async () =>
        s.sock.profilePictureUrl(result.groupId, "image")
      );
      result.groupPicture = url || null;
    } catch {}
    return send(res, "SUCCESS", { message: "Invite info fetched", result });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get(["/group/participants/requests"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;

    let resp = null;
    try {
      resp = await withQueue(s, async () =>
        s.sock.groupRequestParticipantsList(groupId)
      );
    } catch {}
    const rows = Array.isArray(resp) ? resp : [];
    const joinRequests = await Promise.all(
      rows.map(async (r) => {
        return {
          jid: r.phone_number || null,
          lid: r.jid || null,
          phone: r.phone_number ? toDigits(r.phone_number.split("@")[0]) : null,
          requestMethod: r.request_method || null,
          requestTime: Number(r?.request_time || 0) || null,
        };
      })
    );

    return send(res, "SUCCESS", {
      message: "Join requests fetched",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        joinRequests,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/participants/request/approve"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const parts = Array.isArray(req.body?.participants)
      ? req.body.participants
      : [];
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    if (!parts.length)
      return send(res, "MISSING_PARAMETER", {
        message: "participants is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const maps = buildLidJidMaps(s.sock);

    const toJids = [];
    for (const x of parts) {
      const j = await resolveJidFromAny(s, x, maps);
      if (j && /@s\.whatsapp\.net$/i.test(j)) toJids.push(j);
    }
    const approved = [];
    const failed = [];
    for (const j of toJids) {
      try {
        await withQueue(s, async () =>
          s.sock.groupRequestParticipantsUpdate(groupId, [j], "approve")
        );
        approved.push(j.split("@")[0]);
      } catch {
        failed.push(j.split("@")[0]);
      }
    }
    const status = failed.length
      ? approved.length
        ? "partial"
        : "failed"
      : "success";
    return send(res, failed.length ? "PARTIAL_SUCCESS" : "SUCCESS", {
      message: failed.length
        ? "Some participants failed to approve"
        : "Participants approved",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        approvedParticipants: approved,
        failedToApprove: failed,
        status,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/participants/request/reject"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const parts = Array.isArray(req.body?.participants)
      ? req.body.participants
      : [];
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    if (!parts.length)
      return send(res, "MISSING_PARAMETER", {
        message: "participants is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const maps = buildLidJidMaps(s.sock);

    const toJids = [];
    for (const x of parts) {
      const j = await resolveJidFromAny(s, x, maps);
      if (j && /@s\.whatsapp\.net$/i.test(j)) toJids.push(j);
    }
    const participants = [];
    for (const j of toJids) {
      let ok = false;
      try {
        await withQueue(s, async () =>
          s.sock.groupRequestParticipantsUpdate(groupId, [j], "reject")
        );
        ok = true;
      } catch {}
      participants.push({
        phone: j.split("@")[0],
        status: ok ? "rejected" : "failed",
      });
    }
    const anyFail = participants.some((p) => p.status !== "rejected");
    return send(res, anyFail ? "PARTIAL_SUCCESS" : "SUCCESS", {
      message: anyFail
        ? "Some participants failed to reject"
        : "Participants rejected",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        participants,
        status: anyFail ? "partial" : "success",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/leave"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    let status = "failed";
    try {
      await withQueue(s, async () => s.sock.groupLeave(groupId));
      status = "success leave";
    } catch {}
    return send(
      res,
      status === "success leave" ? "SUCCESS" : "PARTIAL_SUCCESS",
      {
        message:
          status === "success leave" ? "Left group" : "Failed to leave group",
        result: { sessionId: s.id, phone: mePhoneOf(s), groupId, status },
      }
    );
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/create"], async (req, res) => {
  try {
    const groupName =
      normStr(readAnyStr(req, ["groupName", "name", "subject"])) || "";
    const arr = Array.isArray(req.body?.participants)
      ? req.body.participants
      : [];
    if (!groupName)
      return send(res, "MISSING_PARAMETER", {
        message: "groupName is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const maps = buildLidJidMaps(s.sock);

    const pJids = [];
    for (const x of arr) {
      const j = await resolveJidFromAny(s, String(x || ""), maps);
      if (j && /@s\.whatsapp\.net$/i.test(j)) pJids.push(j);
    }

    let resp = null;
    try {
      if (typeof s.sock.createGroup === "function") {
        resp = await withQueue(s, async () =>
          s.sock.createGroup(groupName, pJids)
        );
      } else {
        resp = await withQueue(s, async () =>
          s.sock.groupCreate(groupName, pJids)
        );
      }
    } catch (e) {
      return send(res, "INTERNAL_ERROR", {
        message: e?.message || "Failed to create group",
        result: null,
      });
    }
    const gid = resp?.id || resp?.gid || resp?.groupId || null;
    return send(res, "SUCCESS", {
      message: "Group created",
      result: { sessionId: s.id, phone: mePhoneOf(s), groupId: gid },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Failed to create group",
      result: null,
    });
  }
});

router.delete(["/group/delete"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });

    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;

    const meta = await withQueue(s, async () => s.sock.groupMetadata(groupId));
    const participants = Array.isArray(meta?.participants)
      ? meta.participants
      : [];

    const meJid = String(s?.me?.id || "")
      .trim()
      .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");

    const normMembers = participants.map((p) => {
      const role = p?.role || p?.admin;
      const isSuper = role === "superadmin" || role === "super-admin";
      const isAdm = isSuper || role === "admin" || p?.isAdmin === true;
      const rawId = String(p?.jid || p?.id || "").trim();
      const jid = rawId.replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
      return {
        jid: jid || null,
        isAdmin: !!isAdm,
        isSuperAdmin: !!isSuper,
        meJid,
        isSelf: jid === meJid,
      };
    });

    const amAdmin = normMembers.some(
      (m) => m.isSelf && (m.isAdmin || m.isSuperAdmin)
    );
    if (!amAdmin) {
      return send(res, "FORBIDDEN", {
        message: "Bot is not an admin in this group",
        result: {
          sessionId: s.id,
          phone: mePhoneOf(s),
          groupId,
          status: "not permitted",
          normMembers,
        },
      });
    }

    const others = normMembers
      .filter((m) => m.jid && !m.isSelf)
      .map((m) => m.jid);
    const removedParticipants = [];
    const failedToRemove = [];
    for (const j of others) {
      try {
        await withQueue(s, async () =>
          s.sock.groupParticipantsUpdate(groupId, [j], "remove")
        );
        removedParticipants.push(j.split("@")[0]);
      } catch {
        failedToRemove.push(j.split("@")[0]);
      }
    }

    try {
      await withQueue(s, async () => s.sock.groupRevokeInvite(groupId));
    } catch {}
    let leftOk = false;
    try {
      await withQueue(s, async () => s.sock.groupLeave(groupId));
      leftOk = true;
    } catch {}

    let status = "failed";
    if (failedToRemove.length)
      status = removedParticipants.length ? "partial" : "failed";
    else status = leftOk ? "success delete group" : "partial";

    return send(res, failedToRemove.length ? "PARTIAL_SUCCESS" : "SUCCESS", {
      message: failedToRemove.length
        ? "Some members failed to remove"
        : "Group disbanded",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        removedParticipants,
        failedToRemove,
        status,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get(["/group/participants"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;

    const meta = await withQueue(s, async () => s.sock.groupMetadata(groupId));
    const participants = Array.isArray(meta?.participants)
      ? meta.participants
      : [];
    const myJid = String(s?.me?.id || "")
      .trim()
      .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");

    const list = participants.map((p) => {
      const { admin, ...participant } = p || {};
      const pj = String(p?.jid || p?.id || "")
        .trim()
        .replace(/:\d+(?=@s\.whatsapp\.net$)/, "");
      return {
        ...participant,
        isMe: pj === myJid,
        isAdmin: !!admin,
        isSuperAdmin: admin === "superadmin",
      };
    });

    return send(res, "SUCCESS", {
      message: "Participants fetched",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        participants: list,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/participants/add"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const parts = Array.isArray(req.body?.participants)
      ? req.body.participants
      : [];
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    if (!parts.length)
      return send(res, "MISSING_PARAMETER", {
        message: "participants is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const maps = buildLidJidMaps(s.sock);

    const { ok, bad } = await applyParticipantsUpdate(
      s,
      groupId,
      parts,
      "add",
      maps
    );
    const status = bad.length ? (ok.length ? "partial" : "failed") : "success";
    return send(res, bad.length ? "PARTIAL_SUCCESS" : "SUCCESS", {
      message: bad.length
        ? "Some participants failed to add"
        : "Participants added",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        addedParticipants: ok,
        failedToAdd: bad,
        status,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.delete(["/group/participants/remove"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const parts = Array.isArray(req.body?.participants)
      ? req.body.participants
      : [];
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    if (!parts.length)
      return send(res, "MISSING_PARAMETER", {
        message: "participants is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const maps = buildLidJidMaps(s.sock);

    const { ok, bad } = await applyParticipantsUpdate(
      s,
      groupId,
      parts,
      "remove",
      maps
    );
    const status = bad.length ? (ok.length ? "partial" : "failed") : "success";
    return send(res, bad.length ? "PARTIAL_SUCCESS" : "SUCCESS", {
      message: bad.length
        ? "Some participants failed to remove"
        : "Participants removed",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        removedParticipants: ok,
        failedToRemove: bad,
        status,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/participants/promote"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const parts = Array.isArray(req.body?.participants)
      ? req.body.participants
      : [];
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    if (!parts.length)
      return send(res, "MISSING_PARAMETER", {
        message: "participants is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const maps = buildLidJidMaps(s.sock);

    const { ok, bad, notPermitted } = await applyParticipantsUpdate(
      s,
      groupId,
      parts,
      "promote",
      maps
    );
    const status = bad.length ? (ok.length ? "partial" : "failed") : "success";
    const participants = parts.map((p) => ({
      phone: toDigits(p),
      status: ok.includes(toDigits(p))
        ? "promoted"
        : notPermitted.includes(toDigits(p))
        ? "not permitted"
        : "failed",
    }));
    return send(res, bad.length ? "PARTIAL_SUCCESS" : "SUCCESS", {
      message: bad.length
        ? "Some participants failed to promote"
        : "Participants promoted",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        participants,
        status,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post(["/group/participants/demote"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    const parts = Array.isArray(req.body?.participants)
      ? req.body.participants
      : [];
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    if (!parts.length)
      return send(res, "MISSING_PARAMETER", {
        message: "participants is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const maps = buildLidJidMaps(s.sock);

    const { ok, bad, notPermitted } = await applyParticipantsUpdate(
      s,
      groupId,
      parts,
      "demote",
      maps
    );
    const status = bad.length ? (ok.length ? "partial" : "failed") : "success";
    const participants = parts.map((p) => ({
      phone: toDigits(p),
      status: ok.includes(toDigits(p))
        ? "demoted"
        : notPermitted.includes(toDigits(p))
        ? "not permitted"
        : "failed",
    }));
    return send(res, bad.length ? "PARTIAL_SUCCESS" : "SUCCESS", {
      message: bad.length
        ? "Some participants failed to demote"
        : "Participants demoted",
      result: {
        sessionId: s.id,
        phone: mePhoneOf(s),
        groupId,
        participants,
        status,
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get(["/group/info"], async (req, res) => {
  try {
    const groupId = ensureGroupJid(
      readAnyStr(req, ["groupId", "gid", "group"])
    );
    if (!groupId)
      return send(res, "MISSING_PARAMETER", {
        message: "groupId is required",
        result: null,
      });
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) return resolved.error(res);
    const { session: s } = resolved;
    const meta = await withQueue(s, async () => s.sock.groupMetadata(groupId));
    const { participants, size, ...metaData } = meta || {};
    const result = {
      sessionId: s.id,
      phone: mePhoneOf(s),
      data: {
        ...metaData,
        participantsCount: size,
      },
    };
    return send(res, "SUCCESS", { message: "Group info", result });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

export default router;
