import { config } from "../config.js";

const DEFAULT_COUNTRY_CODE = (() => {
  const raw = String(config?.defaultCountryCode ?? "62").trim();
  const digits = raw.replace(/\D+/g, "");
  return digits || "62";
})();

const cleanDigits = (value) => String(value ?? "").replace(/\D+/g, "");

const resolveDialCode = (value) => {
  const digits = cleanDigits(value);
  return digits || DEFAULT_COUNTRY_CODE;
};

export function normalizePhoneDigits(value, countryOverride) {
  let digits = cleanDigits(value);
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) {
    const cc = resolveDialCode(countryOverride);
    const trimmed = digits.replace(/^0+/, "");
    return trimmed ? `${cc}${trimmed}` : cc;
  }
  return digits;
}

export function jidFromPhoneNumber(value, options = {}) {
  const digits = normalizePhoneDigits(
    value,
    options.countryCode ?? config?.defaultCountryCode
  );
  return digits ? `${digits}@s.whatsapp.net` : "";
}
