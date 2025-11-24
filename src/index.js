import http from "http";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import YAML from "yaml";

import { config } from "./config.js";
import { logger, startupLogger } from "./logger.js";
import { errorHandler } from "./middleware/error.js";
import pkg from "../package.json" with { type: "json" };

import {
  initDatabase,
  runMigrations,
  syncAdminFromEnv,
} from "./database/index.js";

import sessions from "./routes/sessions.js";
import messagesSending from "./routes/messages.sending.js";
import messagesActions from "./routes/messages.actions.js";
import chats from "./routes/chats.js";
import webhooks from "./routes/webhooks.js";
import authRouter, {
  DOCS_COOKIE_BASE_OPTIONS,
  DOCS_COOKIE_NAME,
} from "./routes/auth.js";
import ui, { getMinifiedHtml } from "./routes/ui.js";
import profiles from "./routes/profiles.js";
import groups from "./routes/groups.js";
import servers from "./routes/servers.js";
import miscs from "./routes/miscs.js";

import { loadRegistry, startRegistrySync } from "./whatsapp/sessionRegistry.js";
import { bootstrapSessions } from "./whatsapp/baileysClient.js";
import { findUserByApiKey } from "./database/models/userRepo.js";
import { apiKeyAuth } from "./middleware/auth.js";
import { dynamicRateLimit } from "./middleware/ratelimit.js";
import { antiSpam } from "./middleware/antispam.js";
import {
  registerRuntimeServers,
  closeRegisteredServers,
} from "./runtime/serverLifecycle.js";
import { CODES } from "./utils/code.js";

const app = express();
app.use(
  compression({
    threshold: 0,
  })
);
app.set("logger", logger);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPENAPI_PATH = path.join(__dirname, "./ui/openapi.yaml");
const openapiCache = { mtimeMs: 0, doc: null };
let openapiWarned = false;
const loadOpenapiCached = () => {
  try {
    const stat = fs.statSync(OPENAPI_PATH);
    if (!openapiCache.doc || openapiCache.mtimeMs !== stat.mtimeMs) {
      const raw = fs.readFileSync(OPENAPI_PATH, "utf8");
      openapiCache.doc = YAML.parse(raw);
      openapiCache.mtimeMs = stat.mtimeMs;
    }
    openapiWarned = false;
    return openapiCache.doc;
  } catch (err) {
    if (!openapiWarned) {
      logger.warn(
        { err: err?.message },
        "OpenAPI document is not available; /docs will show a placeholder"
      );
      openapiWarned = true;
    }
    return null;
  }
};

const CODE_TABLE_DATA = CODES.map(
  ({ app_code, app_name, message, http_status, category }) => ({
    app_code,
    app_name,
    message,
    http_status,
    category,
  })
);
const DOCS_COOKIE_CLEAR_OPTIONS = {
  ...DOCS_COOKIE_BASE_OPTIONS,
  maxAge: 0,
};

const parseCookies = (header = "") => {
  const out = {};
  String(header || "")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .forEach((chunk) => {
      const idx = chunk.indexOf("=");
      if (idx === -1) return;
      const key = chunk.slice(0, idx).trim();
      const value = chunk.slice(idx + 1).trim();
      out[key] = decodeURIComponent(value);
    });
  return out;
};

const escapeHtml = (input = "") => {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const normalizeAppPath = (value, fallback = "/docs") => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  try {
    const url = new URL(raw, "http://warest.local");
    const normalized = `${url.pathname || ""}${url.search || ""}${
      url.hash || ""
    }`;
    if (normalized.startsWith("/")) return normalized || fallback;
  } catch {
    if (raw.startsWith("/")) return raw;
  }
  return fallback;
};

const wantsHtml = (req) => {
  const accept = String(req.headers?.accept || "");
  if (!accept) return req.method === "GET";
  return accept.includes("text/html") || accept.includes("*/*");
};

const readDocsApiKey = (req) => {
  try {
    const cookies = parseCookies(req.headers?.cookie || "");
    return cookies[DOCS_COOKIE_NAME] || "";
  } catch {
    return "";
  }
};

const readApiKeyFromHeaders = (req) => {
  const headerKey = String(req.headers?.["x-warest-api-key"] || "").trim();
  if (headerKey) return headerKey;
  const auth = String(req.headers?.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
};

const buildLoginRedirectPath = (req, reason = "") => {
  try {
    const nextUrl = req.originalUrl || req.url || "/docs";
    const params = new URLSearchParams({ next: nextUrl });
    if (reason) params.set("reason", reason);
    return `/login?${params.toString()}`;
  } catch {
    return "/login";
  }
};

const docsAccessGuard = async (req, res, next) => {
  try {
    const headerKey = readApiKeyFromHeaders(req);
    const cookieKey = readDocsApiKey(req);
    const apiKey = headerKey || cookieKey;
    if (!apiKey) {
      return res.status(401).json({
        error: "LOGIN_REQUIRED",
        login: buildLoginRedirectPath(req),
      });
    }
    const user = await findUserByApiKey(apiKey);
    if (!user) {
      if (cookieKey) {
        res.clearCookie(DOCS_COOKIE_NAME, DOCS_COOKIE_CLEAR_OPTIONS);
      }
      return res.status(401).json({
        error: "LOGIN_REQUIRED",
        login: buildLoginRedirectPath(req),
      });
    }
    req.docsUser = user;
    req.docsApiKey = apiKey;
    res.locals.docsAuth = {
      apiKey,
      username: user.username,
      role: user.is_admin ? "admin" : "user",
    };
    return next();
  } catch (err) {
    logger.warn({ err: err?.message }, "Docs access failed");
    return res.status(500).json({ error: "DOCS_ACCESS_FAILED" });
  }
};

const ALLOWED_ORIGINS = config.allowedOrigins || [];
const ALLOW_ALL_ORIGINS = !!config.allowAllOrigins;
const ORIGIN_SET = new Set(ALLOWED_ORIGINS);
const CSP_CONNECT_ORIGINS = ALLOW_ALL_ORIGINS ? ["*"] : ALLOWED_ORIGINS;
const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (ALLOW_ALL_ORIGINS) return true;
  return ORIGIN_SET.has(origin);
};
const buildOriginValidator =
  (context) =>
  (origin, cb = () => {}) => {
    if (isOriginAllowed(origin)) return cb(null, true);
    const err = new Error(`CORS not allowed: ${origin}`);
    err.data = { code: 403, context };
    return cb(err, false);
  };
const corsOriginValidator = buildOriginValidator("http");

logger.debug(
  { timezone: config.timezone, tzEnv: process.env.TZ },
  "Using configured timezone"
);

const corsOptions = {
  origin: corsOriginValidator,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-WAREST-API-KEY", "Authorization"],
  credentials: true,
  maxAge: 86400,
};
const corsMiddleware = cors(corsOptions);
app.use(corsMiddleware);
app.options("*", corsMiddleware);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        "connect-src": [
          "'self'",
          "ws:",
          "wss:",
          "https://nominatim.openstreetmap.org",
          ...CSP_CONNECT_ORIGINS,
        ],
        "img-src": [
          "'self'",
          "data:",
          "blob:",
          "https://unpkg.com",
          "https://*.tile.openstreetmap.org",
          "https://tile.openstreetmap.org",
          "https://*.openstreetmap.org",
          "https://*.whatsapp.net",
          "https://*.fbcdn.net",
          "https://pps.whatsapp.net",
          "https://mmg.whatsapp.net",
        ],
        "style-src": ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
      },
    },
  })
);

const RAW_MESSAGE_PATHS = [
  "/api/v1/messages/send/file",
  "/api/v1/messages/send/media",
  "/api/v1/messages/send/audio",
  "/api/v1/messages/send/document",
  "/api/v1/messages/send/sticker",
  "/api/v1/messages/send/gif",
];

app.use((req, res, next) => {
  try {
    const path = req.path || req.url || "";
    if (typeof path === "string") {
      if (RAW_MESSAGE_PATHS.some((prefix) => path.startsWith(prefix))) {
        return next();
      }
      if (path.startsWith("/api/v1/messages/send/")) {
        const lim = Number(config.uploadLimits?.jsonMessagingMb || 1000);
        return express.json({ limit: `${lim}mb` })(req, res, next);
      }
    }
  } catch {}
  return express.json({ limit: "2mb" })(req, res, next);
});

app.get("/docs/openapi.yaml", docsAccessGuard, (req, res) => {
  fs.readFile(OPENAPI_PATH, "utf8", (err, data) => {
    if (err) {
      return res.status(404).type("text/plain").send("OpenAPI spec not found");
    }
    return res.type("application/yaml; charset=utf-8").send(data);
  });
});

app.get("/docs/openapi.json", docsAccessGuard, (req, res) => {
  const doc = loadOpenapiCached();
  if (!doc) {
    return res.status(503).json({ error: "OpenAPI spec not available" });
  }
  const spec = JSON.parse(JSON.stringify(doc));
  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || req.protocol || "http";
  const fallbackHost = `${config.host || "localhost"}:${config.port || 7308}`;
  const host = forwardedHost || req.get("host") || fallbackHost;
  const normalize = (url = "") => url.replace(/\/+$/, "");
  const servers = [];
  if (proto && host) {
    servers.push({
      url: `${proto}://${host}`,
      description: "Current server (auto-detected)",
    });
  }
  const defaultLocal = `http://localhost:${config.port || 7308}`;
  if (!servers.some((s) => normalize(s.url) === normalize(defaultLocal))) {
    servers.push({
      url: defaultLocal,
      description: "Local default (localhost)",
    });
  }
  const existing = Array.isArray(spec.servers) ? spec.servers : [];
  for (const entry of existing) {
    if (!entry?.url) continue;
    if (servers.some((s) => normalize(s.url) === normalize(entry.url)))
      continue;
    servers.push(entry);
  }
  spec.servers = servers;
  return res.json(spec);
});

app.get("/docs/code-table.json", docsAccessGuard, (req, res) => {
  res.json(CODE_TABLE_DATA);
});
app.use("/api/auth", authRouter);

const publicDir = path.join(__dirname, "../data/public");
app.use(
  express.static(publicDir, {
    maxAge: "1d",
    etag: true,
    immutable: false,
  })
);

app.get("/login", async (req, res, next) => {
  try {
    const html = await getMinifiedHtml("login.html");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
});

app.get("/docs", async (req, res, next) => {
  try {
    const html = await getMinifiedHtml("docs.html");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
});

app.use("/", ui);

app.use("/api/v1/server", servers);

app.use("/api/v1/session", sessions);
app.use("/api/v1/profile", profiles);
app.use("/api/v1", groups);
app.use("/api/v1/misc", miscs);
app.use(
  "/api/v1/messages",
  apiKeyAuth("user"),
  dynamicRateLimit(),
  antiSpam(),
  messagesSending,
  messagesActions
);

app.use(
  "/api/v1/chats",
  apiKeyAuth("user"),
  dynamicRateLimit(),
  antiSpam(),
  chats
);

app.use("/api/webhooks", webhooks);

app.use(errorHandler);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: buildOriginValidator("socket.io"),
    methods: ["GET", "POST"],
    allowedHeaders: ["X-WAREST-API-KEY", "Authorization"],
  },
});
app.set("io", io);
globalThis.__io = io;
registerRuntimeServers({ server, io });

io.use(async (socket, next) => {
  try {
    const rawAuth =
      socket.handshake.auth?.apiKey || socket.handshake.auth?.warestApiKey;
    const rawHdr = socket.handshake.headers["x-warest-api-key"];
    let key = String(rawAuth || rawHdr || "").trim();
    if (!key) {
      const authz = String(socket.handshake.headers["authorization"] || "");
      for (const prefix of ["Bearer ", "Token ", "APIKey "]) {
        if (authz.startsWith(prefix)) {
          key = authz.slice(prefix.length).trim();
          break;
        }
      }
    }

    if (!key) {
      const err = new Error("Missing X-WAREST-API-KEY");
      err.data = { code: 401, message: "Missing X-WAREST-API-KEY" };
      return next(err);
    }

    const user = await findUserByApiKey(key);
    if (!user) {
      const err = new Error("Unauthorized");
      err.data = { code: 401, message: "Invalid X-WAREST-API-KEY" };
      return next(err);
    }

    socket.data.isAdmin = !!user.is_admin;
    socket.data.role = socket.data.isAdmin ? "admin" : "user";
    socket.data.apiKey = key;
    socket.data.id_registry = user.registry;

    return next();
  } catch {
    const err = new Error("Unauthorized");
    err.data = { code: 401, message: "Invalid X-WAREST-API-KEY" };
    return next(err);
  }
});

io.on("connection", async (socket) => {
  try {
    const reg = socket.data?.id_registry;
    if (reg) socket.join(`registry:${reg}`);
  } catch {}
  socket.emit("welcome", {
    role: socket.data.role,
    isAdmin: !!socket.data.isAdmin,
    version: pkg.version,
    registry: socket.data?.id_registry || null,
  });
  socket.on("join", ({ room }) => socket.join(room));
});

(async () => {
  try {
    await initDatabase();
    await runMigrations();
    await syncAdminFromEnv();
    await loadRegistry();
    startRegistrySync();

    await bootstrapSessions(io);

    let hostDisplay;
    if (config.publicUrl) {
      hostDisplay = config.publicUrl.replace(/\/$/, "");

      const hasPort = /:\d+$/.test(hostDisplay);

      if (!hasPort) {
        hostDisplay = `${hostDisplay}:${config.port}`;
      }
    } else {
      const baseHost = config.host === "0.0.0.0" ? "localhost" : config.host;

      hostDisplay = `http://${baseHost}:${config.port}`;
    }

    server.listen(config.port, config.host, () => {
      startupLogger.info(`UI:    ${hostDisplay}/`);
      startupLogger.info(`Docs:  ${hostDisplay}/docs`);
      startupLogger.info(`WA API listening on ${hostDisplay}/api/v1`);
    });
  } catch (e) {
    logger.error(e, "Fatal during bootstrap");
    process.exit(1);
  }
})();

const shutdown = (signal) => () => {
  logger.info(`${signal} received, shutting down...`);
  closeRegisteredServers()
    .catch((err) => logger.warn({ err }, "Graceful shutdown failed"))
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught Exception");
});
