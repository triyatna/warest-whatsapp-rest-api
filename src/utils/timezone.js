import { config } from "../config.js";

const BASE_TIMEZONE = (config.timezone || "UTC").trim() || "UTC";
const BASE_LOCALE = (config.timezoneLocale || "en-US").trim() || "en-US";
const FORMATTER_CACHE = new Map();

const DEFAULT_STYLE_OPTIONS = Object.freeze({
  dateStyle: "full",
  timeStyle: "long",
  timeZoneName: "short",
});

const COMPONENT_FALLBACK_OPTIONS = Object.freeze({
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

const DISPLAY_COMPONENT_OPTIONS = Object.freeze({
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

export function getAppTimezone() {
  return BASE_TIMEZONE;
}

export function isValidTimezone(input, locale = BASE_LOCALE) {
  if (!input) return false;
  try {
    new Intl.DateTimeFormat(locale, { timeZone: input });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(
  input,
  { fallback = BASE_TIMEZONE, locale = BASE_LOCALE } = {}
) {
  const candidate = (input ?? "").toString().trim();
  if (!candidate) return fallback;
  return isValidTimezone(candidate, locale) ? candidate : null;
}

export function ensureTimezone(
  input,
  { fallback = BASE_TIMEZONE, locale = BASE_LOCALE } = {}
) {
  return normalizeTimezone(input, { fallback, locale }) ?? fallback;
}

export function getTimezoneLocale() {
  return BASE_LOCALE;
}

export function formatDateInTimezone(
  date = new Date(),
  {
    locale = BASE_LOCALE,
    timeZone = BASE_TIMEZONE,
    options,
  } = {}
) {
  const primaryOptions = options ?? DEFAULT_STYLE_OPTIONS;

  if (!options) {
    const displayParts = getPartsMap(date, {
      locale,
      timeZone,
      options: DISPLAY_COMPONENT_OPTIONS,
    });
    const formattedDisplay = buildDisplayString(displayParts);
    if (formattedDisplay) return formattedDisplay;
  }

  const primaryFormatter = getCachedFormatter(
    locale,
    timeZone,
    primaryOptions
  );
  if (primaryFormatter) return primaryFormatter.format(date);

  const fallbackFormatter = getCachedFormatter(
    locale,
    timeZone,
    COMPONENT_FALLBACK_OPTIONS
  );
  if (fallbackFormatter) return fallbackFormatter.format(date);

  try {
    return new Date(date).toLocaleString(locale, { timeZone });
  } catch {
    return new Date(date).toISOString();
  }
}

function getCachedFormatter(locale, timeZone, options) {
  const key = buildFormatterCacheKey(locale, timeZone, options);
  if (FORMATTER_CACHE.has(key)) {
    return FORMATTER_CACHE.get(key);
  }
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone,
    });
    FORMATTER_CACHE.set(key, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function buildFormatterCacheKey(locale, timeZone, options) {
  return `${locale}__${timeZone}__${JSON.stringify(options || {})}`;
}

export function formatIsoInTimezone(
  date = new Date(),
  {
    timeZone = BASE_TIMEZONE,
    locale = BASE_LOCALE,
  } = {}
) {
  const parts = getTimezoneParts(date, { timeZone, locale });
  if (!parts) return new Date(date).toISOString();
  const ms = String(new Date(date).getMilliseconds()).padStart(3, "0");
  const timestamp = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}`;
  const offsetMinutes = getTimezoneOffsetMinutes(date, timeZone);
  if (offsetMinutes === 0) return `${timestamp}Z`;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${timestamp}${sign}${hours}:${minutes}`;
}

function getTimezoneParts(
  date,
  { timeZone = BASE_TIMEZONE, locale = BASE_LOCALE } = {}
) {
  return getPartsMap(date, { timeZone, locale, options: PARTS_OPTIONS });
}

const PARTS_OPTIONS = Object.freeze({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function getTimezoneOffsetMinutes(date, timeZone) {
  const utcDate = new Date(date);
  const localDate = getDateInTimezone(date, timeZone);
  const diffMs = localDate.getTime() - utcDate.getTime();
  return Math.round(diffMs / 60000);
}

function getDateInTimezone(date, timeZone) {
  const parts = getTimezoneParts(date, { timeZone, locale: "en-CA" });
  if (!parts) return new Date(date);
  const ms = String(new Date(date).getMilliseconds()).padStart(3, "0");
  const isoWithoutZone = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}`;
  return new Date(`${isoWithoutZone}Z`);
}

function getPartsMap(
  date,
  { timeZone = BASE_TIMEZONE, locale = BASE_LOCALE, options }
) {
  if (!options) return null;
  try {
    const formatter = getCachedFormatter(locale, timeZone, options);
    const formatted = formatter?.formatToParts?.(date);
    if (!formatted) return null;
    const map = {};
    for (const part of formatted) {
      if (part.type === "literal") continue;
      map[part.type] = part.value;
    }
    return map;
  } catch {
    return null;
  }
}

function buildDisplayString(parts) {
  if (!parts) return null;
  const dayName = parts.weekday || null;
  const day = pad2(parts.day);
  const month = parts.month || null;
  const year = parts.year || null;
  const hour = pad2(parts.hour);
  const minute = pad2(parts.minute);
  const second = pad2(parts.second);
  const tzName = parts.timeZoneName || null;

  if (!day && !month && !year && !hour && !tzName) return null;

  const segments = [];
  if (dayName) segments.push(dayName);

  const dateSegment = [day, month, year].filter(Boolean).join(" ");
  if (dateSegment) segments.push(dateSegment.trim());

  const timeSegment = [hour, minute, second]
    .filter((value) => value != null)
    .join(":");
  if (timeSegment) segments.push(timeSegment);

  if (tzName) segments.push(tzName);

  return segments.join(", ").replace(/,\s+,/g, ", ");
}

function pad2(value) {
  if (value == null) return null;
  return String(value).padStart(2, "0");
}
