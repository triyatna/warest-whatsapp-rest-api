import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, PassThrough, Transform } from "node:stream";
import { lookup as lookupMime } from "mime-types";
import { ulid } from "ulid";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";
import { logger } from "../logger.js";

const ensureDir = async (dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
};

const safeUnlink = async (filePath) => {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn({ err: error, filePath }, "[storage] failed to cleanup file");
    }
  }
};

const isReadable = (value) =>
  value && typeof value === "object" && typeof value.pipe === "function";

const toReadable = async (input, { interpretAsPath = false } = {}) => {
  if (Buffer.isBuffer(input)) return Readable.from(input);
  if (typeof input === "string") {
    if (interpretAsPath || (await pathExists(input))) {
      return fs.createReadStream(input);
    }
    return Readable.from(Buffer.from(input));
  }
  if (isReadable(input)) return input;
  throw new StorageError("Unsupported input type for storage", "INVALID_INPUT");
};

const pathExists = async (inputPath) => {
  try {
    await fs.promises.access(inputPath);
    return true;
  } catch {
    return false;
  }
};

const normalizeSegments = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeSegments);
  return String(value)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"));
};

const ensurePosix = (value) => value.replace(/\\/g, "/");

const normalizeKey = (key) => {
  const normalized = ensurePosix(key || "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
  return normalized;
};

const normalizeSignedBase = (value, fallback = "/storage/private") => {
  const raw = (value || fallback || "").trim();
  if (!raw) return "/";
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, "");
  }
  const normalized = ensurePosix(raw).replace(/\/+$/, "");
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

const normalizeVisibilityMode = (value, fallback = "public") => {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "private" || normalized === "public") {
    return normalized;
  }
  return fallback;
};

const buildKeyFromOptions = (options = {}) => {
  if (options.key) return normalizeKey(options.key);
  const segments = normalizeSegments(options.directory);
  const name =
    options.filename?.trim() ||
    `${ulid().toLowerCase()}${ensureLeadingDot(options.extension)}`;
  segments.push(name.replace(/[^A-Za-z0-9._-]/g, "-"));
  return segments.filter(Boolean).join("/");
};

const ensureLeadingDot = (extension = "") => {
  if (!extension) return "";
  return extension.startsWith(".") ? extension : `.${extension}`;
};

const guessMimeType = (fileName, fallback = "application/octet-stream") =>
  lookupMime(fileName) || fallback;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const deriveEncryptionKey = (rawKey, fallbackSecret) => {
  const token = rawKey?.trim() || fallbackSecret?.trim();
  if (!token) return null;
  const asBuffer = tryDecodeKey(token) || crypto.createHash("sha256").update(token).digest();
  if (asBuffer.length === 32) return asBuffer;
  if (asBuffer.length > 32) return asBuffer.subarray(0, 32);
  return crypto.createHash("sha256").update(asBuffer).digest();
};

const tryDecodeKey = (token) => {
  if (/^[A-Fa-f0-9]{64}$/.test(token)) {
    return Buffer.from(token, "hex");
  }
  if (/^[A-Za-z0-9+/=]+$/.test(token) && token.length % 4 === 0) {
    try {
      return Buffer.from(token, "base64");
    } catch {
      return null;
    }
  }
  return null;
};

const appendQuery = (input, params = {}) => {
  const absolute = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input);
  const base = new URL(
    absolute ? input : `http://local${input.startsWith("/") ? "" : "/"}${input}`
  );
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    base.searchParams.set(key, String(value));
  });
  if (absolute) return base.toString();
  return `${base.pathname}${base.search}`;
};

const pipeStreams = async (streams) => {
  const filtered = streams.filter(Boolean);
  if (filtered.length < 2) return;
  await pipeline(...filtered);
};

const timingSafeCompare = (a, b) => {
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (!bufA.length || bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
};

class ChecksumStream extends Transform {
  constructor(algorithm = "sha256") {
    super();
    this.algorithm = algorithm;
    this.hash = crypto.createHash(algorithm);
    this.bytesWritten = 0;
    this.digested = null;
  }

  _transform(chunk, enc, callback) {
    this.bytesWritten += chunk.length;
    this.hash.update(chunk);
    this.push(chunk);
    callback();
  }

  getDigest() {
    if (!this.digested) {
      this.digested = this.hash.digest("hex");
    }
    return this.digested;
  }
}

export class StorageError extends Error {
  constructor(message, code = "STORAGE_ERROR", cause) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

class LocalStorageDriver {
  constructor(options = {}) {
    this.driver = "local";
    this.metaExt = ".meta.json";
    this.sharedSecret = options.sharedSecret;
    this.defaultChecksumAlgorithm = options.checksumAlgorithm || "sha256";
    this.defaultVisibility = normalizeVisibilityMode(
      options.defaultVisibility || "public"
    );
    this.publicRoot = this.buildRoot("public", {
      basePath:
        options.publicPath ||
        options.publicBasePath ||
        "data/public/storages",
      baseUrl: options.publicUrl ?? "/storages",
      encrypt: options.encryptPublic ?? false,
    });
    this.privateRoot = this.buildRoot("private", {
      basePath:
        options.basePath || options.privatePath || "data/private/storages",
      baseUrl: options.baseUrl || options.privateUrl || "",
      signedPath: options.signedUrl?.path || "/storage/private",
      encrypt: options.encryptPrivate ?? options.encryptByDefault ?? true,
    });
    this.roots = [this.publicRoot, this.privateRoot].filter(Boolean);
    if (!this.roots.length) {
      throw new StorageError(
        "Local storage requires at least one root path",
        "LOCAL_ROOT_MISSING"
      );
    }
    this.metadataBasePath = path.resolve(
      process.cwd(),
      options.metadataPath ||
        options.metaPath ||
        path.join(this.privateRoot?.basePath ?? this.roots[0].basePath, ".meta")
    );
    this.signedSecret =
      options.signedUrl?.secret || options.sharedSecret || "warest-storage-secret";
    this.defaultSignedTtl = Number(options.signedUrl?.expiresInSeconds || 900);
    this.pruneIntervalMs = Number(options.pruneExpiredTokensMs || 3600000);
    this.encryptionKey = deriveEncryptionKey(options.encryptionKey, this.sharedSecret);
    this.activeTokens = new Map();
    this.ensureRootsPromise = Promise.all(
      this.roots.map((root) => ensureDir(root.basePath))
    );
    this.ensureMetaPromise = ensureDir(this.metadataBasePath);
    if (this.pruneIntervalMs > 0) {
      this.pruneHandle = setInterval(
        () => this.pruneExpiredTokens(),
        this.pruneIntervalMs
      );
      this.pruneHandle.unref?.();
    }
  }

  buildRoot(visibility, overrides = {}) {
    const basePathInput =
      overrides.basePath ||
      (visibility === "public"
        ? path.join("data", "public", "storages")
        : path.join("data", "private", "storages"));
    if (!basePathInput) return null;
    const basePath = path.resolve(process.cwd(), basePathInput);
    const baseUrl = (overrides.baseUrl || "").trim();
    const signedPath =
      overrides.signedPath && overrides.signedPath.trim()
        ? normalizeSignedBase(overrides.signedPath)
        : null;
    return {
      visibility,
      basePath,
      baseUrl,
      signedPath,
      encryptByDefault:
        typeof overrides.encrypt === "boolean"
          ? overrides.encrypt
          : visibility === "private",
    };
  }

  normalizeVisibility(value) {
    return normalizeVisibilityMode(value, this.defaultVisibility);
  }

  getRootByVisibility(value) {
    const visibility = this.normalizeVisibility(value);
    if (visibility === "private") {
      return this.privateRoot ?? this.publicRoot;
    }
    return this.publicRoot ?? this.privateRoot;
  }

  getRootOrder(hint) {
    const normalized = hint ? this.normalizeVisibility(hint) : null;
    if (normalized === "private") {
      return [this.privateRoot, this.publicRoot].filter(Boolean);
    }
    return [this.publicRoot, this.privateRoot].filter(Boolean);
  }

  async save(input, options = {}) {
    await this.ensureRootsPromise;
    await this.ensureMetaPromise;
    const visibility = this.normalizeVisibility(options.visibility);
    const root = this.getRootByVisibility(visibility);
    if (!root) {
      throw new StorageError("No storage root available", "LOCAL_ROOT_MISSING");
    }
    const key = buildKeyFromOptions(options);
    const absolutePath = path.join(root.basePath, key);
    const checksumAlgo = options.checksumAlgorithm || this.defaultChecksumAlgorithm;
    const mimeType = options.mimeType || guessMimeType(options.originalName || key);

    await ensureDir(path.dirname(absolutePath));

    const checksumStream = new ChecksumStream(checksumAlgo);
    const streamList = [
      await toReadable(input, { interpretAsPath: options.inputIsPath }),
      checksumStream,
    ];

    const allowEncryption = root.visibility === "private";
    const wantsEncryption = options.encrypt ?? root.encryptByDefault;
    let cipher;
    let iv;

    if (!allowEncryption && options.encrypt) {
      throw new StorageError(
        "Public visibility does not support encryption",
        "LOCAL_PUBLIC_ENCRYPTION_UNSUPPORTED"
      );
    }

    if (allowEncryption && wantsEncryption) {
      if (!this.encryptionKey) {
        throw new StorageError(
          "Local encryption requested but encryption key is missing",
          "LOCAL_ENCRYPTION_DISABLED"
        );
      }
      iv = crypto.randomBytes(12);
      cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
      streamList.push(cipher);
    }

    const fileStream = fs.createWriteStream(absolutePath);
    streamList.push(fileStream);

    try {
      await pipeStreams(streamList);
    } catch (error) {
      await safeUnlink(absolutePath);
      throw new StorageError("Failed to write local file", "LOCAL_WRITE_FAILED", error);
    }

    let authTag = null;
    if (cipher) {
      authTag = cipher.getAuthTag();
    }

    const publicUrl =
      root.visibility === "public"
        ? this.buildPublicUrl(key, { visibility: "public" })
        : null;
    const metadata = {
      key,
      driver: this.driver,
      visibility: root.visibility,
      originalName: options.originalName || path.basename(key),
      mimeType,
      size: checksumStream.bytesWritten,
      checksum: checksumStream.getDigest(),
      checksumAlgorithm: checksumAlgo,
      encrypted: Boolean(cipher),
      encryption: cipher
        ? {
            algorithm: "aes-256-gcm",
            iv: iv.toString("hex"),
            authTag: authTag.toString("hex"),
          }
        : null,
      extra: options.metadata || {},
      uploadedAt: new Date().toISOString(),
      publicUrl,
    };

    await this.writeMetadata(key, metadata);

    return {
      key,
      url: publicUrl,
      visibility: root.visibility,
      metadata,
    };
  }

  async getStream(key, options = {}) {
    await this.ensureRootsPromise;
    const normalizedKey = normalizeKey(key);
    const metadata = await this.readMetadata(normalizedKey);
    const location =
      (metadata &&
        (await this.resolveLocation(normalizedKey, metadata.visibility))) ||
      (await this.resolveLocation(normalizedKey, options.visibility));
    if (!location) {
      throw new StorageError("Local object not found", "LOCAL_NOT_FOUND");
    }
    const stream = fs.createReadStream(location.absolutePath);
    const resolvedMetadata =
      metadata || (await this.buildMetadataFromStat(normalizedKey, location));

    if (
      resolvedMetadata.encrypted &&
      location.visibility === "private" &&
      options.decrypt !== false
    ) {
      if (!this.encryptionKey) {
        throw new StorageError(
          "Cannot decrypt local object because encryption key is not configured",
          "LOCAL_ENCRYPTION_DISABLED"
        );
      }
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        Buffer.from(resolvedMetadata.encryption.iv, "hex")
      );
      decipher.setAuthTag(Buffer.from(resolvedMetadata.encryption.authTag, "hex"));
      return { stream: stream.pipe(decipher), metadata: resolvedMetadata };
    }

    return { stream, metadata: resolvedMetadata };
  }

  async buffer(key, options = {}) {
    const { stream } = await this.getStream(key, options);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async delete(key) {
    const normalizedKey = normalizeKey(key);
    const location = await this.resolveLocation(normalizedKey);
    if (location) {
      await safeUnlink(location.absolutePath);
    }
    await safeUnlink(this.getMetadataPath(normalizedKey));
    for (const root of this.roots) {
      if (!root) continue;
      await safeUnlink(path.join(root.basePath, `${normalizedKey}${this.metaExt}`));
    }
    return Boolean(location);
  }

  async exists(key, options = {}) {
    const normalizedKey = normalizeKey(key);
    const location = await this.resolveLocation(normalizedKey, options.visibility);
    return Boolean(location);
  }

  async stat(key, options = {}) {
    const metadata = await this.readMetadata(key);
    if (metadata) return metadata;
    const normalizedKey = normalizeKey(key);
    const location = await this.resolveLocation(normalizedKey, options.visibility);
    if (!location) {
      throw new StorageError("Local object not found", "LOCAL_NOT_FOUND");
    }
    return this.buildMetadataFromStat(normalizedKey, location);
  }

  async writeMetadata(key, metadata) {
    await this.ensureMetaPromise;
    const metaPath = this.getMetadataPath(key);
    await ensureDir(path.dirname(metaPath));
    await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2));
  }

  async readMetadata(key) {
    const metaPath = this.getMetadataPath(key);
    try {
      const data = await fs.promises.readFile(metaPath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new StorageError("Unable to read metadata", "LOCAL_METADATA_ERROR", error);
      }
    }
    return this.readLegacyMetadata(key);
  }

  async readLegacyMetadata(key) {
    const normalizedKey = normalizeKey(key);
    for (const root of this.getRootOrder()) {
      if (!root) continue;
      const metaPath = path.join(root.basePath, `${normalizedKey}${this.metaExt}`);
      try {
        const data = await fs.promises.readFile(metaPath, "utf8");
        const parsed = JSON.parse(data);
        if (!parsed.visibility) parsed.visibility = root.visibility;
        return parsed;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw new StorageError("Unable to read legacy metadata", "LOCAL_METADATA_ERROR", error);
      }
    }
    return null;
  }

  getMetadataPath(key) {
    return path.join(this.metadataBasePath, `${normalizeKey(key)}${this.metaExt}`);
  }

  async resolveLocation(key, visibilityHint) {
    await this.ensureRootsPromise;
    const normalizedKey = normalizeKey(key);
    const candidates = this.getRootOrder(visibilityHint);
    for (const root of candidates) {
      if (!root) continue;
      const absolutePath = path.join(root.basePath, normalizedKey);
      if (await pathExists(absolutePath)) {
        return { root, absolutePath, visibility: root.visibility };
      }
    }
    return null;
  }

  async buildMetadataFromStat(key, location) {
    const normalizedKey = normalizeKey(key);
    const stats = await fs.promises.stat(location.absolutePath);
    const visibility = location?.visibility || this.defaultVisibility;
    const publicUrl =
      visibility === "public"
        ? this.buildPublicUrl(normalizedKey, { visibility: "public" })
        : null;
    return {
      key: normalizedKey,
      driver: this.driver,
      visibility,
      originalName: path.basename(normalizedKey),
      mimeType: guessMimeType(normalizedKey),
      size: stats.size,
      checksum: null,
      checksumAlgorithm: this.defaultChecksumAlgorithm,
      encrypted: false,
      encryption: null,
      extra: {},
      uploadedAt: stats.birthtime.toISOString(),
      publicUrl,
    };
  }

  buildPublicUrl(key, options = {}) {
    const visibility = this.normalizeVisibility(options.visibility);
    const root =
      visibility === "private" ? this.privateRoot ?? this.publicRoot : this.publicRoot;
    if (!root) return null;
    const explicit = (options.baseUrl || root.baseUrl || "").trim();
    if (!explicit) return null;
    const normalizedKey = normalizeKey(key);
    if (/^https?:\/\//i.test(explicit)) {
      return `${explicit.replace(/\/+$/, "")}/${normalizedKey}`;
    }
    const normalizedBase = ensurePosix(explicit).replace(/\/+$/, "");
    const prefix = normalizedBase.startsWith("/") ? normalizedBase : `/${normalizedBase}`;
    return `${prefix}/${normalizedKey}`;
  }

  generateSignedUrl(key, options = {}) {
    const visibility = this.normalizeVisibility(options.visibility || "private");
    if (visibility === "public") {
      const directUrl =
        options.baseUrl || this.buildPublicUrl(key, { visibility: "public" });
      if (!directUrl) {
        throw new StorageError(
          "Cannot generate public URL without a base URL",
          "LOCAL_PUBLIC_URL_MISSING"
        );
      }
      return {
        url: directUrl,
        visibility: "public",
        token: null,
        expiresAt: null,
        payload: {
          key: normalizeKey(key),
          visibility: "public",
          scope: "public",
        },
      };
    }

    const normalizedKey = normalizeKey(key);
    const expiresIn = Math.max(1, options.expiresInSeconds ?? this.defaultSignedTtl);
    const expires = nowSeconds() + expiresIn;
    const payload = {
      key: normalizedKey,
      visibility: "private",
      expires,
      scope: options.scope || "download",
      downloadName: options.downloadName || "",
    };
    const token = this.signPayload(payload);
    this.activeTokens.set(token, expires);
    const base =
      options.baseUrl ||
      this.privateRoot?.signedPath ||
      normalizeSignedBase("/storage/private");
    const url = appendQuery(base, {
      key: normalizedKey,
      visibility: payload.visibility,
      expires,
      token,
      scope: payload.scope,
      download: payload.downloadName,
    });
    return {
      url,
      token,
      visibility: "private",
      expiresAt: new Date(expires * 1000),
      payload,
    };
  }

  verifySignedUrl(payload, options = {}) {
    const visibility = normalizeVisibilityMode(
      payload?.visibility || options.visibility || "private",
      "private"
    );
    if (visibility !== "private") {
      return true;
    }
    if (!payload?.token || !payload?.key) return false;
    const expires = Number(payload.expires);
    if (!expires || expires < nowSeconds()) return false;
    const normalizedPayload = {
      key: normalizeKey(payload.key),
      visibility: "private",
      expires,
      scope: payload.scope || "download",
      downloadName: payload.download || payload.downloadName || "",
    };
    const expectedToken = this.signPayload(normalizedPayload);
    const match = timingSafeCompare(payload.token, expectedToken);
    if (!match) return false;
    if (options.strict) {
      const cached = this.activeTokens.get(payload.token);
      if (!cached || cached !== expires) return false;
    }
    if (options.consume) {
      this.activeTokens.delete(payload.token);
    }
    return true;
  }

  revokeSignedToken(token) {
    this.activeTokens.delete(token);
  }

  signPayload(payload) {
    const serialized = JSON.stringify(payload);
    return crypto.createHmac("sha256", this.signedSecret).update(serialized).digest("hex");
  }

  pruneExpiredTokens() {
    const now = nowSeconds();
    for (const [token, expires] of this.activeTokens.entries()) {
      if (expires < now) {
        this.activeTokens.delete(token);
      }
    }
  }
}

class S3StorageDriver {
  constructor(options = {}) {
    this.driver = "s3";
    this.bucket = options.bucket;
    this.region = !options.region || options.region === "auto" ? "us-east-1" : options.region;
    this.defaultSignedTtl = Number(options.signedUrlSeconds || 900);
    this.defaultVisibility = normalizeVisibilityMode(
      options.defaultVisibility || "private"
    );
    this.publicUrl = options.publicUrl || "";
    this.endpoint = options.endpoint || "";
    this.defaultAcl = options.defaultAcl || "private";
    this.serverSideEncryption = options.serverSideEncryption || "";
    this.sseKmsKeyId = options.sseKmsKeyId || "";
    this.sseCustomerAlgorithm = options.sseCustomerAlgorithm || "";
    this.sseCustomerKey = options.sseCustomerKey || "";
    this.defaultChecksumAlgorithm = options.checksumAlgorithm || "sha256";
    if (!this.bucket) {
      throw new StorageError("S3 bucket is not configured", "S3_BUCKET_MISSING");
    }
    this.client = new S3Client({
      region: this.region,
      endpoint: this.endpoint || undefined,
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: options.accessKeyId
        ? {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            sessionToken: options.sessionToken || undefined,
          }
        : undefined,
      useAccelerateEndpoint: options.accelerate ?? false,
    });
  }

  async save(input, options = {}) {
    const key = buildKeyFromOptions(options);
    const visibility = normalizeVisibilityMode(
      options.visibility,
      this.defaultVisibility
    );
    const acl = options.acl || (visibility === "public" ? "public-read" : this.defaultAcl);
    const checksumAlgo = options.checksumAlgorithm || this.defaultChecksumAlgorithm;
    const mimeType = options.mimeType || guessMimeType(options.originalName || key);
    const checksumStream = new ChecksumStream(checksumAlgo);
    const passThrough = new PassThrough();

    const uploadPromise = this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: passThrough,
        ContentType: mimeType,
        CacheControl: options.cacheControl,
        ACL: acl,
        Metadata: this.normalizeMetadata({
          ...options.metadata,
          originalName: options.originalName || path.basename(key),
          visibility,
        }),
        ServerSideEncryption: this.serverSideEncryption || undefined,
        SSEKMSKeyId: this.sseKmsKeyId || undefined,
        SSECustomerAlgorithm: this.sseCustomerAlgorithm || undefined,
        SSECustomerKey: this.sseCustomerKey || undefined,
      })
    );

    const pipelinePromise = pipeStreams([
      await toReadable(input, { interpretAsPath: options.inputIsPath }),
      checksumStream,
      passThrough,
    ]);

    try {
      await Promise.all([pipelinePromise, uploadPromise]);
    } catch (error) {
      throw new StorageError("Failed to upload object to S3", "S3_UPLOAD_FAILED", error);
    }

    const metadata = {
      key,
      driver: this.driver,
      bucket: this.bucket,
      mimeType,
      size: checksumStream.bytesWritten,
      checksum: checksumStream.getDigest(),
      checksumAlgorithm: checksumAlgo,
      encrypted: Boolean(this.serverSideEncryption || this.sseCustomerAlgorithm),
      encryption: this.serverSideEncryption
        ? { algorithm: this.serverSideEncryption, kmsKeyId: this.sseKmsKeyId || null }
        : null,
      extra: options.metadata || {},
      uploadedAt: new Date().toISOString(),
      visibility,
      publicUrl: visibility === "public" ? this.buildPublicUrl(key) : null,
    };

    return {
      key,
      url: this.buildPublicUrl(key),
      metadata,
    };
  }

  async getStream(key) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: normalizeKey(key),
        })
      );
      return {
        stream: response.Body,
        metadata: this.formatHeadResponse(key, response),
      };
    } catch (error) {
      throw new StorageError("Failed to download object from S3", "S3_GET_FAILED", error);
    }
  }

  async buffer(key) {
    const { stream } = await this.getStream(key);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async delete(key) {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: normalizeKey(key),
        })
      );
      return true;
    } catch (error) {
      throw new StorageError("Failed to delete object from S3", "S3_DELETE_FAILED", error);
    }
  }

  async exists(key) {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: normalizeKey(key),
        })
      );
      return true;
    } catch (error) {
      if (
        error?.$metadata?.httpStatusCode === 404 ||
        error?.name === "NotFound" ||
        error?.Code === "NotFound"
      ) {
        return false;
      }
      throw new StorageError("Failed to check S3 object", "S3_EXISTS_FAILED", error);
    }
  }

  async stat(key) {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: normalizeKey(key),
        })
      );
      return this.formatHeadResponse(key, response);
    } catch (error) {
      throw new StorageError("Failed to read object metadata", "S3_HEAD_FAILED", error);
    }
  }

  buildPublicUrl(key) {
    const normalizedKey = normalizeKey(key);
    if (this.publicUrl) {
      return `${this.publicUrl.replace(/\/+$/, "")}/${normalizedKey}`;
    }
    if (this.endpoint) {
      return `${this.endpoint.replace(/\/+$/, "")}/${this.bucket}/${normalizedKey}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${normalizedKey}`;
  }

  async generateSignedUrl(key, options = {}) {
    const action = (options.action || "get").toLowerCase();
    const expiresIn = Math.min(
      60 * 60 * 24 * 7,
      Math.max(1, options.expiresInSeconds ?? this.defaultSignedTtl)
    );
    const normalizedKey = normalizeKey(key);

    let command;
    if (action === "put" || action === "upload") {
      command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: normalizedKey,
        ContentType: options.mimeType || "application/octet-stream",
        ACL: options.acl || this.defaultAcl,
      });
    } else if (action === "delete") {
      command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: normalizedKey,
      });
    } else {
      command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: normalizedKey,
      });
    }

    const url = await awsGetSignedUrl(this.client, command, { expiresIn });
    return {
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      action,
    };
  }

  formatHeadResponse(key, response) {
    const visibility = response.Metadata?.visibility || "private";
    return {
      key: normalizeKey(key),
      driver: this.driver,
      bucket: this.bucket,
      mimeType: response.ContentType,
      size: Number(response.ContentLength || 0),
      checksum: response.ETag?.replace(/"/g, "") || null,
      checksumAlgorithm: response.ChecksumAlgorithm || this.defaultChecksumAlgorithm,
      encrypted: Boolean(response.ServerSideEncryption),
      encryption: response.ServerSideEncryption
        ? {
            algorithm: response.ServerSideEncryption,
            kmsKeyId: response.SSEKMSKeyId || null,
          }
        : null,
      extra: response.Metadata || {},
      uploadedAt: response.LastModified?.toISOString?.() || new Date().toISOString(),
      visibility,
      publicUrl: visibility === "public" ? this.buildPublicUrl(key) : null,
    };
  }

  normalizeMetadata(metadata = {}) {
    return Object.entries(metadata).reduce((acc, [key, value]) => {
      if (value === undefined || value === null) return acc;
      acc[key.toLowerCase()] = String(value);
      return acc;
    }, {});
  }
}

export class StorageManager {
  constructor(storageConfig = {}) {
    this.config = storageConfig;
    this.instances = new Map();
  }

  getDriverName(driver) {
    return (driver || this.config.driver || "local").toLowerCase();
  }

  getDriver(driver) {
    const name = this.getDriverName(driver);
    if (!this.instances.has(name)) {
      this.instances.set(name, this.createDriver(name));
    }
    return this.instances.get(name);
  }

  createDriver(name) {
    if (name === "s3") {
      return new S3StorageDriver({
        ...this.config.s3,
      });
    }
    return new LocalStorageDriver({
      ...this.config.local,
      sharedSecret: this.config.sharedSecret,
    });
  }

  use(driver) {
    this.config.driver = this.getDriverName(driver);
    return this;
  }

  async save(input, options = {}) {
    const driver = this.getDriver(options.driver);
    return driver.save(input, options);
  }

  async put(input, options = {}) {
    return this.save(input, options);
  }

  async upload(input, options = {}) {
    return this.save(input, options);
  }

  async getStream(key, options = {}) {
    const driver = this.getDriver(options.driver);
    return driver.getStream(key, options);
  }

  async buffer(key, options = {}) {
    const driver = this.getDriver(options.driver);
    return driver.buffer(key, options);
  }

  async delete(key, options = {}) {
    const driver = this.getDriver(options.driver);
    return driver.delete(key, options);
  }

  async exists(key, options = {}) {
    const driver = this.getDriver(options.driver);
    return driver.exists(key, options);
  }

  async stat(key, options = {}) {
    const driver = this.getDriver(options.driver);
    return driver.stat(key, options);
  }

  url(key, options = {}) {
    const driver = this.getDriver(options.driver);
    return driver.buildPublicUrl(key, options);
  }

  signedUrl(key, options = {}) {
    const driver = this.getDriver(options.driver);
    if (typeof driver.generateSignedUrl !== "function") {
      throw new StorageError(
        `Driver ${driver.driver} does not support signed URLs`,
        "SIGNED_URL_UNSUPPORTED"
      );
    }
    return driver.generateSignedUrl(key, options);
  }

  verifySignedPayload(payload, options = {}) {
    const driver = this.getDriver(options.driver);
    if (typeof driver.verifySignedUrl !== "function") {
      return false;
    }
    return driver.verifySignedUrl(payload, options);
  }
}

export const storage = new StorageManager(config.storage);

export const createStorageManager = (overrideConfig = {}) =>
  new StorageManager({
    ...config.storage,
    ...overrideConfig,
  });
