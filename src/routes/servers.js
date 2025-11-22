import express from "express";
import os from "node:os";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { performance } from "node:perf_hooks";

import { apiKeyAuth } from "../middleware/auth.js";
import { dynamicRateLimit } from "../middleware/ratelimit.js";
import { antiSpam } from "../middleware/antispam.js";
import { send } from "../utils/code.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import pkg from "../../package.json" with { type: "json" };
import { listSessions } from "../whatsapp/baileysClient.js";
import { createCacheStore } from "../drivers/cache.js";
import { storage } from "../drivers/storage.js";
import { getDb } from "../database/models/db.js";
import {
  getAppTimezone,
  getTimezoneLocale,
  formatDateInTimezone,
  formatIsoInTimezone,
  normalizeTimezone as normalizeTimezoneInput,
} from "../utils/timezone.js";
import { closeRegisteredServers } from "../runtime/serverLifecycle.js";

const router = express.Router();

const SERVICE_NAME =
  (process.env.WAREST_SERVER_NAME || "").trim() || "Warest API";
const SERVICE_VERSION = pkg.version || "1.0.0";
const DEFAULT_TIMEZONE = getAppTimezone();
const DEFAULT_LOCALE = getTimezoneLocale();

const CPU_SAMPLE_INTERVAL_MS = 15_000;
const CPU_HISTORY_RETENTION_SEC = 30 * 24 * 60 * 60;
const CPU_HISTORY = [];
let cpuSamplerStarted = false;
let lastCpuTotals = null;

const IO_SAMPLE_PATH =
  process.platform === "linux" ? "/proc/diskstats" : null;
let lastIoSample = null;

const PERIOD_SECONDS = {
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

const INTERVAL_SECONDS = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
};

const MIN_RESTART_DELAY_MS = 1500;
const DEFAULT_RESTART_DELAY_MS = 4000;
const MAX_RESTART_DELAY_MS = 30 * 60 * 1000;
const RESTART_SCHEDULE_FILE = path.join(
  process.cwd(),
  "data",
  "restart-schedule.json"
);
const SCHEDULE_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const NODEMON_TOUCH_FILES = [
  path.join(process.cwd(), "package.json"),
  path.join(process.cwd(), "src", "index.js"),
];
const NODEMON_SIGNAL = "SIGUSR2";
const SUPPORTS_NODEMON_SIGNAL = process.platform !== "win32";

let pendingRestartTask = null;
let scheduledRestartState = null;

const TZ_FORMATTERS = new Map();

startCpuSampler();
restoreScheduledRestart().catch((err) => {
  logger.error({ err }, "[server] Failed to restore restart scheduler");
});

router.get("/ping", async (req, res) => {
  try {
    const start = performance.now();
    await new Promise((resolve) => setImmediate(resolve));
    const latencyMs = Number((performance.now() - start).toFixed(2));
    const now = new Date();
    const serverTimeISO = formatIsoInTimezone(now);
    const result = {
      ping: "pong",
      latencyMs,
      serverTime: formatDateInTimezone(now),
      serverTimeISO,
      serverTimeUTC: now.toISOString(),
      timezone: DEFAULT_TIMEZONE,
      timezoneLocale: DEFAULT_LOCALE,
      timestamp: nowSeconds(),
    };
    return send(res, "SUCCESS", {
      message: "Server is alive",
      result,
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Unable to answer ping",
    });
  }
});

router.use(apiKeyAuth("admin"), dynamicRateLimit(), antiSpam());

router.get("/info", async (req, res) => {
  try {
    const info = await collectServerInfo();
    return send(res, "SUCCESS", {
      message: "Server information fetched",
      result: info,
    });
  } catch (err) {
    logger.error({ err }, "[server] Failed to collect server info");
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Unable to collect server information",
    });
  }
});

router.get("/healthz", async (req, res) => {
  try {
    const health = await collectHealthStatus();
    const code =
      health.status === "healthy"
        ? "SUCCESS"
        : health.status === "degraded"
        ? "PARTIAL_SUCCESS"
        : "SERVICE_UNAVAILABLE";
    return send(res, code, {
      message:
        health.status === "healthy"
          ? "All services healthy"
          : health.status === "degraded"
          ? "Some services are degraded"
          : "Critical services unavailable",
      result: health,
    });
  } catch (err) {
    logger.error({ err }, "[server] Failed to collect health status");
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Unable to collect health status",
    });
  }
});

router.get("/cpu-history", (req, res) => {
  try {
    const periodKey = (req.query?.period || "1h").toString().toLowerCase();
    const intervalKey = (req.query?.interval || "5m").toString().toLowerCase();
    const period = PERIOD_SECONDS[periodKey];
    const interval = INTERVAL_SECONDS[intervalKey];
    if (!period) {
      return send(res, "INVALID_PARAMETER", {
        message:
          "Invalid period. Allowed values: 1h, 6h, 12h, 24h, 7d, 30d",
      });
    }
    if (!interval) {
      return send(res, "INVALID_PARAMETER", {
        message: "Invalid interval. Allowed values: 1m, 5m, 15m, 30m, 1h",
      });
    }
    const history = buildCpuHistory(period, interval);
    return send(res, "SUCCESS", {
      message: history.data.length
        ? "CPU history fetched"
        : "No CPU samples collected for the requested period",
      result: {
        period: periodKey,
        interval: intervalKey,
        data: history.data,
        averageUsagePercent: history.avg,
        maxUsagePercent: history.max,
        timestamp: nowSeconds(),
      },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Unable to read CPU history",
    });
  }
});

router.get("/ready", async (req, res) => {
  try {
    const [db, cache, storageSvc, fileSystem, ffmpeg, sharp] = await Promise.all(
      [
        checkDatabaseHealth(),
        checkCacheHealth(),
        checkStorageHealth(),
        checkFileSystemHealth(),
        checkFfmpegHealth(),
        checkSharpHealth(),
      ]
    );
    const dependencies = {
      database: db.status === "ok",
      cache: cache.status === "ok",
      storage: storageSvc.status === "ok",
      messageQueue: true,
      fileSystem: fileSystem.status === "ok",
      ffmpeg: ffmpeg.status === "ok",
      sharp: sharp.status === "ok",
    };
    const ready = Object.values(dependencies).every(Boolean);
    return send(res, ready ? "SUCCESS" : "SERVICE_UNAVAILABLE", {
      message: ready
        ? "Server is ready for traffic"
        : "One or more dependencies are not ready",
      result: {
        ready,
        dependencies,
        timestamp: nowSeconds(),
      },
    });
  } catch (err) {
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Unable to determine readiness",
    });
  }
});

router.post("/restart", async (req, res) => {
  try {
    const body = req.body ?? {};
    const query = req.query ?? {};
    const delayRaw =
      body.delaySeconds ?? query.delaySeconds ?? DEFAULT_RESTART_DELAY_MS / 1000;
    const parsedDelay = Number(delayRaw);
    const delayMs = clampRestartDelay(
      Number.isFinite(parsedDelay) && parsedDelay >= 0
        ? parsedDelay * 1000
        : DEFAULT_RESTART_DELAY_MS
    );
    const reason =
      (body.reason || query.reason || "Manual restart via API").toString() ||
      "Manual restart via API";
    const scheduled = scheduleProcessRestart({
      delayMs,
      reason,
      source: "api/manual",
    });
    const runtimePreview = detectRuntimeManager();
    const message = scheduled.restartInitiated
      ? `Restart scheduled via ${runtimePreview.type} strategy`
      : "A restart is already pending";
    return send(res, scheduled.restartInitiated ? "SCHEDULED" : "NOOP", {
      message,
      result: {
        restartInitiated: scheduled.restartInitiated,
        scheduledAt: scheduled.scheduledAt,
        restartStrategy: runtimePreview.type,
        timestamp: nowSeconds(),
      },
    });
  } catch (err) {
    logger.error({ err }, "[server] Failed to schedule restart");
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Unable to schedule restart",
    });
  }
});

router.post("/restart/scheduled", async (req, res) => {
  try {
    const body = req.body ?? {};
    const query = req.query ?? {};
    const scheduleInput = (body.schedule ?? query.schedule ?? "").toString();
    if (!scheduleInput.trim()) {
      return send(res, "INVALID_PARAMETER", {
        message: "Schedule is required (HH:MM 24-hour format or 0 to cancel)",
      });
    }
    if (scheduleInput.trim() === "0") {
      const changed = await clearScheduledRestart();
      return send(res, "NOOP", {
        message: changed
          ? "Scheduled restart cancelled"
          : "No scheduled restart configured",
        result: null,
      });
    }
    const scheduleTime = scheduleInput.trim();
    if (!SCHEDULE_TIME_PATTERN.test(scheduleTime)) {
      return send(res, "INVALID_PARAMETER", {
        message: "Schedule must use HH:MM 24-hour format (e.g., 02:30)",
      });
    }
    const timezoneInput =
      (body.timezone ?? query.timezone ?? DEFAULT_TIMEZONE).toString();
    const timezone = normalizeTimezoneInput(timezoneInput);
    if (!timezone) {
      return send(res, "INVALID_PARAMETER", {
        message: "Invalid timezone provided",
      });
    }
    const state = await applyScheduledRestart(scheduleTime, timezone);
    return send(res, "SCHEDULED", {
      message: `Restart scheduled daily at ${state.scheduleTime} (${state.timezone})`,
      result: {
        scheduledRestart: state.scheduleTime,
        timezone: state.timezone,
        nextRestartAt: new Date(state.nextTimestamp).toISOString(),
        timestamp: nowSeconds(),
      },
    });
  } catch (err) {
    logger.error({ err }, "[server] Failed to set scheduled restart");
    return send(res, "INTERNAL_ERROR", {
      message: err?.message || "Unable to configure restart schedule",
    });
  }
});

function clampRestartDelay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RESTART_DELAY_MS;
  return Math.max(
    MIN_RESTART_DELAY_MS,
    Math.min(numeric, MAX_RESTART_DELAY_MS)
  );
}

function scheduleProcessRestart({
  delayMs = DEFAULT_RESTART_DELAY_MS,
  reason = "Manual restart",
  source = "api",
}) {
  if (pendingRestartTask) {
    return {
      restartInitiated: false,
      scheduledAt: pendingRestartTask.scheduledAt,
    };
  }
  const safeDelay = clampRestartDelay(delayMs);
  const scheduledAt = new Date(Date.now() + safeDelay).toISOString();
  const timer = setTimeout(() => {
    const meta = pendingRestartTask;
    pendingRestartTask = null;
    performProcessRestart(reason, source).catch((err) => {
      logger.error({ err }, "[server] Restart execution failed");
      scheduleProcessExit(1);
    });
  }, safeDelay);
  timer.unref?.();
  pendingRestartTask = {
    timer,
    scheduledAt,
    delayMs: safeDelay,
    reason,
    source,
    requestedAt: new Date().toISOString(),
  };
  return { restartInitiated: true, scheduledAt };
}

async function performProcessRestart(reason, source) {
  const runtime = detectRuntimeManager();
  logger.warn(
    {
      runtimeType: runtime.type,
      runtimeDetails: runtime.details,
      reason,
      source,
    },
    "[server] Restart requested"
  );
  await drainServersBeforeRestart();
  await executeRestartStrategy(runtime, { reason, source });
  return runtime;
}

async function drainServersBeforeRestart() {
  const started = Date.now();
  try {
    const closed = await closeRegisteredServers({ timeoutMs: 10_000 });
    logger.info(
      {
        closed,
        durationMs: Date.now() - started,
      },
      "[server] HTTP server drained before restart"
    );
    return closed;
  } catch (err) {
    logger.warn(
      { err },
      "[server] Failed to close HTTP server before restarting process"
    );
    return false;
  }
}

async function executeRestartStrategy(runtime, meta) {
  switch (runtime.type) {
    case "nodemon":
      await triggerNodemonRestart(meta);
      break;
    case "pm2":
      signalPm2ForRestart(meta);
      scheduleProcessExit(0);
      break;
    case "docker":
      signalDockerForRestart(meta);
      // Use non-zero exit code so Docker/containers configured with
      // `restart: on-failure` or similar policies reliably restart
      // the container after a manual/scheduled restart request.
      scheduleProcessExit(1);
      break;
    case "node":
    default:
      await restartViaFork(meta);
      break;
  }
  return runtime;
}

function signalPm2ForRestart(meta = {}) {
  try {
    process.send?.("shutdown");
  } catch (err) {
    logger.debug?.({ err }, "[server] Unable to notify PM2 via process.send");
  }
  logger.info(
    { source: meta.source },
    "[server] Exiting to allow PM2/system manager restart"
  );
}

async function restartViaFork(meta = {}) {
  try {
    const pid = await spawnReplacementProcess();
    logger.info(
      { pid, source: meta.source },
      "[server] Replacement process spawned successfully"
    );
    scheduleProcessExit(0);
  } catch (err) {
    logger.error(
      { err },
      "[server] Failed to spawn replacement process, forcing exit"
    );
    scheduleProcessExit(1);
  }
}

function signalDockerForRestart(meta = {}) {
  logger.info(
    {
      source: meta.source,
      hint:
        "Configure Docker restart policy or set WAREST_RUNTIME=node to spawn in-process restarts",
    },
    "[server] Exiting to allow Docker/container runtime restart"
  );
}

function spawnReplacementProcess() {
  return new Promise((resolve, reject) => {
    const execPath = process.execPath || process.argv[0];
    const args = process.argv.slice(1);
    let child;
    try {
      child = child_process.spawn(execPath, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
    } catch (err) {
      return reject(err);
    }
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
    };
    const onSpawn = () => {
      cleanup();
      child.unref?.();
      resolve(child.pid);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function scheduleProcessExit(code = 0) {
  setTimeout(() => {
    process.exit(code);
  }, 500).unref?.();
}

function detectRuntimeManager() {
  const forced =
    (process.env.WAREST_RUNTIME || process.env.WAREST_PROCESS_MANAGER || "")
      .toString()
      .trim()
      .toLowerCase();
  const allowed = new Set(["pm2", "nodemon", "docker", "node"]);
  if (forced && allowed.has(forced)) {
    return { type: forced, details: { forced: true } };
  }
  const env = process.env || {};
  if (env.pm_id != null || env.PM2_HOME || env.pm2_home) {
    return {
      type: "pm2",
      details: {
        pmId: env.pm_id ?? null,
        name: env.name || null,
      },
    };
  }
  if (looksLikeNodemon(env)) {
    return { type: "nodemon", details: null };
  }
  if (isDockerRuntime()) {
    return {
      type: "docker",
      details: { containerId: env.HOSTNAME || null },
    };
  }
  return { type: "node", details: { script: process.argv?.[1] || null } };
}

async function triggerNodemonRestart(meta = {}) {
  const parentPid = process.ppid;
  let signaled = false;
  if (parentPid && parentPid > 1 && SUPPORTS_NODEMON_SIGNAL) {
    try {
      process.kill(parentPid, NODEMON_SIGNAL);
      signaled = true;
      logger.info(
        { parentPid, source: meta.source },
        "[server] Nodemon restart signal dispatched"
      );
    } catch (err) {
      logger.warn(
        { err, parentPid },
        "[server] Failed to signal nodemon via SIGUSR2"
      );
    }
  } else if (parentPid && parentPid > 1 && !SUPPORTS_NODEMON_SIGNAL) {
    logger.debug?.(
      { parentPid },
      "[server] SIGUSR2 not supported on this platform, skipping nodemon signal"
    );
  }
  if (!signaled) {
    for (const target of NODEMON_TOUCH_FILES) {
      try {
        await touchFile(target);
        signaled = true;
        logger.info(
          { target },
          "[server] Nodemon restart triggered via file touch"
        );
        break;
      } catch (err) {
        if (err?.code === "ENOENT") continue;
        logger.warn(
          { err, target },
          "[server] Failed to touch nodemon watcher file"
        );
      }
    }
  }
  if (!signaled) {
    logger.warn(
      {},
      "[server] Unable to notify nodemon, falling back to process exit"
    );
    scheduleProcessExit(0);
  }
}

async function touchFile(target) {
  const now = new Date();
  try {
    await fsp.utimes(target, now, now);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw err;
    }
    throw err;
  }
}

function looksLikeNodemon(env) {
  if (!env) return false;
  const markers = [
    env.__daemon,
    env.__DAEMON,
    env.npm_lifecycle_script,
    env.npm_execpath,
    env.npm_config_argv,
    env._,
  ]
    .filter(Boolean)
    .map((value) => value.toString());
  return markers.some((value) => /nodemon/i.test(value));
}

let dockerRuntimeCache = null;
function isDockerRuntime() {
  if (dockerRuntimeCache != null) return dockerRuntimeCache;
  if (
    String(process.env.WAREST_RUNTIME || "")
      .toLowerCase()
      .includes("docker")
  ) {
    dockerRuntimeCache = true;
    return dockerRuntimeCache;
  }
  if (process.env.DOCKER || process.env.container) {
    dockerRuntimeCache = true;
    return dockerRuntimeCache;
  }
  try {
    if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) {
      dockerRuntimeCache = true;
      return dockerRuntimeCache;
    }
  } catch {}
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|kubepods|containerd/i.test(cgroup)) {
      dockerRuntimeCache = true;
      return dockerRuntimeCache;
    }
  } catch {}
  dockerRuntimeCache = false;
  return dockerRuntimeCache;
}

function normalizeScheduleTime(value) {
  const [hourRaw = "0", minuteRaw = "0"] = value.split(":");
  const hour = hourRaw.padStart(2, "0");
  const minute = minuteRaw.padStart(2, "0");
  return `${hour}:${minute}`;
}

async function applyScheduledRestart(scheduleTime, timezone) {
  const normalizedTime = normalizeScheduleTime(scheduleTime);
  const state = armScheduledRestart(normalizedTime, timezone);
  await persistRestartScheduleConfig({
    scheduleTime: normalizedTime,
    timezone,
  });
  return {
    scheduleTime: state.scheduleTime,
    timezone: state.timezone,
    nextTimestamp: state.nextTimestamp,
  };
}

function armScheduledRestart(scheduleTime, timezone) {
  const nextTimestamp = computeNextRestartTimestamp(scheduleTime, timezone);
  if (nextTimestamp == null) {
    throw new Error("Unable to compute next restart time");
  }
  if (scheduledRestartState?.timer) {
    clearTimeout(scheduledRestartState.timer);
  }
  const delay = Math.max(0, nextTimestamp - Date.now());
  const timer = setTimeout(() => {
    if (!scheduledRestartState) return;
    logger.info(
      { scheduleTime, timezone },
      "[server] Executing scheduled restart"
    );
    performProcessRestart(
      `Scheduled restart at ${scheduleTime} (${timezone})`,
      "api/schedule"
    ).catch((err) => {
      logger.error({ err }, "[server] Scheduled restart failed");
    });
    if (scheduledRestartState) {
      try {
        armScheduledRestart(scheduleTime, timezone);
      } catch (err) {
        logger.error({ err }, "[server] Failed to re-arm scheduled restart");
      }
    }
  }, delay);
  timer.unref?.();
  scheduledRestartState = {
    scheduleTime,
    timezone,
    nextTimestamp,
    timer,
  };
  return scheduledRestartState;
}

async function clearScheduledRestart() {
  const hadSchedule = Boolean(scheduledRestartState);
  if (scheduledRestartState?.timer) {
    clearTimeout(scheduledRestartState.timer);
  }
  scheduledRestartState = null;
  await persistRestartScheduleConfig(null);
  return hadSchedule;
}

async function persistRestartScheduleConfig(config) {
  try {
    if (!config) {
      await fsp.unlink(RESTART_SCHEDULE_FILE);
      return;
    }
    await fsp.mkdir(path.dirname(RESTART_SCHEDULE_FILE), { recursive: true });
    await fsp.writeFile(
      RESTART_SCHEDULE_FILE,
      JSON.stringify(
        {
          scheduleTime: config.scheduleTime,
          timezone: config.timezone,
        },
        null,
        2
      )
    );
  } catch (err) {
    if (err?.code === "ENOENT" && !config) {
      return;
    }
    logger.error({ err }, "[server] Failed to persist restart schedule");
  }
}

async function restoreScheduledRestart() {
  try {
    const raw = await fsp.readFile(RESTART_SCHEDULE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.scheduleTime !== "string" ||
      !SCHEDULE_TIME_PATTERN.test(parsed.scheduleTime)
    ) {
      return;
    }
    const timezone = normalizeTimezoneInput(parsed.timezone);
    if (!timezone) return;
    try {
      armScheduledRestart(parsed.scheduleTime, timezone);
      logger.info(
        {
          scheduleTime: parsed.scheduleTime,
          timezone,
        },
        "[server] Restart schedule restored"
      );
    } catch (err) {
      logger.error(
        { err },
        "[server] Failed to arm restored restart schedule"
      );
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

function computeNextRestartTimestamp(
  scheduleTime,
  timezone,
  baseDate = new Date()
) {
  const [hourRaw, minuteRaw] = scheduleTime.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const baseParts = getTimezoneParts(baseDate, timezone);
  if (!partsAreFinite(baseParts)) return null;
  const candidate = zonedTimeToUtc(
    {
      year: baseParts.year,
      month: baseParts.month,
      day: baseParts.day,
      hour,
      minute,
      second: 0,
    },
    timezone
  );
  if (candidate > Date.now()) {
    return candidate;
  }
  const tomorrow = new Date(baseDate.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowParts = getTimezoneParts(tomorrow, timezone);
  if (!partsAreFinite(tomorrowParts)) return null;
  return zonedTimeToUtc(
    {
      year: tomorrowParts.year,
      month: tomorrowParts.month,
      day: tomorrowParts.day,
      hour,
      minute,
      second: 0,
    },
    timezone
  );
}

function getTimezoneFormatter(timeZone) {
  if (!TZ_FORMATTERS.has(timeZone)) {
    TZ_FORMATTERS.set(
      timeZone,
      new Intl.DateTimeFormat(DEFAULT_LOCALE, {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  }
  return TZ_FORMATTERS.get(timeZone);
}

function getTimezoneParts(date, timeZone) {
  const formatter = getTimezoneFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function partsAreFinite(parts) {
  if (!parts) return false;
  return ["year", "month", "day"].every((key) =>
    Number.isFinite(parts[key])
  );
}

function getTimezoneOffsetMs(date, timeZone) {
  const parts = getTimezoneParts(date, timeZone);
  if (!partsAreFinite(parts)) return 0;
  const asUTC = Date.UTC(
    parts.year,
    (parts.month || 1) - 1,
    parts.day || 1,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
  return asUTC - date.getTime();
}

function zonedTimeToUtc(parts, timeZone) {
  const date = new Date(
    Date.UTC(
      parts.year,
      (parts.month || 1) - 1,
      parts.day || 1,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0
    )
  );
  const offset = getTimezoneOffsetMs(date, timeZone);
  return date.getTime() - offset;
}

async function collectServerInfo() {
  const uptimeSeconds = Math.max(0, Math.round(os.uptime()));
  const processUptimeSeconds = Math.max(0, Math.round(process.uptime()));
  const pm = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memoryUsagePercent = totalMem
    ? Number(((usedMem / totalMem) * 100).toFixed(2))
    : 0;
  const disk = await getDiskUsageSummary();
  const ioStats = await getIoStats();
  const loadAverage = os.loadavg();
  const temperature = await getTemperatureSensors();
  const sessions = await buildSessionSummary();
  const cpuInfo = summarizeCpu();
  const processCpu = summarizeProcessCpu(processUptimeSeconds, cpuInfo.cores);
  const runtime = [
    { name: "WareST API", version: SERVICE_VERSION },
    { name: "Node.js", version: process.version },
    { name: "V8", version: process.versions?.v8 || "unknown" },
  ];

  return {
    serviceName: SERVICE_NAME,
    serviceVersion: SERVICE_VERSION,
    environment: config.env || "production",
    uptimeSeconds,
    uptimeDays: formatDuration(uptimeSeconds),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
    },
    cpu: cpuInfo,
    memory: {
      totalMB: bytesToMB(totalMem),
      freeMB: bytesToMB(freeMem),
      usedMB: bytesToMB(usedMem),
      usagePercent: memoryUsagePercent,
    },
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: processUptimeSeconds,
      uptimeDays: formatDuration(processUptimeSeconds),
      memory: {
        rssMB: bytesToMB(pm.rss),
        heapTotalMB: bytesToMB(pm.heapTotal),
        heapUsedMB: bytesToMB(pm.heapUsed),
        externalMB: bytesToMB(pm.external),
        arrayBuffersMB: bytesToMB(pm.arrayBuffers || 0),
        memoryUsagePercent: totalMem
          ? Number(((pm.rss / totalMem) * 100).toFixed(2))
          : 0,
      },
      cpu: processCpu,
    },
    disk,
    loadAverage,
    temperature,
    timezone: DEFAULT_TIMEZONE,
    runtime,
    ioStats,
    sessions,
    timestamp: nowSeconds(),
  };
}

async function collectHealthStatus() {
  const [db, cache, storageSvc, fileSystem, ffmpeg, sharp] = await Promise.all([
    checkDatabaseHealth(),
    checkCacheHealth(),
    checkStorageHealth(),
    checkFileSystemHealth(),
    checkFfmpegHealth(),
    checkSharpHealth(),
  ]);

  const services = {
    database: db,
    cache,
    storage: storageSvc,
    messageQueue: "ok",
    fileSystem: fileSystem.status,
    ffmpeg: ffmpeg.status,
    sharp: sharp.status,
  };
  const statuses = [
    db.status,
    cache.status,
    storageSvc.status,
    fileSystem.status,
    ffmpeg.status,
    sharp.status,
  ];
  let status = "healthy";
  if (statuses.some((s) => s === "error")) {
    status = "unhealthy";
  } else if (statuses.some((s) => s !== "ok")) {
    status = "degraded";
  }

  return {
    status,
    serviceName: SERVICE_NAME,
    serviceVersion: SERVICE_VERSION,
    uptime: formatDuration(process.uptime()),
    services,
    timestamp: nowSeconds(),
  };
}

async function checkDatabaseHealth() {
  const client = (config?.db?.client || "sqlite").toLowerCase();
  const knex = getDb();
  const result = {
    status: "ok",
    databaseType: client,
    version: null,
  };
  const started = performance.now();
  try {
    await knex.raw("select 1 as ok");
    result.version = await resolveDatabaseVersion(knex, client);
  } catch (err) {
    result.status = "error";
    result.error = err?.message || "Database ping failed";
  } finally {
    result.latencyMs = Number((performance.now() - started).toFixed(2));
  }
  return result;
}

async function resolveDatabaseVersion(knex, client) {
  try {
    if (client === "sqlite") {
      const rows = await knex.raw("select sqlite_version() as version");
      const payload = Array.isArray(rows) ? rows[0] : rows;
      return extractVersionField(payload);
    }
    const rows = await knex.raw("select version() as version");
    return extractVersionField(rows?.rows || rows?.[0] || rows);
  } catch {
    return null;
  }
}

function extractVersionField(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) {
    return extractVersionField(payload[0]);
  }
  if (payload?.version) return payload.version;
  const keys = Object.keys(payload || {});
  for (const key of keys) {
    if (/version/i.test(key)) return payload[key];
  }
  return null;
}

async function checkCacheHealth() {
  const result = {
    status: "ok",
    cacheType: (config?.caching?.driver || "local").toLowerCase(),
    version: null,
  };
  try {
    const store = createCacheStore({ namespace: "health" });
    const key = `ping:${Date.now()}`;
    const value = Date.now();
    const ok = await store.set(key, value, 5);
    if (!ok) throw new Error("Cache write failed");
    const read = await store.get(key);
    await store.delete(key);
    if (read !== value) throw new Error("Cache read mismatch");
    result.version = store?.manager?.driver?.kind || result.cacheType;
  } catch (err) {
    result.status = "error";
    result.error = err?.message || "Cache unavailable";
  }
  return result;
}

async function checkStorageHealth() {
  const driver = storage.getDriver();
  const result = {
    status: "ok",
    storageType: driver?.driver || driver?.kind || "local",
    region: driver?.region || null,
  };
  const key = `health/${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  try {
    const { key: savedKey } = await storage.save("warest-health", {
      directory: "health-checks",
      filename: key,
      visibility: "private",
      metadata: { purpose: "health-check" },
      encrypt: false,
    });
    await storage.delete(savedKey);
  } catch (err) {
    result.status = "error";
    result.error = err?.message || "Storage unavailable";
  }
  return result;
}

async function checkFileSystemHealth() {
  try {
    const base = path.join(os.tmpdir(), "warest-health");
    await fsp.mkdir(base, { recursive: true });
    const file = path.join(base, `fs-${Date.now()}.txt`);
    await fsp.writeFile(file, "health-check");
    await fsp.readFile(file, "utf8");
    await fsp.unlink(file).catch(() => {});
    return { status: "ok" };
  } catch (err) {
    return { status: "error", error: err?.message || "File system unavailable" };
  }
}

async function checkFfmpegHealth() {
  const result = { status: "ok", binary: null };
  try {
    const ffmpegModule = await import("ffmpeg-static");
    const binary = ffmpegModule?.default || ffmpegModule;
    if (!binary) throw new Error("ffmpeg-static binary not resolved");
    await fsp.access(binary).catch(() => {});
    result.binary = binary;
  } catch (err) {
    result.status = "error";
    result.error = err?.message || "FFmpeg binary missing";
  }
  return result;
}

async function checkSharpHealth() {
  const result = { status: "ok", version: null };
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule?.default || sharpModule;
    if (typeof sharp !== "function") {
      throw new Error("sharp() factory not available");
    }
    if (sharp?.version?.sharp) {
      result.version = sharp.version.sharp;
    }
    const img = sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    }).png();
    await img.toBuffer();
  } catch (err) {
    result.status = "error";
    result.error = err?.message || "Sharp module unavailable";
  }
  return result;
}

async function buildSessionSummary() {
  try {
    const sessions = await listSessions();
    const byStatus = sessions.reduce((acc, s) => {
      const state = s.status || "unknown";
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {});
    return { total: sessions.length, byStatus };
  } catch (err) {
    return { total: 0, byStatus: {}, error: err?.message };
  }
}

function summarizeCpu() {
  const cpus = os.cpus() || [];
  if (!cpus.length) {
    return { model: "unknown", cores: 0, speedMHz: 0 };
  }
  const model = cpus[0]?.model || "unknown";
  const speedMHz = cpus.reduce((acc, cpu) => acc + (cpu.speed || 0), 0);
  return {
    model,
    cores: cpus.length,
    speedMHz: Math.round(speedMHz / cpus.length),
  };
}

function summarizeProcessCpu(uptimeSeconds, cores) {
  const usage = process.cpuUsage();
  const userMs = Math.max(0, Math.round(usage.user / 1000));
  const systemMs = Math.max(0, Math.round(usage.system / 1000));
  const totalMs = userMs + systemMs;
  const idleMs = Math.max(0, uptimeSeconds * 1000 * Math.max(1, cores) - totalMs);
  const denominator = uptimeSeconds * 1000 * Math.max(1, cores);
  const cpuUsagePercent =
    denominator > 0 ? Number(((totalMs / denominator) * 100).toFixed(2)) : 0;
  return {
    userMs,
    systemMs,
    idleMs,
    cpuUsagePercent,
  };
}

async function getDiskUsageSummary() {
  const disks = await getDiskUsageRaw();
  return disks.map((disk) => ({
    mountPoint: disk.mount,
    filesystem: disk.fs,
    totalMB: bytesToMB(disk.sizeBytes),
    usedMB: bytesToMB(disk.usedBytes),
    freeMB: bytesToMB(disk.freeBytes),
    usagePercent: Number(disk.usedPercent || 0),
  }));
}

async function getDiskUsageRaw() {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      return await getWindowsDisks();
    }
    return parseDfK(await execCmd("df", ["-kP"], 3000));
  } catch {
    return [];
  }
}

async function getWindowsDisks() {
  try {
    const ps1 =
      `$ErrorActionPreference="Stop"; Get-CimInstance Win32_LogicalDisk | ` +
      `Where-Object { $_.DriveType -in 2,3 } | ` +
      `Select-Object DeviceID, FileSystem, Size, FreeSpace | ConvertTo-Json -Compress`;
    const json1 = stripBom(await runPowerShell(ps1));
    const arr1 = JSON.parse(json1);
    const list = (Array.isArray(arr1) ? arr1 : [arr1])
      .filter(Boolean)
      .map((d) => {
        const size = toNum(d.Size);
        const free = toNum(d.FreeSpace);
        const used = Math.max(size - free, 0);
        const usedPct = size ? Number(((used / size) * 100).toFixed(2)) : 0;
        return {
          mount: d.DeviceID,
          fs: d.FileSystem || "",
          sizeBytes: size,
          usedBytes: used,
          freeBytes: free,
          usedPercent: usedPct,
        };
      })
      .filter((d) => d.mount);
    if (list.length) return list;
  } catch {}

  try {
    const txt = await execCmd(
      "wmic",
      [
        "logicaldisk",
        "get",
        "DeviceID,FreeSpace,Size,FileSystem",
        "/format:csv",
      ],
      4000
    );
    return parseWindowsWmic(txt);
  } catch {}
  return [];
}

async function getTemperatureSensors() {
  if (process.platform === "linux") {
    const viaSensors = await readLinuxSensorsBinary();
    if (viaSensors.length) return viaSensors;
    const viaSysFs = await readLinuxThermalZones();
    if (viaSysFs.length) return viaSysFs;
    return [];
  }
  if (process.platform === "darwin") {
    const macTemps = await readMacTemperatureSensors();
    if (macTemps.length) return macTemps;
    return [];
  }
  if (process.platform === "win32") {
    return await readWindowsThermalSensors();
  }
  return [];
}

async function readLinuxSensorsBinary() {
  try {
    const raw = await execCmd("sensors", ["-j"], 2000);
    const data = JSON.parse(raw);
    return parseSensorPayload(data);
  } catch {
    return [];
  }
}

async function readLinuxThermalZones() {
  try {
    const base = "/sys/class/thermal";
    const entries = await fsp.readdir(base);
    const sensors = [];
    for (const name of entries) {
      if (!name.startsWith("thermal_zone")) continue;
      const zonePath = path.join(base, name);
      const type = await fsp
        .readFile(path.join(zonePath, "type"), "utf8")
        .then((v) => v.trim())
        .catch(() => name);
      const tempRaw = await fsp
        .readFile(path.join(zonePath, "temp"), "utf8")
        .catch(() => null);
      if (tempRaw == null) continue;
      const numeric = Number(tempRaw) / 1000;
      if (!Number.isFinite(numeric)) continue;
      sensors.push({
        sensor: type || name,
        celsius: Number(numeric.toFixed(2)),
      });
    }
    return sensors;
  } catch {
    return [];
  }
}

async function readWindowsThermalSensors() {
  const script = `
$ErrorActionPreference="Stop";
$data = Get-WmiObject -Namespace root\\wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object Name,CurrentTemperature;
if (-not $data) {
  $data = Get-CimInstance -Namespace root\\wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object Name,CurrentTemperature;
}

async function readMacTemperatureSensors() {
  const fromOsxCpuTemp = await runOsxCpuTempBinary();
  if (fromOsxCpuTemp.length) return fromOsxCpuTemp;
  const fromPowermetrics = await runPowermetricsSampler();
  if (fromPowermetrics.length) return fromPowermetrics;
  return [];
}

async function runOsxCpuTempBinary() {
  try {
    const output = stripBom(await execCmd("osx-cpu-temp", [], 1500));
    const match = output.match(/([\d.]+)\s*°?C/i);
    if (!match) return [];
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return [];
    return [{ sensor: "CPU", celsius: Number(value.toFixed(2)) }];
  } catch {
    return [];
  }
}

async function runPowermetricsSampler() {
  try {
    const output = stripBom(
      await execCmd("powermetrics", ["--samplers", "smc", "-n", "1"], 5000)
    );
    const sensors = [];
    const dieMatch = output.match(/CPU die temperature:\s+([\d.]+)\s*C/i);
    if (dieMatch) {
      sensors.push({
        sensor: "CPU die",
        celsius: Number(Number(dieMatch[1]).toFixed(2)),
      });
    }
    const socMatch = output.match(/SoC temperature:\s+([\d.]+)\s*C/i);
    if (socMatch) {
      sensors.push({
        sensor: "SoC",
        celsius: Number(Number(socMatch[1]).toFixed(2)),
      });
    }
    return sensors;
  } catch {
    return [];
  }
}
$data | ConvertTo-Json -Compress
`;
  try {
    const result = stripBom(await runPowerShell(script));
    if (!result) return [];
    const payload = JSON.parse(result);
    const arr = Array.isArray(payload) ? payload : [payload];
    return arr
      .filter((item) => typeof item?.CurrentTemperature === "number")
      .map((item) => ({
        sensor: item.Name || "CPU",
        celsius: Number(
          (item.CurrentTemperature / 10 - 273.15).toFixed(2)
        ),
      }))
      .filter((entry) => Number.isFinite(entry.celsius));
  } catch {
    return [];
  }
}

function parseSensorPayload(data) {
  const sensors = [];
  const visit = (node, path = []) => {
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === "object") {
          if (key.toLowerCase().includes("temp") && value.temp1_input != null) {
            sensors.push({
              sensor: [...path, key].join(" "),
              "â„ƒ": Number(Number(value.temp1_input).toFixed(2)),
            });
          } else {
            visit(value, [...path, key]);
          }
        }
      }
    }
  };
  visit(data);
  return sensors;
}

async function getIoStats() {
  if (process.platform === "linux" && IO_SAMPLE_PATH) {
    try {
      const content = await fsp.readFile(IO_SAMPLE_PATH, "utf8");
      const totals = parseLinuxDiskstats(content);
      const now = Date.now();
      if (!lastIoSample) {
        lastIoSample = { ...totals, at: now };
        return { readMBps: 0, writeMBps: 0 };
      }
      const elapsed = (now - lastIoSample.at) / 1000;
      if (elapsed <= 0) {
        lastIoSample = { ...totals, at: now };
        return { readMBps: 0, writeMBps: 0 };
      }
      const readDiff = Math.max(0, totals.readMB - lastIoSample.readMB);
      const writeDiff = Math.max(0, totals.writeMB - lastIoSample.writeMB);
      lastIoSample = { ...totals, at: now };
      return {
        readMBps: Number((readDiff / elapsed).toFixed(2)),
        writeMBps: Number((writeDiff / elapsed).toFixed(2)),
      };
    } catch {
      return { readMBps: null, writeMBps: null };
    }
  }
  if (process.platform === "darwin") {
    return await getMacIoStats();
  }
  if (process.platform === "win32") {
    return await getWindowsIoStats();
  }
  return { readMBps: null, writeMBps: null };
}

async function getWindowsIoStats() {
  const script = `
$ErrorActionPreference="Stop";
$counters = Get-Counter -Counter "\\\\LogicalDisk(_Total)\\\\Disk Read Bytes/sec","\\\\LogicalDisk(_Total)\\\\Disk Write Bytes/sec" -SampleInterval 1 -MaxSamples 2;
$latest = $counters.CounterSamples | Select-Object -Last 2;
$read = ($latest | Where-Object { $_.Path -like "*Read Bytes/sec" } | Select-Object -Last 1).CookedValue;
$write = ($latest | Where-Object { $_.Path -like "*Write Bytes/sec" } | Select-Object -Last 1).CookedValue;
[pscustomobject]@{ read = $read; write = $write } | ConvertTo-Json -Compress
`;
  try {
    const raw = stripBom(await runPowerShell(script));
    const parsed = JSON.parse(raw);
    const read = Number(parsed?.read) || 0;
    const write = Number(parsed?.write) || 0;
    return {
      readMBps: Number((read / (1024 * 1024)).toFixed(2)),
      writeMBps: Number((write / (1024 * 1024)).toFixed(2)),
    };
  } catch {
    return { readMBps: null, writeMBps: null };
  }
}

async function getMacIoStats() {
  const scriptArgs = ["-d", "-w", "1", "2"];
  try {
    const output = stripBom(await execCmd("iostat", scriptArgs, 5000));
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let sampleLine = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (/^(disk|Device)/i.test(line)) {
        break;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 3 && parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) {
        sampleLine = parts;
        break;
      }
    }
    if (!sampleLine) {
      return { readMBps: null, writeMBps: null };
    }
    let totalMbPerSec = 0;
    for (let i = 2; i < sampleLine.length; i += 3) {
      const value = Number(sampleLine[i]);
      if (Number.isFinite(value)) {
        totalMbPerSec += value;
      }
    }
    const half = Number(((totalMbPerSec / 2) || 0).toFixed(2)); 
    return {
      readMBps: half,
      writeMBps: half,
    };
  } catch {
    return { readMBps: null, writeMBps: null };
  }
}

function parseLinuxDiskstats(text) {
  const lines = text.trim().split(/\r?\n/);
  let readSectors = 0;
  let writeSectors = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) continue;
    const name = parts[2];
    if (!isBlockDevice(name)) continue;
    readSectors += Number(parts[5]) || 0;
    writeSectors += Number(parts[9]) || 0;
  }
  const bytesPerSector = 512;
  return {
    readMB: (readSectors * bytesPerSector) / (1024 * 1024),
    writeMB: (writeSectors * bytesPerSector) / (1024 * 1024),
  };
}

function isBlockDevice(name) {
  if (!name) return false;
  if (/^(loop|ram|fd)/.test(name)) return false;
  return /^(sd|vd|xvd|nvme\d+n\d+|mmcblk\d+)/.test(name);
}

function buildCpuHistory(periodSeconds, intervalSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - periodSeconds;
  const filtered = CPU_HISTORY.filter((sample) => sample.timestamp >= since);
  if (!filtered.length) {
    return { data: [], avg: 0, max: 0 };
  }
  const buckets = new Map();
  for (const sample of filtered) {
    const bucketTs =
      Math.floor(sample.timestamp / intervalSeconds) * intervalSeconds;
    if (!buckets.has(bucketTs)) {
      buckets.set(bucketTs, []);
    }
    buckets.get(bucketTs).push(sample.usagePercent);
  }
  const data = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, values]) => ({
      timestamp,
      usagePercent: Number(
        (values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2)
      ),
    }));
  const avg =
    data.length > 0
      ? Number(
          (
            data.reduce((sum, v) => sum + v.usagePercent, 0) / data.length
          ).toFixed(2)
        )
      : 0;
  const max = data.reduce(
    (acc, curr) => Math.max(acc, curr.usagePercent),
    0
  );
  return { data, avg, max };
}

function startCpuSampler() {
  if (cpuSamplerStarted) return;
  cpuSamplerStarted = true;
  captureCpuUsagePercent();
  setTimeout(() => collectCpuSample(), 1000).unref?.();
  setInterval(() => collectCpuSample(), CPU_SAMPLE_INTERVAL_MS).unref?.();
}

function collectCpuSample() {
  const usage = captureCpuUsagePercent();
  if (usage == null) return;
  const ts = Math.floor(Date.now() / 1000);
  CPU_HISTORY.push({ timestamp: ts, usagePercent: usage });
  const cutoff = ts - CPU_HISTORY_RETENTION_SEC;
  while (CPU_HISTORY.length && CPU_HISTORY[0].timestamp < cutoff) {
    CPU_HISTORY.shift();
  }
}

function captureCpuUsagePercent() {
  const cpus = os.cpus() || [];
  if (!cpus.length) return null;
  const totals = cpus.reduce(
    (acc, cpu) => {
      acc.idle += cpu.times.idle;
      acc.total +=
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.irq +
        cpu.times.idle;
      return acc;
    },
    { idle: 0, total: 0 }
  );
  if (!lastCpuTotals) {
    lastCpuTotals = totals;
    return null;
  }
  const idleDiff = totals.idle - lastCpuTotals.idle;
  const totalDiff = totals.total - lastCpuTotals.total;
  lastCpuTotals = totals;
  if (totalDiff <= 0) return null;
  const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
  return Number(usage.toFixed(2));
}


function bytesToMB(bytes) {
  return Number(((bytes || 0) / (1024 * 1024)).toFixed(2));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) return "0 seconds";
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts = [];
  let remaining = total;
  for (const [label, chunk] of units) {
    if (remaining < chunk && label !== "second") continue;
    const value =
      label === "second" && parts.length
        ? remaining
        : Math.floor(remaining / chunk);
    if (value <= 0) continue;
    parts.push(`${value} ${label}${value !== 1 ? "s" : ""}`);
    remaining -= value * chunk;
    if (parts.length === 3) break;
  }
  return parts.join(", ");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function toNum(value) {
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  const normalized = String(value || "").replace(/[^\d.-]/g, "");
  const fallback = Number(normalized);
  return Number.isFinite(fallback) ? fallback : 0;
}

function stripBom(str) {
  if (typeof str !== "string") return str;
  return str.replace(/^\uFEFF/, "");
}

function parseDfK(txt) {
  const lines = stripBom(txt).trim().split(/\r?\n/).slice(1);
  const out = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const sizeKB = parseInt(parts[1], 10) || 0;
    const usedKB = parseInt(parts[2], 10) || 0;
    const availKB = parseInt(parts[3], 10) || 0;
    const mount = parts[5];
    const size = sizeKB * 1024;
    const used = usedKB * 1024;
    const free = availKB * 1024;
    const usedPct = size ? Number(((used / size) * 100).toFixed(2)) : 0;
    out.push({
      mount,
      fs: parts[0],
      sizeBytes: size,
      usedBytes: used,
      freeBytes: free,
      usedPercent: usedPct,
    });
  }
  return out;
}

function parseWindowsWmic(csv) {
  const lines = stripBom(csv).trim().split(/\r?\n/);
  const out = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const device = parts[1];
    const fs = parts[2];
    const free = toNum(parts[3]);
    const size = toNum(parts[4]);
    const used = Math.max(size - free, 0);
    const usedPct = size ? Number(((used / size) * 100).toFixed(2)) : 0;
    out.push({
      mount: device,
      fs,
      sizeBytes: size,
      usedBytes: used,
      freeBytes: free,
      usedPercent: usedPct,
    });
  }
  return out;
}

function execCmd(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Command timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command exited with ${code}`));
      }
    });
  });
}

async function runPowerShell(script) {
  const buildArgs = (body) => [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    body,
  ];
  const candidates = [
    ["pwsh", buildArgs(script)],
    ["powershell", buildArgs(script)],
  ];
  let lastError;
  for (const [bin, args] of candidates) {
    try {
      return await execCmd(bin, args, 4000);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("PowerShell not available");
}

export default router;


