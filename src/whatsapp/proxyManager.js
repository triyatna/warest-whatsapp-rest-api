import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";

const proxyConfig = config?.proxy || { enabled: false, pool: [] };
const rawPool = Array.isArray(proxyConfig.pool)
  ? proxyConfig.pool.filter(Boolean)
  : [];

const proxyEntries = rawPool.map((url, index) => ({
  id: `proxy-${index}`,
  url,
  display: redactProxyUrl(url),
  agent: null,
}));

const entriesById = new Map(proxyEntries.map((entry) => [entry.id, entry]));
const assignments = new Map(); // sessionId -> { proxyId, agent, url, display }
const health = new Map(); // proxyId -> { failures, cooloffUntil, lastFailureAt }
let roundRobinCursor = 0;

export const proxyPoolEnabled =
  proxyConfig.enabled && proxyEntries.length > 0;

export function acquireProxyAgent(sessionId) {
  if (!proxyPoolEnabled) return null;
  const now = Date.now();
  const sticky = assignments.get(sessionId);
  if (
    proxyConfig.stickySession &&
    sticky &&
    !isEntryCoolingDown(sticky.proxyId, now)
  ) {
    return sticky;
  }
  const entry = pickEntry(now);
  if (!entry) return null;
  const assignment = {
    proxyId: entry.id,
    agent: ensureAgent(entry),
    url: entry.url,
    display: entry.display,
  };
  assignments.set(sessionId, assignment);
  return assignment;
}

export function reportProxySuccess(sessionId) {
  if (!proxyPoolEnabled) return;
  const assignment = assignments.get(sessionId);
  if (!assignment) return;
  const record = health.get(assignment.proxyId);
  if (record) {
    record.failures = 0;
    record.cooloffUntil = 0;
    health.set(assignment.proxyId, record);
  }
}

export function reportProxyFailure(sessionId, meta = {}) {
  if (!proxyPoolEnabled) return;
  const assignment = assignments.get(sessionId);
  if (!assignment) return;
  const now = Date.now();
  const record = health.get(assignment.proxyId) || {
    failures: 0,
    cooloffUntil: 0,
    lastFailureAt: 0,
  };
  record.failures += 1;
  record.lastFailureAt = now;
  if (proxyConfig.failureCooloffMs > 0) {
    const multiplier = Math.min(
      proxyConfig.failureBackoffMultiplier || 1,
      record.failures
    );
    record.cooloffUntil =
      now + proxyConfig.failureCooloffMs * Math.max(1, multiplier);
  }
  health.set(assignment.proxyId, record);
  if (
    !proxyConfig.stickySession ||
    record.failures >= (proxyConfig.rotateAfterFailures || 1)
  ) {
    assignments.delete(sessionId);
  }
}

export function releaseProxy(sessionId) {
  assignments.delete(sessionId);
}

export function getProxyDiagnostics() {
  return {
    enabled: proxyPoolEnabled,
    strategy: proxyConfig.strategy,
    poolSize: proxyEntries.length,
    stickySession: proxyConfig.stickySession,
  };
}

function ensureAgent(entry) {
  if (!entry.agent) {
    entry.agent = new HttpsProxyAgent(entry.url);
  }
  return entry.agent;
}

function pickEntry(now = Date.now()) {
  if (!proxyPoolEnabled) return null;
  const order = buildOrder();
  if (!order.length) return null;
  for (const idx of order) {
    const entry = proxyEntries[idx];
    if (!isEntryCoolingDown(entry.id, now)) {
      bumpCursor(idx);
      return entry;
    }
  }
  const fallbackIdx = order[0];
  bumpCursor(fallbackIdx);
  return proxyEntries[fallbackIdx];
}

function buildOrder() {
  if (!proxyEntries.length) return [];
  switch (proxyConfig.strategy) {
    case "round_robin":
      return buildRoundRobinOrder();
    case "random":
      return buildRandomOrder();
    default:
      return buildFailoverOrder();
  }
}

function buildRoundRobinOrder() {
  const total = proxyEntries.length;
  const order = [];
  let start = roundRobinCursor % total;
  for (let i = 0; i < total; i += 1) {
    order.push(start);
    start = (start + 1) % total;
  }
  return order;
}

function buildRandomOrder() {
  const order = buildFailoverOrder();
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function buildFailoverOrder() {
  return proxyEntries.map((_, index) => index);
}

function bumpCursor(index) {
  if (proxyConfig.strategy === "round_robin") {
    roundRobinCursor = (index + 1) % proxyEntries.length;
  }
}

function isEntryCoolingDown(proxyId, now = Date.now()) {
  const record = health.get(proxyId);
  if (!record) return false;
  return record.cooloffUntil > now;
}

function redactProxyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      const user = parsed.username ? `${parsed.username.slice(0, 1)}***` : "";
      const auth = user ? `${user}${parsed.password ? ":***" : ""}@` : "";
      return `${parsed.protocol}//${auth}${parsed.host}`;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url.replace(/\/\/([^@]+)@/, "//***@");
  }
}
