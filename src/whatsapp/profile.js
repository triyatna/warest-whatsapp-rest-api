export async function getStatusText(sock, jid) {
  const tryFetch = async (j) => {
    try {
      const st = await sock.fetchStatus(j);
      if (typeof st === "string") return st.trim();
      if (Array.isArray(st) && st.length) {
        const pick = st.find((it) => String(it?.id || "") === j) || st[0];
        const val = pick?.status?.status || pick?.status;
        if (typeof val === "string" && val.trim()) return val.trim();
      }
      const v = st?.status;
      return typeof v === "string" ? v.trim() : null;
    } catch {
      return null;
    }
  };
  const raw = String(jid || "");
  const digits = raw.split("@")[0].replace(/\D+/g, "");
  const jids = Array.from(
    new Set(
      [
        raw,
        digits ? `${digits}@s.whatsapp.net` : null,
        digits ? `${digits}@c.us` : null,
      ].filter(Boolean)
    )
  );
  for (const j of jids) {
    const v = await tryFetch(j);
    if (v != null && v !== "") return v;
  }
  try {
    const u = sock?.user;
    if (typeof u?.status === "string" && u.status.trim())
      return u.status.trim();
  } catch {}
  try {
    const contacts = sock?.store?.contacts || sock?.contacts;
    const jidKey = digits ? `${digits}@s.whatsapp.net` : raw;
    let c = null;
    if (contacts instanceof Map) {
      c =
        contacts.get(jidKey) ||
        [...contacts.values()].find((x) => (x?.id || x?.jid) === jidKey);
    } else if (contacts && typeof contacts === "object") {
      c =
        contacts[jidKey] ||
        Object.values(contacts).find((x) => (x?.id || x?.jid) === jidKey);
    }
    if (typeof c?.status === "string" && c.status.trim())
      return c.status.trim();
  } catch {}
  return "";
}

const __picCache = new Map();
const PIC_TTL_MS = 5 * 60 * 1000;

const __nameCache = new Map();
const NAME_TTL_MS = 24 * 60 * 60 * 1000;

export function cachePushName(jid, name) {
  try {
    const id = String(jid || "").trim();
    const nm = String(name || "").trim();
    if (!id || !nm) return;
    __nameCache.set(id, { name: nm, t: Date.now() });
  } catch {}
}

function getCachedName(jid) {
  const rec = __nameCache.get(String(jid || "").trim());
  if (!rec) return null;
  if (Date.now() - (rec.t || 0) > NAME_TTL_MS) return null;
  return rec.name || null;
}

export function invalidateProfilePicCacheFor(jid) {
  try {
    const id = String(jid || "").trim();
    if (!id) return;
    for (const key of Array.from(__picCache.keys())) {
      if (key.startsWith(`${id}:`)) __picCache.delete(key);
    }
  } catch {}
}

async function getProfilePicturesInternal(sock, jid, mode) {
  const key = `${jid}:${mode}`;
  const now = Date.now();
  const hit = __picCache.get(key);
  if (hit && now - (hit.t || 0) < PIC_TTL_MS) {
    return { imgFull: hit.imgFull || null, imgPreview: hit.imgPreview || null };
  }
  let imgFull = null;
  let imgPreview = null;
  if (mode === "image" || mode === "both") {
    try {
      imgFull = await sock.profilePictureUrl(jid, "image");
    } catch {}
  }
  if (mode === "preview" || mode === "both") {
    try {
      imgPreview = await sock.profilePictureUrl(jid, "preview");
    } catch {}
  }
  __picCache.set(key, { imgFull, imgPreview, t: now });
  return { imgFull: imgFull || null, imgPreview: imgPreview || null };
}

export async function getProfilePictures(sock, jid, mode = "both") {
  
  if (mode === "none") return { imgFull: null, imgPreview: null };
  return getProfilePicturesInternal(sock, jid, mode);
}

async function getPrimaryPicture(sock, jid) {
  const a = await getProfilePictures(sock, jid, "both");
  const first = a.imgFull || a.imgPreview || null;
  if (first) return first;
  try {
    const local = String(jid || "").split("@")[0];
    const localNoDevice = local.split(":")[0];
    if (!localNoDevice) return null;
    const alt = `${localNoDevice}@c.us`;
    const b = await getProfilePictures(sock, alt, "both");
    return b.imgFull || b.imgPreview || null;
  } catch {
    return null;
  }
}

export async function getBusinessProfileSafe(sock, jid) {
  try {
    const bp = await sock.getBusinessProfile(jid);
    return bp && typeof bp === "object" ? bp : null;
  } catch {
    return null;
  }
}

export async function getPrivacySettingsSafe(sock) {
  try {
    const p = await sock.fetchPrivacySettings();
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

export async function fetchAllGroupsSafe(sock) {
  try {
    const m = await sock.groupFetchAllParticipating();
    if (m && typeof m === "object") return Object.values(m);
    return [];
  } catch {
    return [];
  }
}

export async function listContactsSafe(sock, opts = {}) {
  try {
    const userJid = String(sock?.user?.id || "");
    const pictures = (opts.pictures || "both").toLowerCase();
    const concurrency = Number(opts.concurrency || 8);
    const limitOpt = Number(opts.limit);
    const offsetOpt = Number(opts.offset || 0);
    const contactsSrc = sock?.store?.contacts || sock?.contacts || null;
    const entries =
      contactsSrc instanceof Map
        ? [...contactsSrc.values()]
        : contactsSrc && typeof contactsSrc === "object"
        ? Object.values(contactsSrc)
        : [];

    const onlyUsers = entries.filter((c) => {
      const id = String(c?.id || c?.jid || "").trim();
      if (!id) return false;
      if (!id.endsWith("@s.whatsapp.net")) return false;
      if (id === "status@broadcast") return false;
      if (/@newsletter$/i.test(id)) return false;
      if (/@g\.us$/i.test(id)) return false;
      if (/@lid$/i.test(id)) return false;
      if (id === userJid) return false;
      return true;
    });

    onlyUsers.sort((a, b) => {
      const an = (
        a?.verifiedName ||
        a?.name ||
        a?.notify ||
        a?.id ||
        a?.jid ||
        ""
      ).toLowerCase();
      const bn = (
        b?.verifiedName ||
        b?.name ||
        b?.notify ||
        b?.id ||
        b?.jid ||
        ""
      ).toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });

    const offset =
      Number.isFinite(offsetOpt) && offsetOpt > 0 ? Math.floor(offsetOpt) : 0;
    const limited =
      Number.isFinite(limitOpt) && limitOpt > 0
        ? onlyUsers.slice(offset, offset + limitOpt)
        : onlyUsers.slice(offset);

    const limit = Math.max(1, Math.min(32, concurrency));
    const out = [];
    for (let i = 0; i < limited.length; i += limit) {
      const batch = limited.slice(i, i + limit);
      const items = await Promise.all(
        batch.map(async (c) => {
          const jid = String(c?.id || c?.jid);
          const local = jid.split("@")[0];
          const localNoDevice = local.split(":")[0];
          const phone = localNoDevice.replace(/\D+/g, "");
          const cachedName = getCachedName(jid);
          const name =
            cachedName ||
            (typeof c?.verifiedName === "string" && c.verifiedName) ||
            (typeof c?.name === "string" && c.name) ||
            (typeof c?.notify === "string" && c.notify) ||
            phone ||
            null;
          let picture = null;
          if (pictures !== "none") {
            if (pictures === "preview") {
              const p = await getProfilePictures(sock, jid, "preview");
              picture = p.imgPreview || null;
              if (!picture) picture = await getPrimaryPicture(sock, jid);
            } else if (pictures === "image") {
              const p = await getProfilePictures(sock, jid, "image");
              picture = p.imgFull || null;
              if (!picture) picture = await getPrimaryPicture(sock, jid);
            } else {
              picture = await getPrimaryPicture(sock, jid);
            }
          }

          return { jid, phone: phone || null, name: name || null, picture };
        })
      );
      out.push(...items);
    }

    out.sort((a, b) => {
      const ax = (a.name || a.phone || a.jid || "").toLowerCase();
      const bx = (b.name || b.phone || b.jid || "").toLowerCase();
      if (ax < bx) return -1;
      if (ax > bx) return 1;
      return 0;
    });

    return out;
  } catch {
    return [];
  }
}

export async function listContactsFromGroupsSafe(sock, opts = {}) {
  try {
    const userJid = String(sock?.user?.id || "");
    const pictures = (opts.pictures || "none").toLowerCase();
    const deep = !!opts.deep;
    const groupIdFilter = Array.isArray(opts.groupIds)
      ? opts.groupIds
          .filter((x) => typeof x === "string" && x)
          .map((x) => x.trim())
      : null;
    const concurrency = Number(opts.concurrency || 8);
    const limitOpt = Number(opts.limit);
    const offsetOpt = Number(opts.offset || 0);

    const groupsObj = await sock.groupFetchAllParticipating().catch(() => ({}));
    const groupList =
      groupsObj && typeof groupsObj === "object"
        ? Object.values(groupsObj)
        : [];
    const filteredGroups = groupIdFilter
      ? groupList.filter((g) =>
          groupIdFilter.includes(String(g?.id || "").trim())
        )
      : groupList;

    const contactsSrc = sock?.store?.contacts || sock?.contacts || null;
    const lidIndex = new Map();
    try {
      if (contactsSrc instanceof Map) {
        for (const c of contactsSrc.values()) {
          const lid = String(c?.lid || "").trim();
          const id = String(c?.id || c?.jid || "").trim();
          if (lid && id.endsWith("@s.whatsapp.net")) lidIndex.set(lid, id);
        }
      } else if (contactsSrc && typeof contactsSrc === "object") {
        for (const c of Object.values(contactsSrc)) {
          const lid = String(c?.lid || "").trim();
          const id = String(c?.id || c?.jid || "").trim();
          if (lid && id.endsWith("@s.whatsapp.net")) lidIndex.set(lid, id);
        }
      }
    } catch {}
    const mapLidToSwh = (lid) => lidIndex.get(String(lid || "").trim()) || null;

    const jidSet = new Set();
    for (const g of filteredGroups) {
      let meta = g;
      const hasParticipants =
        Array.isArray(meta?.participants) ||
        (meta?.participants && typeof meta.participants === "object");
      if (deep && !hasParticipants) {
        try {
          const fresh = await sock.groupMetadata(g?.id);
          if (fresh && typeof fresh === "object") meta = { ...g, ...fresh };
        } catch {}
      }
      const src = meta?.participants;
      const plist = Array.isArray(src)
        ? src
        : src instanceof Map
        ? [...src.values()]
        : src && typeof src === "object"
        ? Object.values(src)
        : [];
      for (const p of plist) {
        let jid =
          chooseNormalizedUserJid(p) || String(p?.id || p?.jid || "").trim();
        if (!jid) continue;
        if (jid.endsWith("@lid")) {
          const mapped = mapLidToSwh(jid);
          if (mapped) jid = mapped;
        }
        if (!jid.endsWith("@s.whatsapp.net")) continue;
        if (jid === "status@broadcast") continue;
        if (/@newsletter$/i.test(jid)) continue;
        if (/@g\.us$/i.test(jid)) continue;
        if (/@lid$/i.test(jid)) continue;
        if (jid === userJid) continue;
        jidSet.add(jid);
      }
    }

    const getContact = (jid) => {
      try {
        if (contactsSrc instanceof Map) {
          return contactsSrc.get(jid) || null;
        }
        if (contactsSrc && typeof contactsSrc === "object") {
          return contactsSrc[jid] || null;
        }
      } catch {}
      return null;
    };

    const jids = [...jidSet];
    const offset =
      Number.isFinite(offsetOpt) && offsetOpt > 0 ? Math.floor(offsetOpt) : 0;
    const limitedJids =
      Number.isFinite(limitOpt) && limitOpt > 0
        ? jids.slice(offset, offset + limitOpt)
        : jids.slice(offset);
    const limit = Math.max(1, Math.min(32, concurrency));
    const out = [];
    for (let i = 0; i < limitedJids.length; i += limit) {
      const batch = limitedJids.slice(i, i + limit);
      const items = await Promise.all(
        batch.map(async (jid) => {
          const c = getContact(jid) || {};
          const local = jid.split("@")[0];
          const localNoDevice = local.split(":")[0];
          const phone = localNoDevice.replace(/\D+/g, "");
          const cachedName = getCachedName(jid);
          const name =
            cachedName ||
            (typeof c?.verifiedName === "string" && c.verifiedName) ||
            (typeof c?.name === "string" && c.name) ||
            (typeof c?.notify === "string" && c.notify) ||
            phone ||
            null;

          let picture = null;
          if (pictures !== "none") {
            if (pictures === "preview") {
              const p = await getProfilePictures(sock, jid, "preview");
              picture = p.imgPreview || null;
              if (!picture) picture = await getPrimaryPicture(sock, jid);
            } else if (pictures === "image") {
              const p = await getProfilePictures(sock, jid, "image");
              picture = p.imgFull || null;
              if (!picture) picture = await getPrimaryPicture(sock, jid);
            } else {
              picture = await getPrimaryPicture(sock, jid);
            }
          }

          return { jid, phone: phone || null, name: name || null, picture };
        })
      );
      out.push(...items);
    }

    out.sort((a, b) => {
      const ax = (a.name || a.phone || a.jid || "").toLowerCase();
      const bx = (b.name || b.phone || b.jid || "").toLowerCase();
      if (ax < bx) return -1;
      if (ax > bx) return 1;
      return 0;
    });

    return out;
  } catch {
    return [];
  }
}

export async function fetchStatusForSession(sock, jidOrPhone) {
  try {
    if (!sock) return null;

    const raw = String(jidOrPhone || "").trim();
    const digits = raw.replace(/\D+/g, "");

    const primaryJid = digits ? `${digits}@s.whatsapp.net` : null;
    const candidates = [];

    if (primaryJid) candidates.push(primaryJid);
    if (raw.includes("@")) candidates.push(raw);
    if (sock?.user?.id) candidates.push(sock.user.id);

    const uniq = [...new Set(candidates.map((v) => v.trim()).filter(Boolean))];

    for (const jid of uniq) {
      try {
        const res = await sock.fetchStatus(jid);
        if (!res) continue;

        if (typeof res === "string" && res.trim()) return res.trim();
        if (typeof res?.status === "string" && res.status.trim())
          return res.status.trim();

        if (Array.isArray(res)) {
          for (const item of res) {
            const val = item?.status?.status || item?.status;
            if (typeof val === "string" && val.trim()) return val.trim();
          }
        }
      } catch {}
    }

    return null;
  } catch {
    return null;
  }
}
import { jidDecode, jidEncode } from "@whiskeysockets/baileys";

export function toSWhatsAppUserJid(jidOrPhoneLike) {
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
    const digits = s.replace(/\D+/g, "");
    return digits ? `${digits}@s.whatsapp.net` : null;
  }
  return null;
}

export function chooseNormalizedUserJid(obj) {
  const candidates = [obj?.participant, obj?.jid, obj?.id, obj?.user];
  for (const c of candidates) {
    const norm = toSWhatsAppUserJid(c);
    if (norm && !norm.endsWith("@lid")) return norm;
  }
  return null;
}
