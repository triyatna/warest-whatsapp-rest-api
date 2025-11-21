import { createRequire } from "node:module";
import { once } from "node:events";
import { config } from "../config.js";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);
const DEFAULTS = {
  ttlSeconds: Math.max(
    5,
    Number(config?.caching?.defaultTtlSeconds || 120) || 120
  ),
  namespace: String(config?.caching?.namespace || "warest")
    .trim()
    .toLowerCase(),
};

const SERIALIZED_FLAG = "__warestCacheType";

const serializer = {
  encode(value) {
    if (value === undefined) return undefined;
    return JSON.stringify({ v: value }, replacer);
  },
  decode(payload) {
    if (payload == null) return undefined;
    let str;
    if (typeof payload === "string") {
      str = payload;
    } else if (Buffer.isBuffer(payload)) {
      str = payload.toString("utf8");
    } else if (typeof payload === "object" && payload.payload) {
      str = payload.payload;
    } else {
      str = String(payload);
    }
    try {
      const parsed = JSON.parse(str, reviver);
      return Object.prototype.hasOwnProperty.call(parsed, "v")
        ? parsed.v
        : parsed;
    } catch {
      return undefined;
    }
  },
  size(value) {
    const encoded = this.encode(value);
    if (!encoded) return 0;
    return Buffer.byteLength(encoded, "utf8");
  },
};

function replacer(key, value) {
  if (!value || typeof value !== "object") {
    if (typeof value === "bigint") return value.toString();
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return { [SERIALIZED_FLAG]: "Buffer", data: value.toString("base64") };
  }
  if (value instanceof Map) {
    return { [SERIALIZED_FLAG]: "Map", data: [...value.entries()] };
  }
  if (value instanceof Set) {
    return { [SERIALIZED_FLAG]: "Set", data: [...value.values()] };
  }
  if (value instanceof Date) {
    return { [SERIALIZED_FLAG]: "Date", data: value.toISOString() };
  }
  return value;
}

function reviver(key, value) {
  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, SERIALIZED_FLAG)
  ) {
    switch (value[SERIALIZED_FLAG]) {
      case "Buffer":
        return Buffer.from(value.data || "", "base64");
      case "Map":
        return new Map(Array.isArray(value.data) ? value.data : []);
      case "Set":
        return new Set(Array.isArray(value.data) ? value.data : []);
      case "Date":
        return new Date(value.data);
      default:
        return value.data;
    }
  }
  return value;
}

const sanitizeNamespace = (value) => {
  const parts = String(value || "")
    .split(":")
    .map((chunk) =>
      chunk
        .trim()
        .replace(/[^a-z0-9._-]/gi, "")
        .toLowerCase()
    )
    .filter(Boolean);
  return parts.join(":") || DEFAULTS.namespace;
};

const buildNamespace = (base, scope) =>
  sanitizeNamespace(
    [base, scope]
      .map((part) => (part ? String(part).trim() : ""))
      .filter(Boolean)
      .join(":")
  );

const seconds = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return Math.max(0, fallback);
  return num;
};

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function loadDependency(pkgName) {
  try {
    return require(pkgName);
  } catch (err) {
    const error = new Error(
      `[cache] Driver requires "${pkgName}". Install it with "npm install ${pkgName}"`
    );
    error.cause = err;
    throw error;
  }
}

class LocalCacheDriver {
  constructor(options = {}) {
    this.kind = "local";
    this.store = new Map();
    this.maxEntries = Math.max(100, Number(options.maxEntries) || 5000);
    const maxHeapMb =
      Number(options.maxHeapMb) > 0 ? Number(options.maxHeapMb) : 128;
    this.maxHeapBytes = maxHeapMb * 1024 * 1024;
    this.sweepIntervalMs = Math.max(
      5000,
      Number(options.sweepIntervalMs) || 45000
    );
    this.totalWeight = 0;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.totalWeight -= entry.weight;
      return undefined;
    }
    entry.hits += 1;
    entry.lastHit = Date.now();
    return serializer.decode(entry.payload);
  }

  async set(key, value, ttlSeconds) {
    const payload = serializer.encode(value);
    if (payload === undefined) return false;
    const expiresAt =
      ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    const weight = Buffer.byteLength(payload, "utf8");
    if (this.store.has(key)) {
      this.totalWeight -= this.store.get(key)?.weight || 0;
    }
    this.store.set(key, {
      payload,
      expiresAt,
      weight,
      hits: 0,
      storedAt: Date.now(),
      lastHit: null,
    });
    this.totalWeight += weight;
    this.trim();
    return true;
  }

  async delete(key) {
    const entry = this.store.get(key);
    const existed = this.store.delete(key);
    if (existed && entry) {
      this.totalWeight -= entry.weight || 0;
    }
    return existed;
  }

  async clearByPrefix(prefix) {
    const target = String(prefix || "");
    if (!target) return;
    for (const key of this.store.keys()) {
      if (key.startsWith(target)) {
        await this.delete(key);
      }
    }
  }

  trim() {
    const maxWeight = this.maxHeapBytes;
    while (
      this.store.size > this.maxEntries ||
      (maxWeight > 0 && this.totalWeight > maxWeight)
    ) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.store.delete(key);
        this.totalWeight -= entry.weight || 0;
      }
    }
    this.trim();
  }

  metrics() {
    return {
      driver: this.kind,
      entries: this.store.size,
      totalWeightBytes: this.totalWeight,
      maxEntries: this.maxEntries,
      maxHeapBytes: this.maxHeapBytes,
    };
  }
}

class RedisCacheDriver {
  constructor(options = {}) {
    const Redis = loadDependency("ioredis");
    this.kind = "redis";
    const baseOpts = {
      enableOfflineQueue: true,
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    };
    if (options?.url) {
      this.client = new Redis(options.url, baseOpts);
    } else {
      const redisOpts = {
        ...baseOpts,
        host: options.host || "127.0.0.1",
        port: Number(options.port || 6379),
        username: options.username || undefined,
        password: options.password || undefined,
        tls: options.tls ? {} : undefined,
        family: Number(options.family || 0) || 0,
        keyPrefix: options.keyPrefix || "",
      };
      this.client = new Redis(redisOpts);
    }
    this.ready = onceReady(this.client);
    this.client.on("error", (err) => {
      logger.warn({ err: err?.message }, "[cache] Redis error");
    });
  }

  async get(key) {
    try {
      await this.ready;
      const raw = await this.client.get(key);
      return raw == null ? undefined : serializer.decode(raw);
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Redis#get failed");
      return undefined;
    }
  }

  async set(key, value, ttlSeconds) {
    try {
      await this.ready;
      const payload = serializer.encode(value);
      if (payload === undefined) return false;
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(
          key,
          payload,
          "EX",
          Math.max(1, Math.floor(ttlSeconds))
        );
      } else {
        await this.client.set(key, payload);
      }
      return true;
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Redis#set failed");
      return false;
    }
  }

  async delete(key) {
    try {
      await this.ready;
      await this.client.del(key);
      return true;
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Redis#del failed");
      return false;
    }
  }

  async clearByPrefix(prefix) {
    try {
      await this.ready;
      const match = `${prefix}*`;
      const stream = this.client.scanStream({ match, count: 200 });
      const keys = [];
      for await (const chunk of stream) {
        if (Array.isArray(chunk)) keys.push(...chunk);
      }
      if (keys.length) {
        await this.client.del(keys);
      }
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Redis#clearByPrefix failed");
    }
  }

  metrics() {
    return {
      driver: this.kind,
      status: this.client?.status,
    };
  }
}

class MemcachedCacheDriver {
  constructor(options = {}) {
    const memjs = loadDependency("memjs");
    this.kind = "memcached";
    const servers = options.servers || "127.0.0.1:11211";
    const creds =
      options.username || options.password
        ? { username: options.username, password: options.password }
        : {};
    this.client = memjs.Client.create(servers, creds);
  }

  async get(key) {
    try {
      const { value } = await this.client.get(key);
      return value ? serializer.decode(value) : undefined;
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Memcached#get failed");
      return undefined;
    }
  }

  async set(key, value, ttlSeconds) {
    const payload = serializer.encode(value);
    if (payload === undefined) return false;
    try {
      const expires =
        ttlSeconds && ttlSeconds > 0 ? Math.max(1, Math.floor(ttlSeconds)) : 0;
      await this.client.set(key, Buffer.from(payload, "utf8"), { expires });
      return true;
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Memcached#set failed");
      return false;
    }
  }

  async delete(key) {
    try {
      await this.client.delete(key);
      return true;
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Memcached#delete failed");
      return false;
    }
  }

  // Memcached cannot delete by prefix efficiently; best effort flush.
  async clearByPrefix() {
    try {
      await this.client.flush();
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Memcached#flush failed");
    }
  }

  metrics() {
    return { driver: this.kind };
  }
}

class MongoCacheDriver {
  constructor(options = {}) {
    const { MongoClient } = loadDependency("mongodb");
    this.kind = "mongodb";
    const url = options.url || "mongodb://127.0.0.1:27017";
    this.ttlField = options.ttlField || "expireAt";
    this.client = new MongoClient(url, {
      maxPoolSize: Number(options.maxPoolSize || 5),
    });
    this.collectionName = options.collection || "cacheEntries";
    this.databaseName = options.database || "warest";
    this.ready = this.client
      .connect()
      .then(() => {
        this.collection = this.client
          .db(this.databaseName)
          .collection(this.collectionName);
        return Promise.all([
          this.collection.createIndex({ key: 1 }, { unique: true }),
          this.collection.createIndex(
            { [this.ttlField]: 1 },
            {
              expireAfterSeconds: 0,
              partialFilterExpression: { [this.ttlField]: { $type: "date" } },
            }
          ),
        ]);
      })
      .catch((err) => {
        logger.error({ err: err?.message }, "[cache] Mongo init failed");
        throw err;
      });
  }

  async get(key) {
    try {
      await this.ready;
      const doc = await this.collection.findOne({ key });
      if (!doc) return undefined;
      if (
        doc[this.ttlField] &&
        doc[this.ttlField] instanceof Date &&
        doc[this.ttlField].getTime() <= Date.now()
      ) {
        await this.collection.deleteOne({ key });
        return undefined;
      }
      return serializer.decode(doc.value);
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Mongo#get failed");
      return undefined;
    }
  }

  async set(key, value, ttlSeconds) {
    const payload = serializer.encode(value);
    if (payload === undefined) return false;
    const expireAt =
      ttlSeconds && ttlSeconds > 0
        ? new Date(Date.now() + ttlSeconds * 1000)
        : null;
    try {
      await this.ready;
      const setPayload = {
        value: payload,
        updatedAt: new Date(),
      };
      const update = expireAt
        ? { $set: { ...setPayload, [this.ttlField]: expireAt } }
        : { $set: setPayload, $unset: { [this.ttlField]: "" } };
      await this.collection.updateOne({ key }, update, { upsert: true });
      return true;
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Mongo#set failed");
      return false;
    }
  }

  async delete(key) {
    try {
      await this.ready;
      await this.collection.deleteOne({ key });
      return true;
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Mongo#delete failed");
      return false;
    }
  }

  async clearByPrefix(prefix) {
    try {
      await this.ready;
      const regex = new RegExp(`^${escapeRegex(prefix)}`);
      await this.collection.deleteMany({ key: regex });
    } catch (err) {
      logger.warn({ err: err?.message }, "[cache] Mongo#clearByPrefix failed");
    }
  }

  metrics() {
    return {
      driver: this.kind,
      db: this.databaseName,
      collection: this.collectionName,
    };
  }
}

function onceReady(client) {
  if (client.status === "ready") return Promise.resolve();
  return Promise.race([
    once(client, "ready").catch(() => {}),
    once(client, "connect").catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

function createDriver(settings = {}) {
  const driverName = (settings.driver || "local").toLowerCase();
  try {
    switch (driverName) {
      case "redis": {
        if (!settings.redis?.url && !settings.redis?.host) {
          throw new Error("WAREST_CACHE_REDIS_URL or HOST is required");
        }
        return new RedisCacheDriver(settings.redis);
      }
      case "memcached": {
        if (!settings.memcached?.servers) {
          throw new Error("WAREST_CACHE_MEMCACHED_SERVERS is required");
        }
        return new MemcachedCacheDriver(settings.memcached);
      }
      case "mongodb": {
        if (!settings.mongodb?.url) {
          throw new Error("WAREST_CACHE_MONGODB_URL is required");
        }
        return new MongoCacheDriver(settings.mongodb);
      }
      default:
        return new LocalCacheDriver(settings.local);
    }
  } catch (err) {
    logger.warn(
      { err: err?.message, driver: driverName },
      "[cache] Falling back to local cache"
    );
    return new LocalCacheDriver(settings.local);
  }
}

class CacheManager {
  constructor(settings = {}) {
    this.settings = settings;
    this.namespace = sanitizeNamespace(
      settings.namespace || DEFAULTS.namespace
    );
    this.defaultTtlSeconds = seconds(
      settings.defaultTtlSeconds,
      DEFAULTS.ttlSeconds
    );
    this.driver = createDriver(settings);
    this.inflight = new Map();
  }

  createStore(options = {}) {
    return new CacheStore(this, options);
  }

  async clearNamespace(prefix) {
    if (typeof this.driver.clearByPrefix !== "function") return;
    const target = String(prefix || "").trim();
    if (!target) return;
    const normalized = target.endsWith(":") ? target : `${target}:`;
    await this.driver.clearByPrefix(normalized);
  }

  metrics() {
    return {
      namespace: this.namespace,
      defaultTtlSeconds: this.defaultTtlSeconds,
      driver: this.driver?.kind || "local",
      driverMetrics: this.driver?.metrics?.(),
    };
  }
}

class CacheStore {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.name = options.name || options.namespace || "cache";
    this.namespace = buildNamespace(manager.namespace, options.namespace);
    this.ttlSeconds = seconds(options.ttlSeconds, manager.defaultTtlSeconds);
    this.inflight = new Map();
  }

  fullKey(key) {
    const suffix = String(key ?? "").trim();
    return suffix ? `${this.namespace}:${suffix}` : this.namespace;
  }

  async get(key) {
    const resolved = await this.manager.driver.get(this.fullKey(key));
    return resolved;
  }

  async set(key, value, ttlSeconds) {
    if (value === undefined) return undefined;
    const ttl =
      ttlSeconds == null
        ? this.ttlSeconds
        : seconds(ttlSeconds, this.ttlSeconds);
    await this.manager.driver.set(this.fullKey(key), value, ttl);
    return value;
  }

  async delete(key) {
    return this.manager.driver.delete(this.fullKey(key));
  }

  async has(key) {
    const value = await this.get(key);
    return value !== undefined;
  }

  async remember(key, producer, options = {}) {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;
    if (typeof producer !== "function") return cached;
    const inflightKey = this.fullKey(`__inflight__${key}`);
    if (!this.inflight.has(inflightKey)) {
      const promise = (async () => {
        try {
          const result = await producer();
          if (result !== undefined) {
            await this.set(key, result, options.ttlSeconds);
          }
          return result;
        } finally {
          this.inflight.delete(inflightKey);
        }
      })();
      this.inflight.set(inflightKey, promise);
    }
    return this.inflight.get(inflightKey);
  }

  async flush() {
    await this.manager.clearNamespace(this.namespace);
  }
}

let singletonManager = null;

export function getCacheManager() {
  if (!singletonManager) {
    singletonManager = new CacheManager(config?.caching || {});
  }
  return singletonManager;
}

export function createCacheStore(options = {}) {
  return getCacheManager().createStore(options);
}

export function cacheMetrics() {
  return getCacheManager().metrics();
}
