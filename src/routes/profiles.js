import express from "express";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { apiKeyAuth } from "../middleware/auth.js";
import { dynamicRateLimit } from "../middleware/ratelimit.js";
import { send } from "../utils/code.js";
import { db } from "../database/index.js";
import { createCacheStore } from "../drivers/cache.js";
import {
  getSession,
  listSessions as listRuntimeSessions,
} from "../whatsapp/baileysClient.js";
import { getSessionMeta } from "../whatsapp/sessionRegistry.js";
import { jidDecode, jidEncode } from "@whiskeysockets/baileys";
import {
  getStatusText,
  getProfilePictures,
  getBusinessProfileSafe,
  getPrivacySettingsSafe,
  fetchAllGroupsSafe,
  listContactsFromGroupsSafe,
  fetchStatusForSession,
  invalidateProfilePicCacheFor,
} from "../whatsapp/profile.js";
import { jidFromPhoneNumber } from "../utils/phone.js";

const router = express.Router();

router.use(apiKeyAuth("user"), dynamicRateLimit());

const CONTACTS_CACHE_TTL_SECONDS = 60;
const contactsCache = createCacheStore({
  namespace: "profile:contacts",
  ttlSeconds: CONTACTS_CACHE_TTL_SECONDS,
});
const BUSINESS_PROFILE_BATCH = 5;
const BUSINESS_PROFILE_CACHE_TTL_SECONDS = 180;
const businessProfileCache = createCacheStore({
  namespace: "profile:business",
  ttlSeconds: BUSINESS_PROFILE_CACHE_TTL_SECONDS,
});

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;
const normId = (v) => String(v || "").trim();
const toDigits = (v) => String(v || "").replace(/\D+/g, "");
const isValidId = (v) => SAFE_ID_REGEX.test(v);

function getStrInsensitive(src, key) {
  try {
    if (!src || typeof src !== "object") return "";
    const want = String(key || "").toLowerCase();
    for (const [k, v] of Object.entries(src)) {
      if (
        typeof v === "string" &&
        k.toLowerCase() === want &&
        v.trim() !== ""
      ) {
        return v.trim();
      }
    }
  } catch {}
  return "";
}

function readAnyStr(req, keys = []) {
  for (const k of keys) {
    const v1 = getStrInsensitive(req.body, k);
    if (v1) return v1;
    const v2 = getStrInsensitive(req.query, k);
    if (v2) return v2;
    const v3 = getStrInsensitive(req.params, k);
    if (v3) return v3;
  }
  return "";
}

function jidFromPhone(phoneDigits) {
  return jidFromPhoneNumber(phoneDigits);
}

function extractPhoneDigitsFromJid(jid) {
  const raw = String(jid || "");
  const at = raw.indexOf("@");
  const user = at >= 0 ? raw.slice(0, at) : raw;
  const colonIdx = user.indexOf(":");
  const userOnly = colonIdx >= 0 ? user.slice(0, colonIdx) : user;
  return toDigits(userOnly);
}

function toSWhatsAppUserJid(jidOrPhoneLike) {
  const s = String(jidOrPhoneLike || "").trim();
  if (!s) return null;
  if (/@lid$/i.test(s)) return null;
  try {
    const dec = jidDecode(s);
    if (
      dec?.user &&
      (dec.server === "s.whatsapp.net" || dec.server === "c.us")
    ) {
      return jidEncode(dec.user, "s.whatsapp.net");
    }
  } catch {}
  if (!/@/.test(s)) {
    const digits = extractPhoneDigitsFromJid(s);
    return digits ? `${digits}@s.whatsapp.net` : null;
  }
  return null;
}

function chooseNormalizedUserJid(obj) {
  const candidates = [obj?.participant, obj?.jid, obj?.id, obj?.user];
  for (const c of candidates) {
    const norm = toSWhatsAppUserJid(c);
    if (norm && !norm.endsWith("@lid")) return norm;
  }
  return null;
}

function getContactsContainer(sock) {
  try {
    return sock?.store?.contacts || sock?.contacts || null;
  } catch {
    return null;
  }
}

function findJidByLid(sock, lid) {
  if (!lid) return null;
  try {
    const src = getContactsContainer(sock);
    if (!src) return null;
    const iter = Array.isArray(src)
      ? src
      : src instanceof Map
      ? [...src.values()]
      : typeof src === "object"
      ? Object.values(src)
      : [];
    for (const c of iter) {
      if (String(c?.lid || "").trim() === String(lid).trim()) {
        const id = c?.id || c?.jid || null;
        const norm = toSWhatsAppUserJid(id);
        if (norm) return norm;
      }
    }
  } catch {}
  return null;
}
function findLidByJid(sock, jid) {
  if (!jid) return null;
  try {
    const src = getContactsContainer(sock);
    if (!src) return null;
    const iter = Array.isArray(src)
      ? src
      : src instanceof Map
      ? [...src.values()]
      : typeof src === "object"
      ? Object.values(src)
      : [];
    for (const c of iter) {
      const id = c?.id || c?.jid || null;
      if (id && String(id).trim() === String(jid).trim()) {
        const lid = c?.lid || null;
        if (typeof lid === "string" && lid.endsWith("@lid")) return lid;
      }
    }
  } catch {}
  return null;
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

function sanitizeText(s) {
  if (s == null) return null;
  const t = String(s);
  return t
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\u2028|\u2029/g, " ")
    .replace(/"/g, "\u201D")
    .replace(/'/g, "\u2019")
    .trim();
}

function extractPictureId(url) {
  try {
    if (!url) return null;
    const s = String(url);
    const m1 = s.match(/[?&]id=(\d{6,})/i);
    if (m1 && m1[1]) return m1[1];
    const m2 = s.match(/(\d{10,})/);
    if (m2 && m2[1]) return m2[1];
    const u = new URL(s);
    const last = (u.pathname || "").replace(/\/+$/, "").split("/").pop() || "";
    const digits = last.replace(/\D+/g, "");
    return digits || null;
  } catch {
    return null;
  }
}

const defStr = (v, fallback = null) => {
  if (v == null) return fallback;
  try {
    const s = String(v).trim();
    return s === "" ? fallback : s;
  } catch {
    return fallback;
  }
};
const defNum = (v, fallback = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const defBool = (v, fallback = null) => (v == null ? fallback : !!v);
const defArr = (v) => (Array.isArray(v) ? v : []);
const defObj = (v) => (v && typeof v === "object" ? v : {});
const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
};
const sanitizeRemoteName = (name, phone) => {
  const value = defStr(name);
  if (!value) return null;
  const digitsInName = toDigits(value);
  const digitsInPhone = toDigits(phone);
  if (digitsInName && digitsInPhone && digitsInName === digitsInPhone) {
    return null;
  }
  return value;
};

function deriveSessionProfileJids(session, jid) {
  const candidates = [
    jid,
    session?.me?.id,
    session?.sock?.user?.id,
    session?.user?.id,
  ];
  let digits = "";
  for (const candidate of candidates) {
    const d = toDigits(extractPhoneDigitsFromJid(candidate || ""));
    if (d) {
      digits = d;
      break;
    }
  }
  const baseFromDigits = digits ? jidFromPhone(digits) : null;
  const fallback = candidates.map((v) => defStr(v)).find(Boolean) || null;
  const variants = new Set(
    [
      baseFromDigits,
      fallback,
      digits ? `${digits}@c.us` : null,
    ].filter(Boolean)
  );
  return {
    digits,
    baseJid: baseFromDigits || fallback || null,
    variants: [...variants],
  };
}

function toHHmm(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  const minutes = Math.max(0, Math.floor(n));
  const h = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function fillBusinessProfile(bp, jid) {
  const obj = defObj(bp);
  const bh = obj.business_hours || {};
  const rawBhList = defArr(bh.business_config || bh.config);
  const bhList = rawBhList.map((it) => {
    const a = defObj(it);
    return {
      day_of_week: defStr(a.day_of_week),
      mode: defStr(a.mode),
      open_time: toHHmm(a.open_time),
      close_time: toHHmm(a.close_time),
    };
  });
  let websiteArr = defArr(obj.website || obj.websites)
    .map((w) => defStr(w))
    .filter((x) => x != null);
  if (websiteArr.length === 1) {
    const s = websiteArr[0] || "";
    const parts = s
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length > 1) websiteArr = parts;
  }
  const catArray = (() => {
    const arr = defArr(obj.categories)
      .map((c) => defStr(c))
      .filter((x) => x != null);
    if (arr.length) return arr;
    const single = defStr(obj.category);
    if (!single) return [];
    const parts = single
      .split(/[;,/|]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return parts.length ? parts : [single];
  })();
  return {
    jid: defStr(jid),
    phone: defStr(extractPhoneDigitsFromJid(jid)),
    email: defStr(obj.email),
    address: defStr(obj.address),
    categories: catArray,
    businessHoursTimezone: defStr(bh.timezone || obj.businessHoursTimezone),
    businessHours: bhList,
    description: defStr(obj.description),
    websites: websiteArr,
    wid: defStr(obj.wid),
  };
}

function assertOwner(req, sessionId) {
  const { ownerId } = req.auth || {};
  const meta = getSessionMeta(sessionId);
  if (!meta) {
    const e = new Error("Not found");
    e.status = 404;
    throw e;
  }
  if (meta.ownerId !== ownerId) {
    const e = new Error("Forbidden");
    e.status = 403;
    throw e;
  }
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
    return {
      session: s,
      sessionId,
      phoneDigits: extractPhoneDigitsFromJid(s?.me?.id || ""),
      jid:
        s?.me?.id || jidFromPhone(extractPhoneDigitsFromJid(s?.me?.id || "")),
      by: "sessionId",
    };
  }

  if (phoneDigits) {
    const items = listRuntimeSessions();
    for (const it of items) {
      if (!it?.id) continue;
      const s = getSession(it.id);
      if (!s || s.status !== "open") continue;
      try {
        assertOwner(req, it.id);
      } catch {
        continue;
      }
      const meDigits = extractPhoneDigitsFromJid(s?.me?.id || "");
      if (meDigits && meDigits === phoneDigits) {
        return {
          session: s,
          sessionId: it.id,
          phoneDigits: meDigits,
          jid: s?.me?.id || jidFromPhone(meDigits),
          by: "phone",
        };
      }
    }
    return {
      error: (res) =>
        send(res, "SESSION_NOT_FOUND", {
          message: "Open session for this phone not found",
          result: null,
        }),
    };
  }

  return {
    error: (res) =>
      send(res, "MISSING_PARAMETER", {
        message: "Provide sessionId or phone",
        result: null,
      }),
  };
}

async function withQueue(session, fn) {
  if (!session?.queue) return fn();
  return new Promise((resolve, reject) => {
    session.queue.push(async () => {
      try {
        const out = await fn();
        resolve(out);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function resolveProfilePicturePayload(session, jid, phoneDigits) {
  const { digits, baseJid, variants } = deriveSessionProfileJids(session, jid);
  const variantList = Array.isArray(variants) ? variants : [];
  return withQueue(session, async () => {
    let pics =
      baseJid && session?.sock
        ? await getProfilePictures(session.sock, baseJid)
        : null;
    if ((!pics?.imgFull && !pics?.imgPreview) && variantList.length) {
      for (const candidate of variantList) {
        if (!candidate || candidate === baseJid) continue;
        const p = await getProfilePictures(session.sock, candidate);
        if (p?.imgFull || p?.imgPreview) {
          pics = p;
          break;
        }
      }
    }

    const imgFull = defStr(pics?.imgFull);
    const imgPreview = defStr(pics?.imgPreview);
    const chosen = imgFull || imgPreview || null;
    const phoneOut =
      defStr(phoneDigits) ||
      defStr(digits) ||
      defStr(extractPhoneDigitsFromJid(baseJid));
    const picId = extractPictureId(chosen);
    return {
      phone: phoneOut,
      url: defStr(chosen),
      id: defStr(picId),
      type: defStr(imgFull ? "image" : imgPreview ? "preview" : null),
      imgFull,
      imgPreview,
    };
  });
}

router.get("/info", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s, jid, phoneDigits, sessionId: sid } = resolved;

    const result = await withQueue(s, async () => {
      const pushName = defStr(s?.pushName || s?.sock?.user?.name);
      const verifiedName =
        defStr(
          s?.sock?.user?.verifiedName ||
            s?.sock?.user?.verifiedBusinessName ||
            s?.sock?.user?.name
        ) || pushName;
      const j = String(jid || "");
      const at = j.indexOf("@");
      const userPart = at >= 0 ? j.slice(0, at) : j;
      const serverPart = at >= 0 ? j.slice(at + 1) : "";
      const colonIdx = userPart.indexOf(":");
      const userOnly = colonIdx >= 0 ? userPart.slice(0, colonIdx) : userPart;
      const agent = colonIdx >= 0 ? userPart.slice(colonIdx + 1) : "";
      const userDigits = toDigits(userOnly);
      const agentDigits = agent ? Number(toDigits(agent)) : null;
      const baseJid = jidFromPhone(userDigits);
      let aboutStr = null;
      try {
        const out = await s.sock.fetchStatus(baseJid);
        aboutStr = defStr(typeof out === "string" ? out : out?.status);
      } catch {}
      if (aboutStr == null) {
        aboutStr = defStr(await fetchStatusForSession(s.sock, baseJid));
        if (aboutStr == null) {
          aboutStr = defStr(await getStatusText(s.sock, baseJid));
        }
      }
      const pics = await getProfilePictures(s.sock, baseJid);
      const imgFull = defStr(pics.imgFull);
      const imgPreview = defStr(pics.imgPreview);
      const rawBp = await getBusinessProfileSafe(s.sock, baseJid);
      const businessProfile = rawBp
        ? fillBusinessProfile(rawBp, baseJid)
        : null;

      let deviceValue = null;
      try {
        const meta = sid ? getSessionMeta(sid) : null;
        const profiles = Array.isArray(meta?.sessionProfile)
          ? meta.sessionProfile
          : [];
        const meJid = String(s?.me?.id || "");
        const mePhone = meJid.split("@")[0];
        const hit = profiles.find(
          (p) =>
            p?.jid === meJid || String(p?.phone || "").split("@")[0] === mePhone
        );
        deviceValue = hit?.device || null;
      } catch {}

      const pictureId = extractPictureId(imgFull || imgPreview);
      const agentNum = agentDigits ? Number(agentDigits) : null;
      return {
        phone: defStr(userDigits),
        verifiedName,
        pushName,
        about: aboutStr,
        pictureId,
        businessProfile,
        entries: {
          User: defStr(userDigits),
          Agent: agentNum,
          Device: deviceValue == null ? null : deviceValue,
          Server: defStr(serverPart || "s.whatsapp.net") || "s.whatsapp.net",
        },
        profilePicture: {
          url: defStr(imgFull || imgPreview),
          id: extractPictureId(imgFull || imgPreview),
          type: defStr(imgFull ? "image" : imgPreview ? "preview" : null),
          imgFull: defStr(imgFull),
          imgPreview: defStr(imgPreview),
        },
      };
    });

    return send(res, "SUCCESS", {
      message: "Profile info",
      result,
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/picture", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s, jid, phoneDigits } = resolved;

    const result = await resolveProfilePicturePayload(s, jid, phoneDigits);

    return send(res, "SUCCESS", {
      message: "Profile picture",
      result,
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/picture", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s, jid, phoneDigits } = resolved;
    const rawPic = readAnyStr(req, ["picture", "image", "photo", "avatar"]);
    if (!rawPic) {
      return send(res, "MISSING_PARAMETER", {
        message: "picture is required",
        result: null,
      });
    }

    const buf = await loadImageBufferFromInput(rawPic);
    if (!buf) {
      return send(res, "INVALID_PARAMETER", {
        message: "picture is invalid or unreadable",
        result: null,
      });
    }

    const scope = deriveSessionProfileJids(s, jid);
    if (!scope.baseJid) {
      return send(res, "INTERNAL_ERROR", {
        message: "Unable to resolve session identity",
        result: null,
      });
    }

    try {
      await withQueue(s, async () =>
        s.sock.updateProfilePicture(scope.baseJid, buf)
      );
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to update profile picture",
        result: null,
      });
    }

    for (const variant of scope.variants || []) {
      invalidateProfilePicCacheFor(variant);
    }

    const result = await resolveProfilePicturePayload(
      s,
      scope.baseJid,
      phoneDigits
    );

    return send(res, "SUCCESS", {
      message: "Profile picture updated",
      result,
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.delete("/picture", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s, jid, phoneDigits } = resolved;
    const scope = deriveSessionProfileJids(s, jid);
    if (!scope.baseJid) {
      return send(res, "INTERNAL_ERROR", {
        message: "Unable to resolve session identity",
        result: null,
      });
    }

    try {
      await withQueue(s, async () =>
        s.sock.removeProfilePicture(scope.baseJid)
      );
    } catch (e) {
      return send(res, "DOWNSTREAM_ERROR", {
        message: e?.message || "Failed to remove profile picture",
        result: null,
      });
    }

    for (const variant of scope.variants || []) {
      invalidateProfilePicCacheFor(variant);
    }

    return send(res, "SUCCESS", {
      message: "Profile picture removed",
      result: null,
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/privacy", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s, jid, phoneDigits } = resolved;

    const result = await withQueue(s, async () => {
      let privacy = {};
      try {
        privacy = (await s.sock.fetchPrivacySettings()) || {};
      } catch {}
      return {
        phone: defStr(phoneDigits || extractPhoneDigitsFromJid(jid)),
        readReceipts: defStr(
          privacy.readReceipts || privacy.read_receipts,
          "all"
        ),
        profilePhoto: defStr(privacy.profile || privacy.profilePhoto, "all"),
        status: defStr(privacy.status, "all"),
        online: defStr(privacy.online, "match_last_seen"),
        lastSeen: defStr(privacy.last || privacy.lastSeen, "none"),
        groupAdd: defStr(
          privacy.groupAdd || privacy.groupsAdd || privacy.group_add,
          "all"
        ),
        callAdd: defStr(privacy.calls || privacy.callAdd, "all"),
        stikers: defStr(privacy.stickers || privacy.stikers, "contacts"),
        messages: defStr(privacy.messages, "all"),
      };
    });

    return send(res, "SUCCESS", {
      message: "Privacy settings",
      result,
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/list-contacts", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s, jid, phoneDigits, sessionId } = resolved;

    const typeRaw = readAnyStr(req, ["type"]);
    const type = String(typeRaw || "contacts").trim().toLowerCase() === "groups"
      ? "groups"
      : "contacts";
    const deepRaw = readAnyStr(req, ["deep"]);
    const deep =
      String(deepRaw ?? "false").trim().toLowerCase() === "true" ? true : false;
    const groupIds = parseGroupIds(req.body?.groupIds ?? req.query?.groupIds);

    const limitRaw = readAnyStr(req, ["limit"]);
    const offsetRaw = readAnyStr(req, ["offset"]);
    const limit = clampNumber(limitRaw, 1, 1000, 15);
    const offset = clampNumber(offsetRaw, 0, 1_000_000, 0);
    const phoneOut = defStr(phoneDigits || extractPhoneDigitsFromJid(jid));

    const sessionKey = sessionId || s?.id || phoneOut || "unknown";
    const cacheKey = deep
      ? buildContactsCacheKey({
          sessionKey,
          type,
          limit,
          offset,
          groupIds,
        })
      : null;
    if (cacheKey) {
      const cached = await contactsCache.get(cacheKey);
      if (cached) {
        return send(res, "SUCCESS", {
          message: "Contacts list",
          result: cached,
        });
      }
    }

    let data = [];
    if (type === "groups") {
      data = await fetchContactsFromGroups(s, {
        deep,
        groupIds,
        limit,
        offset,
      });
    } else {
      if (!sessionId) {
        throw new Error("Missing sessionId for contact query");
      }
      data = await fetchContactsFromDb(sessionId, { limit, offset });
      if (deep) {
        data = await enrichContactDetails(s, data);
      }
    }

    const resultPayload = {
      phone: phoneOut,
      data,
    };
    if (cacheKey) {
      await contactsCache.set(cacheKey, resultPayload, CONTACTS_CACHE_TTL_SECONDS);
    }

    return send(res, "SUCCESS", {
      message: "Contacts list",
      result: resultPayload,
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

function parseGroupIds(source) {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.map((x) => String(x || "").trim()).filter(Boolean);
  }
  if (typeof source === "string") {
    return source
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function buildContactsCacheKey({ sessionKey, type, limit, offset, groupIds }) {
  const normalizedGroups =
    type === "groups" && Array.isArray(groupIds) && groupIds.length
      ? [...groupIds].sort().join(",")
      : "all";
  const keyParts = [
    "contacts",
    sessionKey,
    type,
    String(limit),
    String(offset),
    normalizedGroups,
  ];
  return keyParts.join("|");
}

async function fetchContactsFromDb(sessionId, { limit, offset }) {
  const rows = await db("sync_contacts")
    .select("jid", "phone", "name", "notify", "verified_name")
    .where("session_id", sessionId)
    .andWhere("is_group", false)
    .orderBy("updated_at_sec", "desc")
    .orderBy("jid", "asc")
    .limit(limit)
    .offset(offset);

  return defArr(rows).map((row) => ({
    jid: defStr(row?.jid),
    phone: defStr(row?.phone),
    name:
      defStr(row?.verified_name) ||
      defStr(row?.name) ||
      defStr(row?.notify),
  }));
}

async function fetchContactsFromGroups(session, { deep, groupIds, limit, offset }) {
  const out = await withQueue(session, async () =>
    listContactsFromGroupsSafe(session.sock, {
      deep,
      pictures: deep ? "image" : "none",
      groupIds: groupIds.length ? groupIds : undefined,
      limit,
      offset,
    })
  );
  let mapped = defArr(out).map((it) => {
    const entry = {
      jid: defStr(it?.jid),
      phone: defStr(it?.phone),
      name: defStr(it?.name),
    };
    return entry;
  });
  if (deep) {
    mapped = await enrichContactDetails(session, mapped);
  }
  return mapped;
}

router.get("/on-whatsapp", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s } = resolved;

    const raw = req.body?.checkNumbers ?? req.query?.checkNumbers;
    let numbers = [];
    if (Array.isArray(raw)) numbers = raw.map(toDigits).filter(Boolean);
    else if (typeof raw === "string")
      numbers = raw
        .split(",")
        .map((x) => x.trim())
        .map(toDigits)
        .filter(Boolean);

    if (!numbers.length) {
      const single = toDigits(
        readAnyStr(req, ["checkNumbers", "checkNumber", "number", "phone"]) ||
          ""
      );
      if (single) numbers = [single];
    }

    if (!numbers.length) {
      return send(res, "MISSING_PARAMETER", {
        message: "checkNumbers is required",
        result: null,
      });
    }

    const deepRaw = readAnyStr(req, ["deep"]);
    const deep =
      String(deepRaw ?? "false").trim().toLowerCase() === "true" ? true : false;

    const doCheck = async (num) => {
      const jid = jidFromPhone(num);
      try {
        const r = await s.sock.onWhatsApp(jid);
        const first = Array.isArray(r) ? r[0] : r;
        const existsPrimary = first?.exists;
        const fallbackExists = first?.isIn || first?.isOnWhatsApp;
        const finalExists = existsPrimary ?? fallbackExists ? true : false;
        return {
          jid: defStr(first?.jid || jid),
          phone: defStr(num),
          isOnWhatsApp: !!finalExists,
        };
      } catch {
        return {
          jid: defStr(jid),
          phone: defStr(num),
          isOnWhatsApp: false,
        };
      }
    };

    const many = await withQueue(s, async () =>
      Promise.all(numbers.map(doCheck))
    );

    if (deep) {
      await enrichOnWhatsappEntries(s, many);
    }
    const payload = deep
      ? many
      : many.map((item) => ({
          jid: item.jid,
          phone: item.phone,
          isOnWhatsApp: item.isOnWhatsApp,
        }));

    const result = payload.length === 1 ? { data: payload[0] } : { data: payload };
    return send(res, "SUCCESS", { message: "Lookup complete", result });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/business-profile", async (req, res) => {
  try {
    const resolved = await resolveSessionByParam(req);
    if (resolved.error) {
      const f = resolved.error;
      return f(res);
    }
    const { session: s } = resolved;

    const raw = req.body?.checkNumbers ?? req.query?.checkNumbers;
    let numbers = [];
    if (Array.isArray(raw)) numbers = raw.map(toDigits).filter(Boolean);
    else if (typeof raw === "string")
      numbers = raw
        .split(",")
        .map((x) => x.trim())
        .map(toDigits)
        .filter(Boolean);

    if (!numbers.length) {
      const single = toDigits(
        readAnyStr(req, ["checkNumbers", "checkNumber", "number", "phone"]) ||
          ""
      );
      if (single) numbers = [single];
    }

    if (!numbers.length) {
      return send(res, "MISSING_PARAMETER", {
        message: "checkNumbers is required",
        result: null,
      });
    }

    const profiles = await fetchBusinessProfiles(s, numbers);
    const result =
      profiles.length === 1
        ? profiles[0]
        : { data: profiles };
    return send(res, "SUCCESS", { message: "Business profile info", result });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

async function fetchBusinessProfiles(session, numbers) {
  if (!session?.sock) return [];
  const uniqueJids = Array.from(
    new Set(
      numbers
        .map((num) => jidFromPhone(num))
        .map((jid) => defStr(jid))
        .filter(Boolean)
    )
  );
  const profileMap = new Map();
  const toFetch = [];
  for (const jid of uniqueJids) {
    const cached = await businessProfileCache.get(jid);
    if (cached) profileMap.set(jid, cached);
    else toFetch.push(jid);
  }
  for (let i = 0; i < toFetch.length; i += BUSINESS_PROFILE_BATCH) {
    const chunk = toFetch.slice(i, i + BUSINESS_PROFILE_BATCH);
    const profiles = await Promise.all(
      chunk.map((jid) => loadBusinessProfile(session, jid))
    );
    profiles.forEach((profile, idx) => {
      const jid = chunk[idx];
      const resolved = profile || fillBusinessProfile(null, jid);
      profileMap.set(jid, resolved);
      businessProfileCache.set(jid, resolved, BUSINESS_PROFILE_CACHE_TTL_SECONDS);
    });
  }
  return uniqueJids.map(
    (jid) => profileMap.get(jid) || fillBusinessProfile(null, jid)
  );
}

async function loadBusinessProfile(session, jid) {
  if (!jid) return fillBusinessProfile(null, null);
  try {
    const raw = await session.sock.getBusinessProfile(jid);
    const clean = raw && typeof raw === "object" ? { ...raw } : null;
    if (clean?.description) {
      clean.description = sanitizeText(clean.description);
    }
    return fillBusinessProfile(clean, jid);
  } catch {
    return fillBusinessProfile(null, jid);
  }
}

async function enrichContactDetails(session, contacts) {
  if (!session?.sock || !Array.isArray(contacts) || !contacts.length)
    return contacts;
  const chunkSize = 5;
  const enriched = [];
  for (let i = 0; i < contacts.length; i += chunkSize) {
    const chunk = contacts.slice(i, i + chunkSize);
    const hydrated = await withQueue(session, async () =>
      hydrateContactsChunk(session, chunk)
    );
    enriched.push(...hydrated);
  }
  return enriched;
}

async function hydrateContactsChunk(session, chunk) {
  const out = [];
  for (const entry of chunk) {
    const base = { ...entry };
    const jid = defStr(base?.jid);
    if (!jid) {
      out.push(base);
      continue;
    }

    const contactInfo = lookupStoreContact(session, jid);
    if (contactInfo) {
      const verified =
        defStr(contactInfo.verifiedName) ||
        defStr(contactInfo.verifiedBusinessName);
      if (verified && !base.verifiedName) base.verifiedName = verified;
      if (!base.name) {
        base.name =
          defStr(contactInfo.name) ||
          defStr(contactInfo.notify) ||
          base.name;
      }
    }

    const existingPicture = normalizePicturePayload(base.picture);
    if (existingPicture) {
      base.picture = existingPicture;
    }

    if (!base.picture) {
      try {
        const pics = await getProfilePictures(session.sock, jid, "both");
        const full = defStr(pics?.imgFull);
        const preview = defStr(pics?.imgPreview);
        if (full || preview) {
          base.picture = { full: full || null, preview: preview || null };
        }
      } catch {}
    }

    if (!base.about) {
      try {
        const about = await fetchStatusForSession(session.sock, jid);
        if (about) base.about = about;
      } catch {}
    }

    if (!base.businessProfile) {
      try {
        const bp = await getBusinessProfileSafe(session.sock, jid);
        if (bp) base.businessProfile = fillBusinessProfile(bp, jid);
      } catch {}
    }

    out.push(base);
  }
  return out;
}

function lookupStoreContact(session, jid) {
  try {
    const store =
      session?.store?.contacts ||
      session?.sock?.store?.contacts ||
      session?.contacts ||
      null;
    if (!store) return null;
    if (store instanceof Map) return store.get(jid) || null;
    if (typeof store === "object") return store[jid] || null;
    return null;
  } catch {
    return null;
  }
}

function normalizePicturePayload(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { full: trimmed, preview: null } : null;
  }
  if (typeof value === "object") {
    const full =
      defStr(value?.full) ||
      defStr(value?.image) ||
      defStr(value?.url) ||
      defStr(value?.data);
    const preview = defStr(value?.preview) || defStr(value?.thumb);
    return full || preview ? { full: full || null, preview: preview || null } : null;
  }
  return null;
}

async function enrichOnWhatsappEntries(session, entries) {
  if (!session?.sock || !Array.isArray(entries) || !entries.length) return;
  const chunkSize = 5;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize).filter((item) => item.isOnWhatsApp);
    if (!chunk.length) continue;
    const enriched = await withQueue(session, async () =>
      Promise.all(chunk.map((entry) => fetchOnWhatsappEntryDetails(session, entry)))
    );
    enriched.forEach((details, idx) => {
      if (!details) return;
      Object.assign(chunk[idx], details);
    });
  }
}

async function fetchOnWhatsappEntryDetails(session, entry) {
  const jid = defStr(entry?.jid);
  const phone = defStr(entry?.phone);
  if (!jid) return null;
  const details = {};
  try {
    const lookup = await session.sock.onWhatsApp(jid);
    const info = Array.isArray(lookup) ? lookup[0] : lookup;
    if (info) {
      // name intentionally omitted for privacy when using on-whatsapp lookup
    }
  } catch {}
  try {
    const full = await session.sock.profilePictureUrl(jid, "image");
    const preview = await session.sock.profilePictureUrl(jid, "preview");
    if (full || preview) {
      details.picture = normalizePicturePayload({
        full: full || null,
        preview: preview || null,
      });
    }
  } catch {}
  try {
    const status = await session.sock.fetchStatus(jid);
    if (typeof status === "string" && status.trim()) {
      details.about = sanitizeText(status);
    } else if (status?.status) {
      details.about = sanitizeText(status.status);
    }
  } catch {}
  try {
    const bp = await session.sock.getBusinessProfile(jid);
    if (bp) details.businessProfile = fillBusinessProfile(bp, jid);
  } catch {}
  return Object.keys(details).length ? details : null;
}

export default router;
