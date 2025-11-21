import pino from "pino";
import { config } from "./config.js";

const isDev = (config.env || "").toLowerCase() === "development";
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = "info";

const normalizeLevel = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, normalized)
    ? normalized
    : DEFAULT_LEVEL;
};

const requestedLevel = normalizeLevel(config?.log?.level);
const effectiveLevel =
  isDev || LEVELS[requestedLevel] <= LEVELS.warn ? requestedLevel : "warn";

export const logger = pino({
  level: effectiveLevel,
  transport:
    config?.log?.pretty ?? true
      ? {
          target: "pino-pretty",
          options: { colorize: true },
        }
      : undefined,
});

export const startupLogger = logger.child({}, { level: "info" });
