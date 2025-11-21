import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import mime from "mime-types";
import ffmpegStatic from "ffmpeg-static";
import { config } from "../config.js";

let ffmpegResolved = undefined;

const SUPPORTED_IMAGE_FORMATS = new Set(["jpeg", "jpg", "png", "webp"]);
const IMAGE_MIME_MAP = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const DEFAULT_MIN_SAVINGS =
  Number(config?.compress?.minSavingsRatio ?? 0.04) || 0.04;
const DEFAULT_MIN_BYTES =
  Number(config?.compress?.minBytes ?? 4096) > 0
    ? Number(config?.compress?.minBytes ?? 4096)
    : 4096;

const normalizeBoolean = (value, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
};

const clampRatio = (value, fallback = DEFAULT_MIN_SAVINGS) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
};

const clampNumber = (value, { fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const buildStats = (before, after, extra = {}) => {
  const beforeBytes = Math.max(0, Number(before) || 0);
  const afterBytes = Math.max(0, Number(after) || 0);
  const savedBytes = Math.max(0, beforeBytes - afterBytes);
  const ratio = beforeBytes > 0 ? savedBytes / beforeBytes : 0;
  return { beforeBytes, afterBytes, savedBytes, ratio, ...extra };
};

const compressionGloballyEnabled = () =>
  normalizeBoolean(config?.compress?.enabled, true);

async function haveFfmpeg() {
  if (ffmpegResolved !== undefined) return ffmpegResolved;
  const candidates = [
    process.env.FFMPEG_PATH,
    config?.compress?.ffmpegPath,
    ffmpegStatic,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  ].filter(Boolean);
  for (const cmd of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(cmd, ["-version"], { stdio: "ignore" });
        p.on("error", reject);
        p.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("ffmpeg exit"))
        );
      });
      ffmpegResolved = cmd;
      return true;
    } catch {}
  }
  ffmpegResolved = null;
  return false;
}

async function getSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

function tmpPath(ext = "bin") {
  const name = `warest-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;
  return path.join(os.tmpdir(), name);
}

function guessExtFromMime(m) {
  const e = mime.extension(String(m || "").toLowerCase());
  return e || "bin";
}

const normalizeImageFormat = (metaFormat, inputMime) => {
  const meta = String(metaFormat || "").toLowerCase();
  const mimeGuess = String(inputMime || "").toLowerCase();
  let format = meta || mimeGuess.split("/").pop() || "";
  if (format === "jpg") format = "jpeg";
  if (!SUPPORTED_IMAGE_FORMATS.has(format)) {
    if (mimeGuess.includes("jpeg") || mimeGuess.includes("jpg")) format = "jpeg";
    else if (mimeGuess.includes("png")) format = "png";
    else if (mimeGuess.includes("webp")) format = "webp";
  }
  const resolvedMime = IMAGE_MIME_MAP[format] || mimeGuess || "application/octet-stream";
  return { format, mime: resolvedMime };
};

const pickImageTargetFormat = ({
  hasAlpha,
  normalizedInput,
  allowWebp,
  preferOriginal,
  convertPng,
  requestedFormat,
}) => {
  const request = String(requestedFormat || "").toLowerCase();
  if (SUPPORTED_IMAGE_FORMATS.has(request)) {
    if (request === "webp" && !allowWebp) {
      return { format: hasAlpha ? "png" : "jpeg", mime: hasAlpha ? "image/png" : "image/jpeg" };
    }
    if (request === "png" && !hasAlpha && !convertPng) {
      return { format: normalizedInput.format, mime: normalizedInput.mime };
    }
    return { format: request === "jpg" ? "jpeg" : request, mime: IMAGE_MIME_MAP[request] || normalizedInput.mime };
  }
  if (hasAlpha) {
    return { format: "png", mime: "image/png" };
  }
  if (
    preferOriginal &&
    (normalizedInput.mime === "image/jpeg" || normalizedInput.mime === "image/png")
  ) {
    if (normalizedInput.mime === "image/png" && convertPng) {
      return { format: "jpeg", mime: "image/jpeg" };
    }
    return { format: normalizedInput.format || "jpeg", mime: normalizedInput.mime };
  }
  if (normalizedInput.mime === "image/png" && convertPng) {
    return { format: "jpeg", mime: "image/jpeg" };
  }
  if (allowWebp) {
    return { format: "webp", mime: "image/webp" };
  }
  return { format: "jpeg", mime: "image/jpeg" };
};

const shouldSkipBySize = (buffer, minBytes) => {
  if (!Buffer.isBuffer(buffer)) return true;
  const min = Math.max(0, Number(minBytes ?? DEFAULT_MIN_BYTES));
  return buffer.length > 0 && buffer.length < min;
};

async function tryFfmpegTranscode({
  input,
  inputMime,
  args,
  outExt,
  minSavingsRatio,
  minBytes,
  preferMime,
  force = false,
}) {
  const enabled = force ? true : compressionGloballyEnabled();
  if (!enabled) return { buffer: input, mime: inputMime, changed: false };
  if (!Buffer.isBuffer(input))
    return {
      buffer: input,
      mime: inputMime,
      changed: false,
      details: { skipped: "invalid_buffer" },
    };
  if (!force && shouldSkipBySize(input, minBytes))
    return {
      buffer: input,
      mime: inputMime,
      changed: false,
      details: { skipped: "too_small" },
    };
  const ok = await haveFfmpeg();
  if (!ok) return { buffer: input, mime: inputMime, changed: false };
  const inExt = guessExtFromMime(inputMime) || "bin";
  const inPath = tmpPath(inExt);
  const outPath = tmpPath(outExt);
  await fs.writeFile(inPath, input);
  let result = {
    buffer: input,
    mime: inputMime,
    changed: false,
    details: { skipped: "encoder_unavailable" },
  };
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegResolved, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inPath,
        ...args,
        outPath,
      ]);
      let done = false;
      p.on("error", (e) => {
        if (!done) {
          done = true;
          reject(e);
        }
      });
      p.on("exit", (code) => {
        if (!done) {
          done = true;
          code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`));
        }
      });
    });
    const out = await fs.readFile(outPath).catch(() => null);
    if (out && out.length > 0) {
      const outMime = preferMime || mime.lookup(outExt) || inputMime;
      const minRatio = clampRatio(minSavingsRatio, DEFAULT_MIN_SAVINGS);
      const stats = buildStats(input.length, out.length);
      const changed =
        outMime !== inputMime ||
        stats.ratio >= minRatio ||
        out.length < input.length;
      result = changed
        ? { buffer: out, mime: outMime, changed: true, details: stats }
        : {
            buffer: input,
            mime: inputMime,
            changed: false,
            details: { ...stats, skipped: "no_gain" },
          };
    } else {
      result = { buffer: input, mime: inputMime, changed: false };
    }
  } catch (err) {
    result = {
      buffer: input,
      mime: inputMime,
      changed: false,
      details: { skipped: "transcode_failed", reason: err?.message },
    };
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
  return result;
}

export async function compressImageBuffer(buffer, inputMime, opts = {}) {
  const enabled =
    compressionGloballyEnabled() && normalizeBoolean(opts.enable, true);
  if (!enabled || !Buffer.isBuffer(buffer)) {
    return { buffer, mime: inputMime, changed: false };
  }
  const sharp = await getSharp();
  if (!sharp) return { buffer, mime: inputMime, changed: false };

  const minBytes =
    opts.minBytes ??
    config?.compress?.imageMinBytes ??
    config?.compress?.minBytes ??
    DEFAULT_MIN_BYTES;
  if (shouldSkipBySize(buffer, minBytes)) {
    return {
      buffer,
      mime: inputMime,
      changed: false,
      details: { skipped: "too_small" },
    };
  }

  const maxDim =
    opts.maxDimension ??
    config?.compress?.imageMaxDimension ??
    1280;
  const quality = clampNumber(
    opts.quality ?? config?.compress?.imageQuality ?? 82,
    { fallback: 82, min: 1, max: 100 }
  );
  const pngCompression = clampNumber(
    opts.pngCompressionLevel ?? config?.compress?.imagePngCompressionLevel ?? 8,
    { fallback: 8, min: 0, max: 9 }
  );
  const minSavingsRatio = clampRatio(
    opts.minSavingsRatio ??
      config?.compress?.imageMinSavingsRatio ??
      config?.compress?.minSavingsRatio ??
      DEFAULT_MIN_SAVINGS,
    DEFAULT_MIN_SAVINGS
  );
  const allowWebp = normalizeBoolean(
    opts.allowWebp ?? config?.compress?.imageAllowWebp,
    false
  );
  const preferOriginal =
    opts.preferOriginalFormat ??
    config?.compress?.imagePreferOriginalFormat ??
    true;
  const convertPng =
    opts.convertPngToJpeg ??
    config?.compress?.imageConvertPngToJpeg ??
    true;

  try {
    const inspector = sharp(buffer, { failOnError: false });
    const meta = await inspector.metadata().catch(() => null);
    if (!meta) return { buffer, mime: inputMime, changed: false };
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    const shouldResize =
      maxDim > 0 && (width > maxDim || height > maxDim);
    const pipeline = sharp(buffer, { failOnError: false }).rotate();
    if (shouldResize) {
      pipeline.resize({
        width: maxDim,
        height: maxDim,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const normalizedInput = normalizeImageFormat(meta?.format, inputMime);
    const target = pickImageTargetFormat({
      hasAlpha: Boolean(meta.hasAlpha),
      normalizedInput,
      allowWebp,
      preferOriginal,
      convertPng,
      requestedFormat: opts.format,
    });

    let outBuf;
    if (target.format === "png") {
      outBuf = await pipeline
        .png({
          compressionLevel: pngCompression,
          adaptiveFiltering: true,
          palette: true,
        })
        .toBuffer();
    } else if (target.format === "webp") {
      outBuf = await pipeline
        .webp({
          quality,
          effort: clampNumber(opts.webpEffort ?? 4, {
            fallback: 4,
            min: 0,
            max: 6,
          }),
        })
        .toBuffer();
    } else {
      outBuf = await pipeline
        .jpeg({
          quality,
          mozjpeg: true,
          chromaSubsampling: "4:2:0",
        })
        .toBuffer();
    }
    const stats = buildStats(buffer.length, outBuf.length, {
      widthBefore: width,
      heightBefore: height,
      resized: shouldResize,
    });
    const changed =
      target.mime !== normalizedInput.mime ||
      shouldResize ||
      stats.ratio >= minSavingsRatio;
    if (!changed) {
      return {
        buffer,
        mime: inputMime,
        changed: false,
        details: { ...stats, skipped: "no_gain" },
      };
    }
    return { buffer: outBuf, mime: target.mime, changed: true, details: stats };
  } catch (err) {
    return {
      buffer,
      mime: inputMime,
      changed: false,
      details: { skipped: "image_error", reason: err?.message },
    };
  }
}

export async function compressVideoBuffer(buffer, inputMime, opts = {}) {
  const enabled =
    compressionGloballyEnabled() && normalizeBoolean(opts.enable, true);
  if (!enabled) return { buffer, mime: inputMime, changed: false };
  const maxW =
    opts.maxWidth ??
    config?.compress?.videoMaxWidth ??
    720;
  const crf =
    opts.crf ??
    config?.compress?.videoCrf ??
    28;
  const preset = String(
    opts.preset ?? config?.compress?.videoPreset ?? "veryfast"
  );
  const audioK =
    opts.audioBitrateK ??
    config?.compress?.videoAudioBitrateK ??
    96;
  const minSavingsRatio =
    opts.minSavingsRatio ??
    config?.compress?.videoMinSavingsRatio ??
    config?.compress?.minSavingsRatio ??
    DEFAULT_MIN_SAVINGS;
  const minBytes =
    opts.minBytes ??
    config?.compress?.videoMinBytes ??
    DEFAULT_MIN_BYTES * 16;

  const args = [
    "-vf",
    `scale=min(${maxW},iw):-2`,
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    `${audioK}k`,
  ];
  return await tryFfmpegTranscode({
    input: buffer,
    inputMime,
    args,
    outExt: "mp4",
    minSavingsRatio,
    minBytes,
    preferMime: "video/mp4",
  });
}

export async function compressAudioBuffer(buffer, inputMime, opts = {}) {
  const forceTranscode = opts.force === true;
  const enabled =
    (forceTranscode || compressionGloballyEnabled()) &&
    normalizeBoolean(opts.enable, true);
  if (!enabled) return { buffer, mime: inputMime, changed: false };
  const br =
    opts.audioBitrateK ??
    opts.bitrateK ??
    config?.compress?.audioBitrateK ??
    96;
  const preferOpus =
    opts.preferOpus ?? config?.compress?.audioPreferOpus ?? true;
  const minSavingsRatio =
    opts.minSavingsRatio ??
    config?.compress?.audioMinSavingsRatio ??
    config?.compress?.minSavingsRatio ??
    DEFAULT_MIN_SAVINGS;
  const minBytes =
    opts.minBytes ??
    config?.compress?.audioMinBytes ??
    DEFAULT_MIN_BYTES * 2;
  let outExt = "mp3";
  if (/ogg|opus/i.test(String(inputMime || "")) || preferOpus) {
    outExt = "ogg";
  }
  const sampleRate = Number(opts.sampleRate ?? 0);
  const channels = Number(opts.channels ?? 0);
  const opusApplication =
    typeof opts.opusApplication === "string"
      ? opts.opusApplication
      : undefined;
  const args = ["-vn"];
  if (sampleRate > 0) {
    args.push("-ar", String(sampleRate));
  }
  if (channels > 0) {
    args.push("-ac", String(channels));
  }
  args.push("-c:a", outExt === "mp3" ? "libmp3lame" : "libopus");
  if (outExt !== "mp3" && opusApplication) {
    args.push("-application", opusApplication);
  }
  args.push("-b:a", `${br}k`);
  return await tryFfmpegTranscode({
    input: buffer,
    inputMime,
    args,
    outExt,
    minSavingsRatio,
    minBytes,
    preferMime: outExt === "mp3" ? "audio/mpeg" : "audio/ogg",
    force: forceTranscode,
  });
}

export async function compressByKind(buffer, inputMime, kind, opts = {}) {
  const enabled =
    compressionGloballyEnabled() && normalizeBoolean(opts.enable, true);
  if (!enabled) return { buffer, mime: inputMime, changed: false };
  const k = String(kind || "document").toLowerCase();
  if (k === "image") return await compressImageBuffer(buffer, inputMime, opts);
  if (k === "video" || k === "gif")
    return await compressVideoBuffer(buffer, inputMime, opts);
  if (k === "audio") return await compressAudioBuffer(buffer, inputMime, opts);

  return { buffer, mime: inputMime, changed: false };
}

export default {
  compressByKind,
  compressImageBuffer,
  compressVideoBuffer,
  compressAudioBuffer,
};
