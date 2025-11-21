import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  upsertSession as upsertSessionRecord,
  listSessions as listSessionRecords,
  removeSession as removeSessionRecord,
} from "../database/models/sessionRepo.js";
import { logger as appLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data/private/credentials");
const SESS_FILE = path.join(DATA_DIR, "sessions.json");
const SESS_FILE_TMP = path.join(DATA_DIR, "sessions.json.tmp");
const SESS_FILE_BAK = path.join(DATA_DIR, "sessions.json.bak");

const logger = appLogger.child({ module: "sessionRegistry" });

let registry = { sessions: {} };
let lastSavedContent = "";
let dbPollTimer = null;
let fsWatchInitialized = false;

let syncLock = Promise.resolve();
function withSyncLock(fn) {
  const run = async () => {
    try {
      return await fn();
    } catch (e) {
      throw e;
    }
  };
  const p = syncLock.then(run, run);
  syncLock = p.catch(() => {});
  return p;
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true }).catch(() => {});
}

async function readJsonSafe(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function writeJsonAtomic(file, data) {
  const content = JSON.stringify(data, null, 2);

  if (content === lastSavedContent) return;

  await ensureDir(path.dirname(file));
  try {
    if (fs.existsSync(file)) {
      await fsp.copyFile(file, SESS_FILE_BAK).catch(() => {});
    }
  } catch {}
  await fsp.writeFile(SESS_FILE_TMP, content, "utf8");
  await fsp.rename(SESS_FILE_TMP, file);
  lastSavedContent = content;
}

function shallowNormalizeSession(jsonSess = {}) {
  return {
    id: jsonSess.id,
    label: jsonSess.label ?? jsonSess.id,
    autoStart: jsonSess.autoStart !== false,
    webhookUrl: jsonSess.webhookUrl || "",
    webhookSecret: jsonSess.webhookSecret || "",
    sessionProfile: Array.isArray(jsonSess.sessionProfile)
      ? jsonSess.sessionProfile
      : undefined,
    createdAt: jsonSess.createdAt || Date.now(),
    ownerId: jsonSess.ownerId || null,
    credentialsPath: jsonSess.credentialsPath || null,
    status: jsonSess.status || undefined,
    lastConnectedAt: jsonSess.lastConnectedAt || undefined,
  };
}

export async function loadRegistry() {
  try {
    await ensureDir(DATA_DIR);

    if (fs.existsSync(SESS_FILE)) {
      const json = await readJsonSafe(SESS_FILE);
      registry = {
        sessions:
          json && typeof json.sessions === "object" ? json.sessions : {},
      };
      lastSavedContent = JSON.stringify(
        { sessions: registry.sessions },
        null,
        2
      );
    }

    try {
      const dbRows = await listSessionRecords();
      for (const r of dbRows) {
        const prev = registry.sessions[r.id] || {};
        registry.sessions[r.id] = {
          id: r.id,
          label: r.label || prev.label || r.id,
          autoStart:
            (typeof r.auto_start === "boolean"
              ? r.auto_start
              : prev.autoStart) ?? true,
          webhookUrl: r.webhook_url ?? prev.webhookUrl ?? "",
          webhookSecret: r.webhook_secret ?? prev.webhookSecret ?? "",
          sessionProfile: (() => {
            try {
              return r.session_profile
                ? JSON.parse(r.session_profile)
                : prev.sessionProfile;
            } catch {
              return prev.sessionProfile;
            }
          })(),
          createdAt: prev.createdAt ?? Date.now(),
          ownerId: r.registry_user || prev.ownerId || null,
          credentialsPath: r.credentials_path || prev.credentialsPath || null,
          status: r.status ?? prev.status,
          lastConnectedAt: r.last_connected_at ?? prev.lastConnectedAt,
        };
      }
      await syncJsonToDb(
        { sessions: registry.sessions },
        { allowDeletes: false }
      );
      await saveRegistry();
    } catch {}
  } catch (e) {
    logger.error({ err: e }, "load registry failed");
  }
}

export async function saveRegistry() {
  try {
    await writeJsonAtomic(SESS_FILE, { sessions: registry.sessions });
  } catch (e) {
    logger.error({ err: e }, "save registry failed");
  }
}

export function notifySessionsChanged(ownerId = null) {
  try {
    const io = globalThis.__io;
    if (!io) return;
    if (ownerId) io.to(`registry:${ownerId}`).emit("sessions_changed");
    else io.emit("sessions_changed");
  } catch {}
}

export function upsertSessionMeta(meta) {
  if (!meta?.id) throw new Error("meta.id required");
  const prev = registry.sessions[meta.id] || {};
  registry.sessions[meta.id] = {
    id: meta.id,
    label: meta.label ?? prev.label ?? meta.id,
    autoStart: meta.autoStart ?? prev.autoStart ?? true,
    webhookUrl: meta.webhookUrl ?? prev.webhookUrl ?? "",
    webhookSecret: meta.webhookSecret ?? prev.webhookSecret ?? "",
    sessionProfile: Array.isArray(meta.sessionProfile)
      ? meta.sessionProfile
      : prev.sessionProfile,
    createdAt: prev.createdAt ?? Date.now(),
    ownerId: meta.ownerId ?? prev.ownerId ?? null,
    credentialsPath: meta.credentialsPath ?? prev.credentialsPath ?? null,
    status: meta.status ?? prev.status,
    lastConnectedAt: meta.lastConnectedAt ?? prev.lastConnectedAt,
  };
  void saveRegistry();
  try {
    const owner = registry.sessions[meta.id]?.ownerId || null;
    notifySessionsChanged(owner);
  } catch {}
  try {
    void upsertSessionRecord({
      id: meta.id,
      registry_user: registry.sessions[meta.id].ownerId || "",
      label: registry.sessions[meta.id].label || null,
      credentials_path: registry.sessions[meta.id].credentialsPath || null,
      webhook_url:
        registry.sessions[meta.id].webhookUrl === ""
          ? null
          : registry.sessions[meta.id].webhookUrl || null,
      webhook_secret: registry.sessions[meta.id].webhookSecret || null,
      session_profile: Array.isArray(registry.sessions[meta.id].sessionProfile)
        ? JSON.stringify(registry.sessions[meta.id].sessionProfile)
        : registry.sessions[meta.id].sessionProfile ?? null,
      auto_start: registry.sessions[meta.id].autoStart !== false,
      status: registry.sessions[meta.id].status || null,
      last_connected_at: registry.sessions[meta.id].lastConnectedAt || null,
    });
  } catch {}
  return registry.sessions[meta.id];
}

export function removeSessionMeta(id) {
  if (!id) return;
  const owner = registry.sessions[id]?.ownerId || null;
  delete registry.sessions[id];
  void saveRegistry();
  try {
    notifySessionsChanged(owner);
  } catch {}
  try {
    void removeSessionRecord(id);
  } catch {}
}

export function listSessionMeta() {
  return Object.values(registry.sessions);
}

export function getSessionMeta(id) {
  return registry.sessions[id] || null;
}

async function syncJsonToDb(jsonObj, { allowDeletes = true } = {}) {
  return withSyncLock(async () => {
    try {
      const desired = jsonObj?.sessions || {};
      const dbRows = await listSessionRecords();

      const records = Object.entries(desired).map(([id, v]) => {
        const norm = shallowNormalizeSession({ ...v, id });
        registry.sessions[id] = norm;
        return {
          id,
          registry_user: norm.ownerId || "",
          label: norm.label || null,
          credentials_path: norm.credentialsPath || null,
          webhook_url: norm.webhookUrl === "" ? null : norm.webhookUrl || null,
          webhook_secret: norm.webhookSecret || null,
          session_profile: Array.isArray(norm.sessionProfile)
            ? JSON.stringify(norm.sessionProfile)
            : norm.sessionProfile ?? null,
          auto_start: norm.autoStart !== false,
          status: norm.status || null,
          last_connected_at: norm.lastConnectedAt || null,
        };
      });

      if (records.length) {
        await Promise.all(records.map((r) => upsertSessionRecord(r)));
      }

      if (allowDeletes) {
        const desiredIds = new Set(Object.keys(desired));
        for (const r of dbRows) {
          if (!desiredIds.has(r.id)) {
            try {
              await removeSessionRecord(r.id);
            } catch {}
            delete registry.sessions[r.id];
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, "syncJsonToDb failed");
    }
  });
}

async function pollDbAndSyncToFile() {
  return withSyncLock(async () => {
    try {
      const rows = await listSessionRecords();
      let changed = false;

      for (const r of rows) {
        const prev = registry.sessions[r.id] || {};
        const merged = {
          id: r.id,
          label: r.label || prev.label || r.id,
          autoStart:
            (typeof r.auto_start === "boolean"
              ? r.auto_start
              : prev.autoStart) !== false,
          webhookUrl: r.webhook_url || prev.webhookUrl || "",
          webhookSecret: r.webhook_secret || prev.webhookSecret || "",
          sessionProfile: (() => {
            try {
              return r.session_profile
                ? JSON.parse(r.session_profile)
                : prev.sessionProfile;
            } catch {
              return prev.sessionProfile;
            }
          })(),
          createdAt: prev.createdAt || Date.now(),
          ownerId: r.registry_user || prev.ownerId || null,
          credentialsPath: r.credentials_path || prev.credentialsPath || null,
          status: r.status || prev.status,
          lastConnectedAt: r.last_connected_at || prev.lastConnectedAt,
        };
        const before = JSON.stringify(prev);
        const after = JSON.stringify(merged);
        if (before !== after) {
          registry.sessions[r.id] = merged;
          changed = true;
        }
      }
      for (const id of Object.keys(registry.sessions)) {
        if (!rows.find((r) => r.id === id)) {
          delete registry.sessions[id];
          changed = true;
        }
      }
      if (changed) await saveRegistry();
      if (changed) notifySessionsChanged();
    } catch (e) {
      logger.error({ err: e }, "pollDbAndSyncToFile failed");
    }
  });
}

export function startRegistrySync({ dbPollIntervalMs = 5000 } = {}) {
  if (!fsWatchInitialized) {
    (async () => {
      try {
        await ensureDir(DATA_DIR);
        if (!fs.existsSync(SESS_FILE)) await saveRegistry();

        let debounceTimer = null;
        fs.watch(SESS_FILE, { persistent: false }, async () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            try {
              const raw = await fsp.readFile(SESS_FILE, "utf8");
              if (raw === lastSavedContent) return;
              const json = JSON.parse(raw || "{}");
              if (!json.sessions || typeof json.sessions !== "object") return;
              await syncJsonToDb(json, { allowDeletes: true });
            } catch {}
          }, 200);
        });
        fsWatchInitialized = true;
      } catch (e) {
        logger.warn({ err: e }, "fs.watch failed for session registry");
      }
    })();
  }

  try {
    if (dbPollTimer) clearInterval(dbPollTimer);
    dbPollTimer = setInterval(() => {
      void pollDbAndSyncToFile();
    }, Math.max(1000, Number(dbPollIntervalMs) || 5000));
  } catch {}
}

export function stopRegistrySync() {
  try {
    if (dbPollTimer) clearInterval(dbPollTimer);
    dbPollTimer = null;
  } catch {}
}
