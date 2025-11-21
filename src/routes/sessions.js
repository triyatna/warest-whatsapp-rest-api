import express from "express";
import crypto from "node:crypto";
import { apiKeyAuth } from "../middleware/auth.js";
import { dynamicRateLimit } from "../middleware/ratelimit.js";
import {
  createSession,
  getSession,
  deleteSession as stopRuntime,
  getQR,
  getQrTtlHint,
  purgeCreds,
  getPairingCode,
  requestPairingCodeForSession,
} from "../whatsapp/baileysClient.js";
import {
  getSessionMeta,
  upsertSessionMeta,
  listSessionMeta,
  removeSessionMeta,
} from "../whatsapp/sessionRegistry.js";
import { preflightWebhook } from "../services/webhook.js";
import { config } from "../config.js";
import { getSessionById } from "../database/models/sessionRepo.js";
import QRCode from "qrcode";
import { send } from "../utils/code.js";
import { createCacheStore } from "../drivers/cache.js";

const router = express.Router();

router.use(apiKeyAuth("user"), dynamicRateLimit());

const devInfoCache = createCacheStore({
  namespace: "sessions:device-info",
  ttlSeconds: 15,
  name: "device-info",
});

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;
const normId = (v) => String(v || "").trim();
const toDigits = (v) => String(v || "").replace(/\D+/g, "");
const isValidId = (v) => SAFE_ID_REGEX.test(v);
const formatPairCode = (code) => {
  const raw = String(code || "")
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  if (!raw) return "";
  return raw.match(/.{1,4}/g)?.join("-") || raw;
};

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

function respondOwnershipError(res, err) {
  if (err?.status === 404) {
    return send(res, "SESSION_NOT_FOUND", {
      message: "Session not found",
      result: null,
    });
  }
  return send(res, "FORBIDDEN", {
    message: err?.message || "Forbidden",
    result: null,
  });
}

const qrImageCache = createCacheStore({
  namespace: "sessions:qr-image",
  ttlSeconds: 60,
  name: "qr-image",
});

async function qrToBase64(qrString) {
  if (!qrString) return null;
  try {
    const cached = await qrImageCache.get(qrString);
    if (cached) return cached;
    const buf = await QRCode.toBuffer(qrString, {
      width: 300,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    const b64 = Buffer.from(buf).toString("base64");
    await qrImageCache.set(qrString, b64, 60);
    return b64;
  } catch {
    return null;
  }
}

function readStr(req, keys = []) {
  for (const k of keys) {
    const v = req.query?.[k] ?? req.body?.[k] ?? req.params?.[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

function genWebhookSecret() {
  const min = 8;
  const max = 15;
  const len = min + Math.floor(Math.random() * (max - min + 1));
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function waitForQR(sessionId, { timeoutMs = 2000, stepMs = 200 } = {}) {
  const start = Date.now();
  let qr = await getQR(sessionId);
  while (!qr && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, stepMs));
    qr = await getQR(sessionId);
  }
  return qr || null;
}

async function waitForPairing(
  sessionId,
  phone,
  { timeoutMs = 3000, stepMs = 250 } = {}
) {
  const start = Date.now();
  let code = await getPairingCode(sessionId, phone);
  if (!code && phone) {
    await requestPairingCodeForSession(sessionId, phone).catch(() => {});
    code = await getPairingCode(sessionId, phone);
  }
  while (!code && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, stepMs));
    code = await getPairingCode(sessionId, phone);
  }
  return code || null;
}

router.get("/create", async (req, res) => {
  try {
    const { ownerId } = req.auth || {};
    const sessionId = normId(readStr(req, ["sessionId", "id", "session"]));

    if (!sessionId || !isValidId(sessionId)) {
      return send(res, "SESSION_REQUIRED", {
        message: "sessionId is required",
        result: null,
      });
    }

    const meta = getSessionMeta(sessionId);
    if (meta && meta.ownerId !== ownerId) {
      return send(res, "FORBIDDEN", { message: "Forbidden", result: null });
    }

    if (!meta) {
      await createSession({
        id: sessionId,
        ownerId,
        allowAutoId: false,
      });
      const qrStr = await waitForQR(sessionId, {
        timeoutMs: 2500,
        stepMs: 200,
      });
      const b64 = await qrToBase64(qrStr);
      const dataUrl = b64 ? `data:image/png;base64,${b64}` : null;
      const afterCreateMeta = getSessionMeta(sessionId) || {};
      const runtime = getSession(sessionId);
      const needsQr = !!qrStr;
      const isOpen = runtime?.status === "open";
      let statusCode = "SUCCESS";
      let message = "Session created";
      if (isOpen) {
        statusCode = "SESSION_OPEN";
        message = "Session already open";
      } else if (needsQr) {
        statusCode = "SESSION_QR_REQUIRED";
        message = "Scan the QR to continue";
      }
      return send(res, statusCode, {
        message,
        result: {
          registryUser: ownerId || "",
          sessionId,
          qrString: qrStr || null,
          qr: dataUrl,
          qrDuration: getQrTtlHint(sessionId),
          webhookUrl: afterCreateMeta.webhookUrl || "",
          webhookSecret: afterCreateMeta.webhookSecret || "",
        },
      });
    }

    try {
      await createSession({ id: sessionId, ownerId, allowAutoId: false });
    } catch {}
    const qrStr2 = await waitForQR(sessionId, { timeoutMs: 1500, stepMs: 200 });
    const b642 = await qrToBase64(qrStr2);
    const dataUrl2 = b642 ? `data:image/png;base64,${b642}` : null;
    const latest = getSessionMeta(sessionId) || meta || {};
    const runtime = getSession(sessionId);
    const needsQr = !!qrStr2;
    const isOpen = runtime?.status === "open";
    let statusCode = "SUCCESS";
    let message = "Session exists";
    if (isOpen) {
      statusCode = "SESSION_OPEN";
      message = "Session already open";
    } else if (needsQr) {
      statusCode = "SESSION_QR_REQUIRED";
      message = "Scan the QR to continue";
    }
    return send(res, statusCode, {
      message,
      result: {
        registryUser: ownerId || "",
        sessionId,
        createdAt: latest.createdAt
          ? new Date(latest.createdAt).toISOString()
          : "",
        ...(qrStr2 ? { qrString: qrStr2 } : {}),
        ...(dataUrl2
          ? { qr: dataUrl2, qrDuration: getQrTtlHint(sessionId) }
          : {}),
        webhookUrl: latest.webhookUrl || "",
        webhookSecret: latest.webhookSecret || "",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/create/pair-code", async (req, res) => {
  try {
    const { ownerId } = req.auth || {};
    const sessionId = normId(readStr(req, ["sessionId", "id", "session"]));
    let phone = normId(readStr(req, ["phone", "pair", "pairPhone"]));
    const digits = toDigits(phone);
    phone = digits;
    if (!phone) {
      return send(res, "MISSING_PARAMETER", {
        message: "phone is required",
        result: null,
      });
    }
    if (!sessionId || !isValidId(sessionId)) {
      return send(res, "SESSION_REQUIRED", {
        message: "sessionId is required",
        result: null,
      });
    }
    if (!phone) {
      return send(res, "MISSING_PARAMETER", {
        message: "phone is required",
        result: null,
      });
    }

    const meta = getSessionMeta(sessionId);
    if (meta && meta.ownerId !== ownerId) {
      return send(res, "FORBIDDEN", { message: "Forbidden", result: null });
    }

    if (!meta) {
      await createSession({
        id: sessionId,
        ownerId,
        allowAutoId: false,
        pairing: { phone },
      });
      const code =
        (await waitForPairing(sessionId, phone, { timeoutMs: 3500 })) || "";
      if (code) {
        return send(res, "SUCCESS", {
          message: "Pair code generated",
          result: {
            registryUser: ownerId || "",
            sessionId,
            pairCode: formatPairCode(code),
          },
        });
      }
      return send(res, "SESSION_LOGIN_PENDING", {
        message: "Pair code pending",
        result: {
          registryUser: ownerId || "",
          sessionId,
          pairCode: "",
        },
      });
    }

    const s = getSession(sessionId);
    if (s && s.status === "open") {
      return send(res, "SESSION_OPEN", {
        message: "Session already open",
        result: {
          registryUser: ownerId || "",
          sessionId,
          status: "open",
        },
      });
    }

    if (!s) {
      await createSession({
        id: sessionId,
        ownerId,
        allowAutoId: false,
        pairing: { phone },
      });
      const code =
        (await waitForPairing(sessionId, phone, { timeoutMs: 3500 })) || "";
      if (code) {
        return send(res, "SUCCESS", {
          message: "Pair code generated",
          result: {
            registryUser: ownerId || "",
            sessionId,
            pairCode: formatPairCode(code),
          },
        });
      }
      return send(res, "SESSION_LOGIN_PENDING", {
        message: "Pair code pending",
        result: {
          registryUser: ownerId || "",
          sessionId,
          pairCode: "",
        },
      });
    }

    let code = (await getPairingCode(sessionId, phone)) || "";
    if (!code) {
      try {
        const c = await requestPairingCodeForSession(sessionId, phone);
        code = c || "";
      } catch {}
    }
    if (!code) {
      const waited = await waitForPairing(sessionId, phone, {
        timeoutMs: 2500,
      });
      code = waited || "";
    }

    if (code) {
      return send(res, "SUCCESS", {
        message: "Pair code generated",
        result: {
          registryUser: ownerId || "",
          sessionId,
          pairCode: formatPairCode(code),
        },
      });
    }

    return send(res, "SESSION_LOGIN_PENDING", {
      message: "Pair code pending",
      result: {
        registryUser: ownerId || "",
        sessionId,
        pairCode: "",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/logout", async (req, res) => {
  try {
    const sessionId = normId(readStr(req, ["sessionId", "id", "session"]));
    if (!sessionId || !isValidId(sessionId)) {
      return send(res, "SESSION_REQUIRED", {
        message: "sessionId is required",
        result: null,
      });
    }
    try {
      assertOwner(req, sessionId);
    } catch (e) {
      return respondOwnershipError(res, e);
    }
    const steps = { runtime: false, creds: false };
    try {
      steps.runtime = await stopRuntime(sessionId);
    } catch {}
    try {
      steps.creds = !!(await purgeCreds(sessionId));
    } catch {}
    try {
      upsertSessionMeta({ id: sessionId, status: "stopped" });
    } catch {}
    return send(res, "SUCCESS", {
      message: "Logout success",
      result: { sessionId, steps },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/reconnect", async (req, res) => {
  try {
    const { ownerId } = req.auth || {};
    const sessionId = normId(readStr(req, ["sessionId", "id", "session"]));
    if (!sessionId || !isValidId(sessionId)) {
      return send(res, "SESSION_REQUIRED", {
        message: "sessionId is required",
        result: null,
      });
    }
    try {
      assertOwner(req, sessionId);
    } catch (e) {
      return respondOwnershipError(res, e);
    }
    const meta = getSessionMeta(sessionId);
    if (!meta)
      return send(res, "SESSION_NOT_FOUND", {
        message: "Session not found",
        result: null,
      });
    await stopRuntime(sessionId);
    await createSession({ id: sessionId, ownerId, allowAutoId: false });
    return send(res, "SESSION_RECONNECT_SCHEDULED", {
      message: "Reconnect scheduled",
      result: null,
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/devices", async (req, res) => {
  try {
    const sessionId = normId(readStr(req, ["sessionId", "id", "session"]));
    if (!sessionId || !isValidId(sessionId)) {
      return send(res, "SESSION_REQUIRED", {
        message: "sessionId is required",
        result: null,
      });
    }
    try {
      assertOwner(req, sessionId);
    } catch (e) {
      return respondOwnershipError(res, e);
    }

    const cacheKey = `devinfo:${sessionId}`;
    const refresh = String(req.query?.refresh || "").trim() === "1";
    if (!refresh) {
      const cached = await devInfoCache.get(cacheKey);
      if (cached)
        return send(res, "SUCCESS", { message: "Device info", result: cached });
    }

    const row = await getSessionById(sessionId);
    let profileArr = [];
    if (row && row.session_profile) {
      try {
        profileArr = JSON.parse(row.session_profile) || [];
      } catch {}
      if (!Array.isArray(profileArr)) profileArr = [];
    }

    const runtime = getSession(sessionId);
    const meJid = String(runtime?.me?.id || runtime?.me?.jid || "").trim();
    const mePhone = meJid ? meJid.split("@")[0] : "";
    const primary =
      profileArr.find(
        (p) =>
          String(p?.jid || "").trim() === meJid ||
          String((p?.phone || "").toString().split("@")[0]) === mePhone
      ) ||
      profileArr[0] ||
      {};

    let device = primary?.device;
    if (!device || String(device).toLowerCase() === "unknown")
      device = "WARest";
    let rawPhone = primary?.jid || primary?.phone || runtime?.me?.id;

    let phone = null;
    if (typeof rawPhone === "string") {
      phone = rawPhone.match(/^\d+/)?.[0] || null;
    }

    const out = {
      name: primary?.pushname || runtime?.pushName || runtime?.me?.name || null,
      phone,
      device,
    };
    await devInfoCache.set(cacheKey, out, 15);
    return send(res, "SUCCESS", { message: "Device info", result: out });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.post("/:sessionId/config", async (req, res) => {
  try {
    const sessionId = normId(req.params.sessionId);
    if (!sessionId || !isValidId(sessionId)) {
      return send(res, "SESSION_REQUIRED", {
        message: "sessionId is required",
        result: null,
      });
    }
    try {
      assertOwner(req, sessionId);
    } catch (e) {
      return respondOwnershipError(res, e);
    }

    const hasWebhookUrlField = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "webhookUrl"
    );
    const hasWebhookSecretField = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "webhookSecret"
    );
    const webhookUrl =
      typeof req.body?.webhookUrl === "string"
        ? req.body.webhookUrl.trim()
        : "";
    const webhookSecret =
      typeof req.body?.webhookSecret === "string" ? req.body.webhookSecret : "";
    const preflightVerify =
      req.body?.preflight === true || req.body?.preflightVerify === true;

    const meta = getSessionMeta(sessionId) || {};

    const patch = { id: sessionId };
    if (hasWebhookUrlField) patch.webhookUrl = webhookUrl || "";
    const providedSecret = (
      typeof webhookSecret === "string" ? webhookSecret : ""
    ).trim();
    let finalSecret = meta?.webhookSecret || "";
    let setSecret = false;
    if (hasWebhookSecretField && providedSecret.length > 0) {
      finalSecret = providedSecret;
      setSecret = true;
    } else if (hasWebhookUrlField && (webhookUrl || "").trim() !== "") {
      finalSecret = genWebhookSecret();
      setSecret = true;
    } else if (
      hasWebhookUrlField &&
      (webhookUrl || "").trim() === "" &&
      (!finalSecret || String(finalSecret).trim().length < 6)
    ) {
      finalSecret = genWebhookSecret();
      setSecret = true;
    }
    if (setSecret) patch.webhookSecret = finalSecret;

    const finalUrl = hasWebhookUrlField ? webhookUrl : meta?.webhookUrl || "";
    const secretForTest = setSecret ? finalSecret : meta?.webhookSecret || "";
    if (preflightVerify && finalUrl && secretForTest) {
      try {
        const results = await preflightWebhook({
          url: finalUrl,
          secret: secretForTest,
          sessionId,
          options: config.webhookOpts,
        });
        const ok =
          Array.isArray(results) &&
          results.length &&
          results.every((r) => r.ok);
        if (!ok) {
          return send(res, "BAD_REQUEST", {
            message: "Webhook preflight failed",
            result: { results },
          });
        }
      } catch (e) {
        return send(res, "BAD_REQUEST", {
          message: e?.message || "Webhook preflight error",
          result: null,
        });
      }
    }

    upsertSessionMeta(patch);

    const s = getSession(sessionId);
    if (s) {
      s.webhook = s.webhook || {};
      if (hasWebhookUrlField) s.webhook.url = webhookUrl || "";
      if (setSecret) s.webhook.secret = finalSecret;
    }

    return send(res, "SUCCESS", {
      message: "Config updated",
      result: {
        registryUser: req?.auth?.ownerId || "",
        sessionId,
        webhookUrl: (hasWebhookUrlField ? webhookUrl : meta?.webhookUrl) || "",
        webhookSecret:
          (setSecret
            ? finalSecret
            : meta?.webhookSecret || webhookSecret || "") || "",
      },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.get("/list", async (req, res) => {
  try {
    const { ownerId } = req.auth || {};
    const metas = (listSessionMeta?.() || []).filter(
      (m) => m.ownerId === ownerId
    );
    const items = metas.map((m) => {
      const r = getSession(m.id);
      return {
        id: m.id,
        status: r?.status || m.status || "stopped",
        me: r?.me || null,
        pushName: r?.pushName || null,
        lastConn: r?.lastConn || m.lastConnectedAt || null,
      };
    });
    return send(res, "SUCCESS", { message: "OK", result: { items } });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

router.delete("/delete", async (req, res) => {
  try {
    const sessionId = normId(readStr(req, ["sessionId", "id", "session"]));
    if (!sessionId || !isValidId(sessionId)) {
      return send(res, "SESSION_REQUIRED", {
        message: "sessionId is required",
        result: null,
      });
    }
    try {
      assertOwner(req, sessionId);
    } catch (e) {
      return respondOwnershipError(res, e);
    }

    const steps = { runtime: false, creds: false, meta: false };
    try {
      steps.runtime = await stopRuntime(sessionId);
    } catch {}
    try {
      steps.creds = !!(await purgeCreds(sessionId));
    } catch {}
    try {
      await removeSessionMeta(sessionId);
      steps.meta = true;
    } catch {}

    return send(res, "SUCCESS", {
      message: "Session deleted",
      result: { sessionId, steps },
    });
  } catch (e) {
    return send(res, "INTERNAL_ERROR", {
      message: e?.message || "Internal error",
      result: null,
    });
  }
});

export default router;
