import dotenv from "dotenv";
dotenv.config();

const env = (key, def = "") => {
  const v = process.env[key];
  return typeof v === "string" ? v.trim() : def;
};

const parseList = (value, { lowercase = false, fallback = [] } = {}) => {
  const raw = typeof value === "string" ? value : "";
  const list = raw
    .split(",")
    .map((item) => (lowercase ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
  if (list.length === 0 && fallback.length) {
    return [...fallback];
  }
  return list;
};

const parsePositiveNumber = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
};

const parseNonNegativeNumber = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
};

const parseRatioNumber = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
};

const DEFAULT_WHATSAPP_MIMETYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/3gpp",
  "audio/ogg",
  "audio/opus",
  "audio/aac",
  "audio/mpeg",
  "audio/amr",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
];
const DEFAULT_FILE_MIMETYPES_ALLOWLIST = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/heif",
  "image/heic",
  "video/mp4",
  "video/3gpp",
  "video/3gp",
  "video/mpeg",
  "video/ogg",
  "video/webm",
  "video/x-msvideo",
  "video/x-matroska",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/wav",
  "audio/flac",
  "audio/ogg",
  "audio/opus",
  "audio/amr",
  "audio/x-ms-wma",
  "audio/mp4",
  "audio/m4a",
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-access",
  "application/vnd.visio",
  "application/vnd.ms-project",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-xz",
  "application/vnd.android.package-archive",
  "application/x-msdownload",
  "application/x-iso9660-image",
  "text/plain",
  "text/csv",
  "text/xml",
  "application/xml",
  "application/json",
  "application/javascript",
  "text/html",
  "text/markdown",
  "application/sql",
  "application/x-sql",
  "text/yaml",
  "application/x-yaml",
  "application/x-sh",
  "text/css",
  "application/epub+zip",
  "application/x-mobipocket-ebook",
  "application/x-fictionbook+xml",
  "application/postscript",
  "image/svg+xml",
  "application/illustrator",
  "application/photoshop",
  "application/vnd.adobe.photoshop",
  "image/vnd.adobe.photoshop",
  "application/octet-stream",
];

const TIMEZONE_LOCALE = (() => {
  const raw = env("WAREST_TZ_LOCALE", env("TZ_LOCALE", "en-US"));
  return String(raw || "").trim() || "en-US";
})();

function resolveTimezone() {
  const raw = env("WAREST_TIMEZONE", env("GENERIC_TIMEZONE", "UTC"));
  const tz = String(raw || "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat(TIMEZONE_LOCALE, { timeZone: tz });
    return tz;
  } catch {
    if (tz && tz.toUpperCase() !== "UTC") {
      const warn = `Invalid timezone "${tz}" from WAREST_TZ/WAREST_TIMEZONE/TZ, falling back to UTC`;
      if (typeof process.emitWarning === "function") {
        process.emitWarning(warn);
      } else {
        console.warn(warn);
      }
    }
    return "UTC";
  }
}

const timezone = resolveTimezone();
if (timezone && process.env.TZ !== timezone) {
  try {
    process.env.TZ = timezone;
  } catch {}
}

const PORT = Number(env("PORT", env("APP_PORT", 7308)));
const HOST = env("HOST", env("APP_HOST", "0.0.0.0"));
const PUBLIC_URL = (() => {
  const raw = env(
    "WAREST_BASE_URL",
    env("WAREST_PUBLIC_URL", "http://localhost:" + PORT)
  );
  return typeof raw === "string" ? raw.trim() : "";
})();
const rawAllowedOrigins = parseList(
  env("ALLOWED_ORIGINS", env("WAREST_ALLOWED_ORIGINS", ""))
);
const { allowedOrigins, allowAllOrigins } = resolveAllowedOrigins({
  entries: rawAllowedOrigins,
  host: HOST,
  port: PORT,
  publicUrl: PUBLIC_URL,
});
const proxyConfig = resolveProxyConfig();

export const config = {
  port: PORT,
  host: HOST,
  env: env("NODE_ENV", "development"),
  publicUrl: PUBLIC_URL,
  timezone,
  timezoneLocale: TIMEZONE_LOCALE,
  defaultCountryCode: env("WAREST_DEFAULT_COUNTRY_CODE", "62"),

  db: {
    client: (env("WAREST_DB_CLIENT", "sqlite") || "sqlite").toLowerCase(),
    sqlite: {
      filename: env("WAREST_DB_SQLITE_PATH", "data/warest.sqlite"),
    },

    mysql: {
      host: env("WAREST_DB_HOST", env("MYSQL_HOST", "")),
      port: Number(env("WAREST_DB_PORT", env("MYSQL_PORT", "3306"))),
      user: env("WAREST_DB_USER", env("MYSQL_USER", "")),
      password: env("WAREST_DB_PASSWORD", env("MYSQL_PASSWORD", "")),
      database: env("WAREST_DB_DATABASE", env("MYSQL_DATABASE", "")),
    },

    postgres: {
      url: (() => {
        const raw = env("WAREST_DB_POSTGRES_URL", env("WAREST_DB_URL", ""));
        return typeof raw === "string" ? raw.trim() : "";
      })(),
      host: env("WAREST_DB_HOST", ""),
      port: Number(env("WAREST_DB_PORT", "5432")),
      user: env("WAREST_DB_USER", ""),
      password: env("WAREST_DB_PASSWORD", ""),
      database: env("WAREST_DB_DATABASE", ""),
    },
  },
  allowedOrigins,
  allowAllOrigins,
  webhookDefault: {
    url: env("WEBHOOK_DEFAULT_URL", ""),
    secret: env("WEBHOOK_DEFAULT_SECRET", "supersecret"),
  },

  webhookOpts: {
    timeout: Number(env("WAREST_WEBHOOK_TIMEOUT_MS", "10000")),
    retries: Number(env("WAREST_WEBHOOK_RETRIES", "3")),
    backoffMs: Number(env("WAREST_WEBHOOK_BACKOFF_MS", "800")),
    jitter: Number(env("WAREST_WEBHOOK_JITTER_MS", "300")),
    delayMsActions: Number(env("WAREST_WEBHOOK_ACTIONS_DELAY_MS", "1200")),
    preflightTimeoutMs: Number(
      env("WAREST_WEBHOOK_PREFLIGHT_TIMEOUT_MS", "5000")
    ),
    parallelTargets: env("WAREST_WEBHOOK_PARALLEL_TARGETS", "true") === "true",
    signatureSha2: env("WAREST_WEBHOOK_SIGNATURE_SHA2", "256"),
  },

  interactiveDefaultImage: env(
    "INTERACTIVE_DEFAULT_IMAGE",
    "https://placehold.co/800x400.png"
  ),

  adminSeed: {
    username: env("WAREST_AUTHADMIN_USERNAME", ""),
    password: env("WAREST_AUTHADMIN_PASSWORD", ""),
    apiKey: env("WAREST_ADMIN_APIKEY", ""),
  },
  rateLimit: {
    windowMs: Number(env("RATE_LIMIT_WINDOW_MS", "60000")),
    max: Number(env("RATE_LIMIT_MAX", "120")),
  },
  spam: {
    cooldownMs: Number(env("SPAM_COOLDOWN_MS", "3000")),
    quotaWindowMs: Number(env("QUOTA_WINDOW_MS", "60000")),
    quotaMax: Number(env("QUOTA_MAX", "500")),
  },
  proxy: proxyConfig,
  log: {
    pretty: env("LOG_PRETTY", "true") === "true",
    level: env("LOG_LEVEL", "info"),
  },
  uploadLimits: {
    jsonMessagingMb: Number(env("MSG_JSON_LIMIT_MB", "1000")),
    rawFileMb: Number(env("FILE_RAW_LIMIT_MB", "2000")),
    perMediaMb: Number(env("MEDIA_PER_FILE_MB", "1024")),
    perFileMb: Number(env("FILE_PER_FILE_MB", "2048")),
    fetchTimeoutMs: Number(env("UPLOAD_FETCH_TIMEOUT_MS", "300000")),
  },
  compress: {
    enabled: env("WAREST_COMPRESS_ENABLED", "true") === "true",
    minSavingsRatio: parseRatioNumber(
      env("WAREST_COMPRESS_MIN_SAVINGS_RATIO", "0.04"),
      0.04
    ),
    minBytes: parseNonNegativeNumber(
      env("WAREST_COMPRESS_MIN_BYTES", "4096"),
      4096
    ),
    imageMaxDimension: parsePositiveNumber(
      env("WAREST_COMPRESS_IMAGE_MAX_DIMENSION", "1280"),
      1280
    ),
    imageQuality: parsePositiveNumber(
      env("WAREST_COMPRESS_IMAGE_QUALITY", "82"),
      82
    ),
    imageAllowWebp: env("WAREST_COMPRESS_IMAGE_ALLOW_WEBP", "false") === "true",
    imagePreferOriginalFormat:
      env("WAREST_COMPRESS_IMAGE_KEEP_FORMAT", "true") === "true",
    imageConvertPngToJpeg:
      env("WAREST_COMPRESS_IMAGE_PNG_TO_JPEG", "true") === "true",
    imagePngCompressionLevel: parseNonNegativeNumber(
      env("WAREST_COMPRESS_IMAGE_PNG_LEVEL", "8"),
      8
    ),
    imageMinSavingsRatio: parseRatioNumber(
      env("WAREST_COMPRESS_IMAGE_MIN_SAVINGS_RATIO", "0.04"),
      0.04
    ),
    imageMinBytes: parseNonNegativeNumber(
      env("WAREST_COMPRESS_IMAGE_MIN_BYTES", "2048"),
      2048
    ),
    videoMaxWidth: parsePositiveNumber(
      env("WAREST_COMPRESS_VIDEO_MAX_WIDTH", "720"),
      720
    ),
    videoCrf: parsePositiveNumber(env("WAREST_COMPRESS_VIDEO_CRF", "28"), 28),
    videoPreset: env("WAREST_COMPRESS_VIDEO_PRESET", "veryfast"),
    videoAudioBitrateK: parsePositiveNumber(
      env("WAREST_COMPRESS_VIDEO_AUDIO_BITRATE_K", "96"),
      96
    ),
    videoMinSavingsRatio: parseRatioNumber(
      env("WAREST_COMPRESS_VIDEO_MIN_SAVINGS_RATIO", "0.05"),
      0.05
    ),
    videoMinBytes: parseNonNegativeNumber(
      env("WAREST_COMPRESS_VIDEO_MIN_BYTES", "65536"),
      65536
    ),
    audioBitrateK: parsePositiveNumber(
      env("WAREST_COMPRESS_AUDIO_BITRATE_K", "96"),
      96
    ),
    audioPreferOpus:
      env("WAREST_COMPRESS_AUDIO_PREFER_OPUS", "true") === "true",
    audioMinSavingsRatio: parseRatioNumber(
      env("WAREST_COMPRESS_AUDIO_MIN_SAVINGS_RATIO", "0.04"),
      0.04
    ),
    audioMinBytes: parseNonNegativeNumber(
      env("WAREST_COMPRESS_AUDIO_MIN_BYTES", "8192"),
      8192
    ),
    ffmpegPath: env("WAREST_COMPRESS_FFMPEG_PATH", ""),
  },
  files: {
    mimeAllowlist: parseList(
      env(
        "WAREST_MIMETYPE_FILES_ALLOWLIST",
        DEFAULT_FILE_MIMETYPES_ALLOWLIST.join(",")
      ),
      { lowercase: true, fallback: DEFAULT_FILE_MIMETYPES_ALLOWLIST }
    ),
  },
  download: {
    mediaReceived: env("WAREST_DOWNLOAD_MEDIA_RECEIVED", "true") === "true",
    allowedMimeTypes: parseList(
      env(
        "WAREST_DOWNLOAD_MEDIA_ALLOW_MIMETYPES",
        DEFAULT_WHATSAPP_MIMETYPES.join(",")
      ),
      { lowercase: true, fallback: DEFAULT_WHATSAPP_MIMETYPES }
    ),
  },
  autoReply: {
    enabled: env("AUTOREPLY_ENABLED", "false") === "true",
    pingPong: env("AUTOREPLY_PING_PONG", "true") === "true",
  },
  queue: {
    concurrency: parsePositiveNumber(env("WAREST_QUEUE_CONCURRENCY", "1"), 1),
    maxQueueSize: (() => {
      const raw = Number(env("WAREST_QUEUE_MAX_SIZE", "0"));
      return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
    })(),
    timeoutMs: parseNonNegativeNumber(env("WAREST_QUEUE_TIMEOUT_MS", "0"), 0),
    maxRetries: parseNonNegativeNumber(env("WAREST_QUEUE_MAX_RETRIES", "0"), 0),
    retryDelayMs: parseNonNegativeNumber(
      env("WAREST_QUEUE_RETRY_DELAY_MS", "521"),
      75
    ),
    backoffFactor: parsePositiveNumber(
      env("WAREST_QUEUE_BACKOFF_FACTOR", "2"),
      2
    ),
    jitter: parseRatioNumber(env("WAREST_QUEUE_RETRY_JITTER", "0.2"), 0.2),
  },
  storage: {
    driver: (env("WAREST_STORAGE_DRIVER", "local") || "local").toLowerCase(),
    sharedSecret: env(
      "WAREST_STORAGE_SHARED_SECRET",
      env("WAREST_WEBHOOK_DEFAULT_SECRET", "warest-storage-secret")
    ),
    tempTtlSeconds: Number(env("WAREST_STORAGE_TEMP_TTL_SEC", "300")),
    local: {
      defaultVisibility: (
        env("WAREST_STORAGE_LOCAL_DEFAULT_VISIBILITY", "public") || "public"
      ).toLowerCase(),
      basePath: env("WAREST_STORAGE_LOCAL_PATH", "data/private/storages"),
      privatePath: env(
        "WAREST_STORAGE_LOCAL_PRIVATE_PATH",
        "data/private/storages"
      ),
      privateUrl: env(
        "WAREST_STORAGE_LOCAL_PRIVATE_URL",
        env("WAREST_STORAGE_LOCAL_URL", "")
      ),
      publicPath: env(
        "WAREST_STORAGE_LOCAL_PUBLIC_PATH",
        "data/public/storages"
      ),
      publicUrl: env("WAREST_STORAGE_LOCAL_PUBLIC_URL", "/storages"),
      metadataPath: env(
        "WAREST_STORAGE_LOCAL_METADATA_PATH",
        "data/private/storages/.meta"
      ),
      baseUrl: env("WAREST_STORAGE_LOCAL_URL", ""),
      encryptByDefault: env("WAREST_STORAGE_LOCAL_ENCRYPT", "true") === "true",
      encryptPrivate:
        env("WAREST_STORAGE_LOCAL_ENCRYPT_PRIVATE", "true") === "true",
      encryptPublic:
        env("WAREST_STORAGE_LOCAL_ENCRYPT_PUBLIC", "false") === "true",
      encryptionKey: env("WAREST_STORAGE_LOCAL_ENCRYPTION_KEY", ""),
      checksumAlgorithm: env("WAREST_STORAGE_LOCAL_CHECKSUM", "sha256"),
      signedUrl: {
        secret: env("WAREST_STORAGE_LOCAL_SIGNED_SECRET", ""),
        expiresInSeconds: Number(
          env("WAREST_STORAGE_LOCAL_SIGNED_TTL_SEC", "900")
        ),
        path: env("WAREST_STORAGE_LOCAL_SIGNED_PATH", "/storage/private"),
      },
      pruneExpiredTokensMs: Number(
        env("WAREST_STORAGE_LOCAL_PRUNE_MS", "3600000")
      ),
    },
    s3: {
      bucket: env("WAREST_STORAGE_S3_BUCKET", ""),
      region: env("WAREST_STORAGE_S3_REGION", "auto"),
      accessKeyId: env("WAREST_STORAGE_S3_KEY", ""),
      secretAccessKey: env("WAREST_STORAGE_S3_SECRET", ""),
      sessionToken: env("WAREST_STORAGE_S3_SESSION", ""),
      endpoint: env("WAREST_STORAGE_S3_ENDPOINT", ""),
      forcePathStyle:
        env("WAREST_STORAGE_S3_FORCE_PATH_STYLE", "false") === "true",
      accelerate: env("WAREST_STORAGE_S3_ACCELERATE", "false") === "true",
      publicUrl: env("WAREST_STORAGE_S3_PUBLIC_URL", ""),
      signedUrlSeconds: Number(env("WAREST_STORAGE_S3_SIGNED_TTL_SEC", "900")),
      defaultAcl: env("WAREST_STORAGE_S3_ACL", "private"),
      serverSideEncryption: env("WAREST_STORAGE_S3_SSE", ""),
      sseKmsKeyId: env("WAREST_STORAGE_S3_SSE_KMS_KEY", ""),
      sseCustomerAlgorithm: env("WAREST_STORAGE_S3_SSE_CUSTOMER_ALGO", ""),
      sseCustomerKey: env("WAREST_STORAGE_S3_SSE_CUSTOMER_KEY", ""),
    },
  },
  caching: {
    driver: (env("WAREST_CACHING_DRIVER", "local") || "local").toLowerCase(),
    namespace: env("WAREST_CACHING_NAMESPACE", "warest"),
    defaultTtlSeconds: Number(env("WAREST_CACHING_DEFAULT_TTL_SEC", "120")),
    local: {
      maxEntries: Number(env("WAREST_CACHE_LOCAL_MAX_ENTRIES", "5000")),
      maxHeapMb: Number(env("WAREST_CACHE_LOCAL_MAX_HEAP_MB", "128")),
      sweepIntervalMs: Number(env("WAREST_CACHE_LOCAL_SWEEP_MS", "45000")),
    },
    redis: {
      url: env("WAREST_CACHE_REDIS_URL", ""),
      host: env("WAREST_CACHE_REDIS_HOST", "127.0.0.1"),
      port: Number(env("WAREST_CACHE_REDIS_PORT", "6379")),
      username: env("WAREST_CACHE_REDIS_USERNAME", ""),
      password: env("WAREST_CACHE_REDIS_PASSWORD", ""),
      tls: env("WAREST_CACHE_REDIS_TLS", "false") === "true",
      keyPrefix: env("WAREST_CACHE_REDIS_PREFIX", ""),
      family: Number(env("WAREST_CACHE_REDIS_FAMILY", "0")),
    },
    memcached: {
      servers: env("WAREST_CACHE_MEMCACHED_SERVERS", "127.0.0.1:11211"),
      username: env("WAREST_CACHE_MEMCACHED_USERNAME", ""),
      password: env("WAREST_CACHE_MEMCACHED_PASSWORD", ""),
    },
    mongodb: {
      url: env("WAREST_CACHE_MONGODB_URL", "mongodb://127.0.0.1:27017"),
      database: env("WAREST_CACHE_MONGODB_DB", "warest"),
      collection: env("WAREST_CACHE_MONGODB_COLLECTION", "cacheEntries"),
      ttlField: env("WAREST_CACHE_MONGODB_TTL_FIELD", "expireAt"),
      maxPoolSize: Number(env("WAREST_CACHE_MONGODB_POOL", "5")),
    },
  },
  reconnect: {
    immediateOnClose: env("RECONNECT_IMMEDIATE_ON_CLOSE", "false") === "true",
  },
};

function resolveAllowedOrigins({ entries = [], host, port, publicUrl }) {
  const normalized = (entries || [])
    .map((value) => value?.trim())
    .filter(Boolean);
  const hasWildcard = normalized.some(
    (value) => value === "*" || value.toLowerCase?.() === "*"
  );
  if (hasWildcard) {
    return { allowedOrigins: ["*"], allowAllOrigins: true };
  }
  const bucket = new Set();
  for (const value of normalized) {
    addNormalizedOrigin(bucket, value);
  }
  if (bucket.size === 0) {
    addNormalizedOrigin(bucket, publicUrl);
    addNormalizedOrigin(bucket, `http://localhost:${port}`);
    addNormalizedOrigin(bucket, `http://127.0.0.1:${port}`);
    if (host && !["0.0.0.0", "::", "[::]"].includes(host)) {
      addNormalizedOrigin(bucket, `http://${host}:${port}`);
      addNormalizedOrigin(bucket, `https://${host}:${port}`);
    }
  }
  return {
    allowedOrigins: Array.from(bucket),
    allowAllOrigins: false,
  };
}

function addNormalizedOrigin(store, value) {
  const normalized = normalizeOriginValue(value);
  if (normalized) {
    store.add(normalized);
  }
}

function normalizeOriginValue(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function resolveProxyConfig() {
  const combined = [];
  appendProxyEntries(combined, env("WAREST_PROXY_URLS", ""));

  const seen = new Set();
  const pool = [];
  for (const value of combined) {
    const normalized = normalizeProxyUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    pool.push(normalized);
  }

  const enabled = pool.length > 0;
  const strategy = normalizeProxyStrategy(
    env("WAREST_PROXY_STRATEGY", pool.length > 1 ? "round_robin" : "failover")
  );
  const stickySession =
    env("WAREST_PROXY_STICKY_SESSION", pool.length > 0 ? "true" : "false") ===
    "true";
  const rotateAfterFailures = Math.max(
    1,
    parsePositiveNumber(
      env("WAREST_PROXY_ROTATE_AFTER_FAILURES", pool.length > 1 ? "2" : "1"),
      pool.length > 1 ? 2 : 1
    )
  );
  const failureCooloffMs = parseNonNegativeNumber(
    env("WAREST_PROXY_FAILURE_COOLOFF_MS", "15000"),
    15000
  );
  const backoffMultiplier = Math.max(
    1,
    parsePositiveNumber(env("WAREST_PROXY_FAILURE_BACKOFF_MULTIPLIER", "3"), 3)
  );

  return {
    enabled,
    pool,
    primary: pool[0] || null,
    strategy,
    stickySession,
    rotateAfterFailures,
    failureCooloffMs,
    failureBackoffMultiplier: backoffMultiplier,
  };
}

function appendProxyEntries(target, raw) {
  if (!target || typeof raw !== "string") return;
  const normalized = raw.replace(/\r?\n/g, ",");
  const entries = parseList(normalized);
  for (const entry of entries) {
    target.push(entry);
  }
}

function normalizeProxyUrl(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+:\d+$/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `http://${trimmed}`;
}

function normalizeProxyStrategy(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (["round_robin", "round-robin", "rr"].includes(raw)) return "round_robin";
  if (["random", "rand"].includes(raw)) return "random";
  if (["failover", "primary"].includes(raw)) return "failover";
  return "failover";
}
