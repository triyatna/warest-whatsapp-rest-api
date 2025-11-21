let currentRole = null;

const AUTH = window.WAREST_AUTH || null;

const LS_KEYS = {
  apiKey: AUTH?.STORAGE_KEYS?.apiKey || "wa.apiKey",
  baseUrl: AUTH?.STORAGE_KEYS?.baseUrl || "wa.baseUrl",
  currentSessionId: "wa.currentSessionId",
  username: AUTH?.STORAGE_KEYS?.username || "wa.username",
  isAdmin: AUTH?.STORAGE_KEYS?.isAdmin || "wa.isAdmin",
  loginMode: "wa.loginMode",
};

let ioClient = null;
let currentSessionId = localStorage.getItem(LS_KEYS.currentSessionId) || "";
let editSessionId = null;
let pairCodeRefreshTimer = 0;
let autoReconnTimer = 0;
const pairCodes = new Map();
const pairPhones = new Map();
const pairCodeTs = new Map();
let pairCodeExpiryTimer = 0;
const PAIR_CODE_TTL_MS = 60 * 1000;
const PAIR_CODE_REFRESH_MARGIN_MS = 8000;
const PAIR_CODE_PLACEHOLDER = "XXXX-XXXX";
let qrCountdownTimer = 0;
let qrExpireAt = 0;
let qrDefaultDuration = 20;
let activeQrSessionId = "";
let qrPrefetching = false;
let qrPrefetchForId = "";
const QR_INACTIVITY_MS = 120 * 1000;
let qrWaitingSince = 0;
let qrRefreshOverlayHideTimer = 0;
let qrPausedForInactivity = false;
const sessionStatus = new Map();
const sessionWasOpen = new Map();
const autoReconnectTs = new Map();
const PAIR_STATE_STORAGE_KEY = AUTH?.STORAGE_KEYS?.pairState || "wa.pairState";
let pairStateCache = {};
(function hydratePairStateCache() {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(PAIR_STATE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") pairStateCache = parsed;
    }
  } catch {
    pairStateCache = {};
  }
  try {
    Object.entries(pairStateCache || {}).forEach(([id, entry]) => {
      if (!entry || typeof entry !== "object") return;
      if (entry.code) pairCodes.set(id, entry.code);
      if (entry.ts) pairCodeTs.set(id, entry.ts);
      if (entry.phone) pairPhones.set(id, entry.phone);
    });
  } catch {}
})();

function persistPairState(id) {
  if (!id) return;
  if (typeof localStorage === "undefined") return;
  const record = {
    code: pairCodes.get(id) || "",
    ts: pairCodeTs.get(id) || 0,
    phone: pairPhones.get(id) || "",
  };
  if (record.code || record.phone) pairStateCache[id] = record;
  else delete pairStateCache[id];
  try {
    localStorage.setItem(
      PAIR_STATE_STORAGE_KEY,
      JSON.stringify(pairStateCache)
    );
  } catch {}
}

function rememberPairPhone(id, digits) {
  if (!id) return;
  if (digits) pairPhones.set(id, digits);
  else pairPhones.delete(id);
  persistPairState(id);
}
const profileInfoSyncs = new Map();
const DEFAULT_AVATAR_SRC = "/media/warest-logo.png";

const LOGIN_MODE_QR = "qr";
const LOGIN_MODE_PHONE = "phone";
const LOGIN_MODE_PAIR = "pair";
const VALID_LOGIN_MODES = [LOGIN_MODE_QR, LOGIN_MODE_PHONE, LOGIN_MODE_PAIR];

const storedLoginMode = localStorage.getItem(LS_KEYS.loginMode);
let loginMethod = VALID_LOGIN_MODES.includes(storedLoginMode)
  ? storedLoginMode
  : LOGIN_MODE_QR;
window.loginMethod = loginMethod;

function clampQrDuration(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.max(5, Math.min(30, Math.round(n)));
}

function setLoginMode(mode) {
  const normalized = VALID_LOGIN_MODES.includes(mode) ? mode : LOGIN_MODE_QR;
  loginMethod = normalized;
  window.loginMethod = normalized;
  try {
    localStorage.setItem(LS_KEYS.loginMode, normalized);
  } catch {}
}

function getLoginMode() {
  return VALID_LOGIN_MODES.includes(loginMethod) ? loginMethod : LOGIN_MODE_QR;
}

function isPhoneEntryMode() {
  return getLoginMode() === LOGIN_MODE_PHONE;
}

function pairModeActive() {
  return getLoginMode() === LOGIN_MODE_PAIR;
}

function isPairingFlowActive() {
  const mode = getLoginMode();
  return mode === LOGIN_MODE_PAIR || mode === LOGIN_MODE_PHONE;
}
const COUNTRY_CODE_OPTIONS = [
  { code: "93", label: "Afghanistan (+93)" },
  { code: "35818", label: "Aland Islands (+35818)" },
  { code: "355", label: "Albania (+355)" },
  { code: "213", label: "Algeria (+213)" },
  { code: "1684", label: "American Samoa (+1684)" },
  { code: "376", label: "Andorra (+376)" },
  { code: "244", label: "Angola (+244)" },
  { code: "1264", label: "Anguilla (+1264)" },
  { code: "1268", label: "Antigua and Barbuda (+1268)" },
  { code: "54", label: "Argentina (+54)" },
  { code: "374", label: "Armenia (+374)" },
  { code: "297", label: "Aruba (+297)" },
  { code: "61", label: "Australia (+61)" },
  { code: "43", label: "Austria (+43)" },
  { code: "994", label: "Azerbaijan (+994)" },
  { code: "1242", label: "Bahamas (+1242)" },
  { code: "973", label: "Bahrain (+973)" },
  { code: "880", label: "Bangladesh (+880)" },
  { code: "1246", label: "Barbados (+1246)" },
  { code: "375", label: "Belarus (+375)" },
  { code: "32", label: "Belgium (+32)" },
  { code: "501", label: "Belize (+501)" },
  { code: "229", label: "Benin (+229)" },
  { code: "1441", label: "Bermuda (+1441)" },
  { code: "975", label: "Bhutan (+975)" },
  { code: "591", label: "Bolivia (+591)" },
  { code: "387", label: "Bosnia and Herzegovina (+387)" },
  { code: "267", label: "Botswana (+267)" },
  { code: "47", label: "Bouvet Island (+47)" },
  { code: "55", label: "Brazil (+55)" },
  { code: "246", label: "British Indian Ocean Territory (+246)" },
  { code: "1284", label: "British Virgin Islands (+1284)" },
  { code: "673", label: "Brunei (+673)" },
  { code: "359", label: "Bulgaria (+359)" },
  { code: "226", label: "Burkina Faso (+226)" },
  { code: "257", label: "Burundi (+257)" },
  { code: "855", label: "Cambodia (+855)" },
  { code: "237", label: "Cameroon (+237)" },
  { code: "1", label: "Canada (+1)" },
  { code: "238", label: "Cape Verde (+238)" },
  { code: "599", label: "Caribbean Netherlands (+599)" },
  { code: "1345", label: "Cayman Islands (+1345)" },
  { code: "236", label: "Central African Republic (+236)" },
  { code: "235", label: "Chad (+235)" },
  { code: "56", label: "Chile (+56)" },
  { code: "86", label: "China (+86)" },
  { code: "61", label: "Christmas Island (+61)" },
  { code: "61", label: "Cocos (Keeling) Islands (+61)" },
  { code: "57", label: "Colombia (+57)" },
  { code: "269", label: "Comoros (+269)" },
  { code: "682", label: "Cook Islands (+682)" },
  { code: "506", label: "Costa Rica (+506)" },
  { code: "385", label: "Croatia (+385)" },
  { code: "53", label: "Cuba (+53)" },
  { code: "599", label: "Curacao (+599)" },
  { code: "357", label: "Cyprus (+357)" },
  { code: "420", label: "Czechia (+420)" },
  { code: "45", label: "Denmark (+45)" },
  { code: "253", label: "Djibouti (+253)" },
  { code: "1767", label: "Dominica (+1767)" },
  { code: "1809", label: "Dominican Republic (+1809)" },
  { code: "243", label: "DR Congo (+243)" },
  { code: "593", label: "Ecuador (+593)" },
  { code: "20", label: "Egypt (+20)" },
  { code: "503", label: "El Salvador (+503)" },
  { code: "240", label: "Equatorial Guinea (+240)" },
  { code: "291", label: "Eritrea (+291)" },
  { code: "372", label: "Estonia (+372)" },
  { code: "268", label: "Eswatini (+268)" },
  { code: "251", label: "Ethiopia (+251)" },
  { code: "500", label: "Falkland Islands (+500)" },
  { code: "298", label: "Faroe Islands (+298)" },
  { code: "679", label: "Fiji (+679)" },
  { code: "358", label: "Finland (+358)" },
  { code: "33", label: "France (+33)" },
  { code: "594", label: "French Guiana (+594)" },
  { code: "689", label: "French Polynesia (+689)" },
  { code: "262", label: "French Southern and Antarctic Lands (+262)" },
  { code: "241", label: "Gabon (+241)" },
  { code: "220", label: "Gambia (+220)" },
  { code: "995", label: "Georgia (+995)" },
  { code: "49", label: "Germany (+49)" },
  { code: "233", label: "Ghana (+233)" },
  { code: "350", label: "Gibraltar (+350)" },
  { code: "30", label: "Greece (+30)" },
  { code: "299", label: "Greenland (+299)" },
  { code: "1473", label: "Grenada (+1473)" },
  { code: "590", label: "Guadeloupe (+590)" },
  { code: "1671", label: "Guam (+1671)" },
  { code: "502", label: "Guatemala (+502)" },
  { code: "44", label: "Guernsey (+44)" },
  { code: "224", label: "Guinea (+224)" },
  { code: "245", label: "Guinea-Bissau (+245)" },
  { code: "592", label: "Guyana (+592)" },
  { code: "509", label: "Haiti (+509)" },
  { code: "504", label: "Honduras (+504)" },
  { code: "852", label: "Hong Kong (+852)" },
  { code: "36", label: "Hungary (+36)" },
  { code: "354", label: "Iceland (+354)" },
  { code: "91", label: "India (+91)" },
  { code: "62", label: "Indonesia (+62)" },
  { code: "98", label: "Iran (+98)" },
  { code: "964", label: "Iraq (+964)" },
  { code: "353", label: "Ireland (+353)" },
  { code: "44", label: "Isle of Man (+44)" },
  { code: "972", label: "Israel (+972)" },
  { code: "39", label: "Italy (+39)" },
  { code: "225", label: "Ivory Coast (+225)" },
  { code: "1876", label: "Jamaica (+1876)" },
  { code: "81", label: "Japan (+81)" },
  { code: "44", label: "Jersey (+44)" },
  { code: "962", label: "Jordan (+962)" },
  { code: "76", label: "Kazakhstan (+76)" },
  { code: "254", label: "Kenya (+254)" },
  { code: "686", label: "Kiribati (+686)" },
  { code: "383", label: "Kosovo (+383)" },
  { code: "965", label: "Kuwait (+965)" },
  { code: "996", label: "Kyrgyzstan (+996)" },
  { code: "856", label: "Laos (+856)" },
  { code: "371", label: "Latvia (+371)" },
  { code: "961", label: "Lebanon (+961)" },
  { code: "266", label: "Lesotho (+266)" },
  { code: "231", label: "Liberia (+231)" },
  { code: "218", label: "Libya (+218)" },
  { code: "423", label: "Liechtenstein (+423)" },
  { code: "370", label: "Lithuania (+370)" },
  { code: "352", label: "Luxembourg (+352)" },
  { code: "853", label: "Macau (+853)" },
  { code: "261", label: "Madagascar (+261)" },
  { code: "265", label: "Malawi (+265)" },
  { code: "60", label: "Malaysia (+60)" },
  { code: "960", label: "Maldives (+960)" },
  { code: "223", label: "Mali (+223)" },
  { code: "356", label: "Malta (+356)" },
  { code: "692", label: "Marshall Islands (+692)" },
  { code: "596", label: "Martinique (+596)" },
  { code: "222", label: "Mauritania (+222)" },
  { code: "230", label: "Mauritius (+230)" },
  { code: "262", label: "Mayotte (+262)" },
  { code: "52", label: "Mexico (+52)" },
  { code: "691", label: "Micronesia (+691)" },
  { code: "373", label: "Moldova (+373)" },
  { code: "377", label: "Monaco (+377)" },
  { code: "976", label: "Mongolia (+976)" },
  { code: "382", label: "Montenegro (+382)" },
  { code: "1664", label: "Montserrat (+1664)" },
  { code: "212", label: "Morocco (+212)" },
  { code: "258", label: "Mozambique (+258)" },
  { code: "95", label: "Myanmar (+95)" },
  { code: "264", label: "Namibia (+264)" },
  { code: "674", label: "Nauru (+674)" },
  { code: "977", label: "Nepal (+977)" },
  { code: "31", label: "Netherlands (+31)" },
  { code: "687", label: "New Caledonia (+687)" },
  { code: "64", label: "New Zealand (+64)" },
  { code: "505", label: "Nicaragua (+505)" },
  { code: "227", label: "Niger (+227)" },
  { code: "234", label: "Nigeria (+234)" },
  { code: "683", label: "Niue (+683)" },
  { code: "672", label: "Norfolk Island (+672)" },
  { code: "850", label: "North Korea (+850)" },
  { code: "389", label: "North Macedonia (+389)" },
  { code: "1670", label: "Northern Mariana Islands (+1670)" },
  { code: "47", label: "Norway (+47)" },
  { code: "968", label: "Oman (+968)" },
  { code: "92", label: "Pakistan (+92)" },
  { code: "680", label: "Palau (+680)" },
  { code: "970", label: "Palestine (+970)" },
  { code: "507", label: "Panama (+507)" },
  { code: "675", label: "Papua New Guinea (+675)" },
  { code: "595", label: "Paraguay (+595)" },
  { code: "51", label: "Peru (+51)" },
  { code: "63", label: "Philippines (+63)" },
  { code: "64", label: "Pitcairn Islands (+64)" },
  { code: "48", label: "Poland (+48)" },
  { code: "351", label: "Portugal (+351)" },
  { code: "1787", label: "Puerto Rico (+1787)" },
  { code: "974", label: "Qatar (+974)" },
  { code: "242", label: "Republic of the Congo (+242)" },
  { code: "262", label: "Reunion (+262)" },
  { code: "40", label: "Romania (+40)" },
  { code: "73", label: "Russia (+73)" },
  { code: "250", label: "Rwanda (+250)" },
  { code: "590", label: "Saint Barthelemy (+590)" },
  { code: "290", label: "Saint Helena, Ascension and Tristan da Cunha (+290)" },
  { code: "1869", label: "Saint Kitts and Nevis (+1869)" },
  { code: "1758", label: "Saint Lucia (+1758)" },
  { code: "590", label: "Saint Martin (+590)" },
  { code: "508", label: "Saint Pierre and Miquelon (+508)" },
  { code: "1784", label: "Saint Vincent and the Grenadines (+1784)" },
  { code: "685", label: "Samoa (+685)" },
  { code: "378", label: "San Marino (+378)" },
  { code: "239", label: "Sao Tome and Principe (+239)" },
  { code: "966", label: "Saudi Arabia (+966)" },
  { code: "221", label: "Senegal (+221)" },
  { code: "381", label: "Serbia (+381)" },
  { code: "248", label: "Seychelles (+248)" },
  { code: "232", label: "Sierra Leone (+232)" },
  { code: "65", label: "Singapore (+65)" },
  { code: "1721", label: "Sint Maarten (+1721)" },
  { code: "421", label: "Slovakia (+421)" },
  { code: "386", label: "Slovenia (+386)" },
  { code: "677", label: "Solomon Islands (+677)" },
  { code: "252", label: "Somalia (+252)" },
  { code: "27", label: "South Africa (+27)" },
  { code: "500", label: "South Georgia (+500)" },
  { code: "82", label: "South Korea (+82)" },
  { code: "211", label: "South Sudan (+211)" },
  { code: "34", label: "Spain (+34)" },
  { code: "94", label: "Sri Lanka (+94)" },
  { code: "249", label: "Sudan (+249)" },
  { code: "597", label: "Suriname (+597)" },
  { code: "4779", label: "Svalbard and Jan Mayen (+4779)" },
  { code: "46", label: "Sweden (+46)" },
  { code: "41", label: "Switzerland (+41)" },
  { code: "963", label: "Syria (+963)" },
  { code: "886", label: "Taiwan (+886)" },
  { code: "992", label: "Tajikistan (+992)" },
  { code: "255", label: "Tanzania (+255)" },
  { code: "66", label: "Thailand (+66)" },
  { code: "670", label: "Timor-Leste (+670)" },
  { code: "228", label: "Togo (+228)" },
  { code: "690", label: "Tokelau (+690)" },
  { code: "676", label: "Tonga (+676)" },
  { code: "1868", label: "Trinidad and Tobago (+1868)" },
  { code: "216", label: "Tunisia (+216)" },
  { code: "90", label: "Turkey (+90)" },
  { code: "993", label: "Turkmenistan (+993)" },
  { code: "1649", label: "Turks and Caicos Islands (+1649)" },
  { code: "688", label: "Tuvalu (+688)" },
  { code: "256", label: "Uganda (+256)" },
  { code: "380", label: "Ukraine (+380)" },
  { code: "971", label: "United Arab Emirates (+971)" },
  { code: "44", label: "United Kingdom (+44)" },
  { code: "1201", label: "United States (+1201)" },
  { code: "268", label: "United States Minor Outlying Islands (+268)" },
  { code: "1340", label: "United States Virgin Islands (+1340)" },
  { code: "598", label: "Uruguay (+598)" },
  { code: "998", label: "Uzbekistan (+998)" },
  { code: "678", label: "Vanuatu (+678)" },
  { code: "3906698", label: "Vatican City (+3906698)" },
  { code: "58", label: "Venezuela (+58)" },
  { code: "84", label: "Vietnam (+84)" },
  { code: "681", label: "Wallis and Futuna (+681)" },
  { code: "2125288", label: "Western Sahara (+2125288)" },
  { code: "967", label: "Yemen (+967)" },
  { code: "260", label: "Zambia (+260)" },
  { code: "263", label: "Zimbabwe (+263)" },
];

const COUNTRY_CODE_LIST = [
  ...new Set(COUNTRY_CODE_OPTIONS.map((c) => c.code)),
].sort((a, b) => b.length - a.length);
const DEFAULT_COUNTRY_CODE = "62";
let countryOptionsReady = false;

const WEBHOOK_EVENT_TAGS = ["message_received"];
const el = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const LOGIN_ROUTE = "/login";

AUTH?.subscribe?.((event, payload, meta = {}) => {
  if (meta?.self) return;
  if (event === "logout") {
    forceLogout(payload?.reason || "Signed out remotely", { remote: true });
    return;
  }
  if (event === "login") {
    loadInputsFromStorage();
    if (typeof payload?.isAdmin === "boolean") {
      setUIByRole(payload.isAdmin);
    }
    if (!ioClient?.connected && (payload?.apiKey || el("apiKey")?.value)) {
      connectSocket({ silent: true });
    }
  }
});

const buildNextLocation = () => {
  try {
    return (window.location.pathname || "/") + (window.location.search || "");
  } catch {
    return "/";
  }
};

function clearAuthState({ broadcast = true, reason = "" } = {}) {
  try {
    if (AUTH?.clearSession) {
      AUTH.clearSession(reason, { broadcast, source: "dashboard" });
    } else {
      localStorage.removeItem(LS_KEYS.apiKey);
      localStorage.removeItem(LS_KEYS.baseUrl);
      localStorage.removeItem(LS_KEYS.username);
      localStorage.removeItem(LS_KEYS.isAdmin);
    }
    localStorage.removeItem(LS_KEYS.currentSessionId);
  } catch {}
  if (el("apiKey")) el("apiKey").value = "";
}

function navigateToLogin(reason, options = {}) {
  const { skipClear = false, broadcast = true } = options;
  if (!skipClear) clearAuthState({ broadcast, reason });
  const params = new URLSearchParams({ next: buildNextLocation() });
  if (reason) params.set("reason", reason);
  window.location.href = `${LOGIN_ROUTE}?${params.toString()}`;
}

function forceLogout(reason, options = {}) {
  const { remote = false } = options;
  try {
    logoutSocket();
  } catch {}
  try {
    clearAuthState({
      broadcast: !remote,
      reason: reason || (remote ? "remote logout" : ""),
    });
    if (!remote) {
      fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    }
  } catch {}
  setConnectedUI(false);
  setAppVisible(false);
  navigateToLogin(reason, { skipClear: true });
}

function genWebhookSecret(len = 12) {
  try {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const arr = new Uint8Array(len);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    let out = "";
    for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
    return out;
  } catch {
    return Math.random()
      .toString(36)
      .slice(2, 2 + len);
  }
}

(function ensureCssEscape() {
  if (!window.CSS) window.CSS = {};
  if (typeof window.CSS.escape !== "function") {
    window.CSS.escape = function (value) {
      return String(value)
        .replace(/[\0-\x1F\x7F]/g, "\uFFFD")
        .replace(/(^-?\d)|[^a-zA-Z0-9_\-]/g, (m, isNumStart) =>
          isNumStart ? "\\3" + m.charCodeAt(0).toString(16) + " " : "\\" + m
        );
    };
  }
})();

function escapeHTML(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getCountryCodeSelect() {
  return document.getElementById("countryCodeSelect");
}

function getPairPhoneInput() {
  return document.getElementById("pairPhone");
}

function ensureCountryOptions() {
  const select = getCountryCodeSelect();
  if (!select || countryOptionsReady) return;
  select.innerHTML = COUNTRY_CODE_OPTIONS.map(
    (opt) =>
      `<option value="${escapeHTML(opt.code)}">${escapeHTML(
        opt.label
      )}</option>`
  ).join("");
  select.value = DEFAULT_COUNTRY_CODE;
  countryOptionsReady = true;
}

function digitsOnly(value) {
  return String(value || "").replace(/\D+/g, "");
}

function splitPhoneDigits(full) {
  const digits = digitsOnly(full);
  if (!digits) return { code: DEFAULT_COUNTRY_CODE, local: "" };
  const code = COUNTRY_CODE_LIST.find((c) => digits.startsWith(c));
  const matched = code || DEFAULT_COUNTRY_CODE;
  return { code: matched, local: digits.slice(matched.length) };
}

function setPhoneInputsFromDigits(full) {
  ensureCountryOptions();
  const { code, local } = splitPhoneDigits(full);
  const select = getCountryCodeSelect();
  if (select) {
    select.value = code;
    if (select.value !== code) select.value = DEFAULT_COUNTRY_CODE;
  }
  const input = getPairPhoneInput();
  if (input) input.value = local;
  updatePairLinkedNumber(full || "");
}

function getCombinedPhoneFromInputs() {
  ensureCountryOptions();
  const select = getCountryCodeSelect();
  const input = getPairPhoneInput();
  const code =
    digitsOnly(select?.value || DEFAULT_COUNTRY_CODE) || DEFAULT_COUNTRY_CODE;
  let local = digitsOnly(input?.value || "");
  if (!local) return "";
  if (local.startsWith(code)) local = local.slice(code.length);
  local = local.replace(/^0+/, "");
  return `${code}${local}`;
}

function updatePairLinkedNumber(digits) {
  const node = document.getElementById("pairLinkedNumber");
  if (!node) return;
  const value = digitsOnly(digits || getCurrentPairPhone());
  node.textContent = value ? `+${value}` : "-";
}

function formatDisplayPhone(digits) {
  const clean = digitsOnly(digits);
  return clean ? `+${clean}` : "--";
}

function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function pairModeActive() {
  return getLoginMode() === LOGIN_MODE_PAIR;
}

function setQrAreaMode(mode) {
  const area = document.getElementById("qrArea");
  if (!area) return;
  const normalized =
    mode === LOGIN_MODE_PAIR
      ? "pair"
      : mode === LOGIN_MODE_PHONE
      ? "phone"
      : "qr";
  area.dataset.mode = normalized;
  const wrap = document.getElementById("qrWrap");
  if (wrap) wrap.dataset.mode = normalized;
  const steps = document.getElementById("linkSteps");
  if (steps) steps.dataset.mode = normalized;
}

function setPairStatusText(text) {
  const node = document.getElementById("pairCodeStatus");
  if (!node) return;
  if (text) {
    node.textContent = text;
    node.classList.remove("hidden");
  } else {
    node.textContent = "";
    node.classList.add("hidden");
  }
}

function setPairErrorText(text) {
  const wrap = document.getElementById("pairCodeError");
  const body = document.getElementById("pairCodeErrorText");
  if (!wrap || !body) return;
  if (text) {
    body.textContent = text;
    wrap.classList.remove("hidden");
  } else {
    body.textContent = "";
    wrap.classList.add("hidden");
  }
}

function setPairRefreshVisible(show, labelText) {
  const btn = document.getElementById("btnPairRefresh");
  const card = document.getElementById("pairCodeCard");
  if (card) card.classList.toggle("is-empty", !!show);
  if (!btn) return;
  btn.setAttribute("aria-hidden", show ? "false" : "true");
  btn.tabIndex = show ? 0 : -1;
  const labelNode = document.getElementById("pairCodeRefreshLabel");
  if (labelNode) {
    labelNode.textContent = labelText || "Refresh to show code";
  }
}

function setPairRefreshBusy(busy) {
  const btn = document.getElementById("btnPairRefresh");
  if (!btn) return;
  btn.classList.toggle("is-busy", !!busy);
  btn.disabled = !!busy;
}

function setAppVisible(visible) {
  const sections = [
    el("secSessions"),
    el("secMessaging"),
    el("secHealth"),
  ].filter(Boolean);
  sections.forEach((n) => {
    n.style.display = visible ? "" : "none";
  });
}

function setUIByRole(role) {
  const isAdmin =
    typeof role === "boolean"
      ? role
      : String(role || "").toLowerCase() === "admin";
  currentRole = isAdmin ? "admin" : "user";
  const sSess = el("secSessions");
  const sMsg = el("secMessaging");
  const sHealth = el("secHealth");
  if (sSess) sSess.style.display = "";
  if (sMsg) sMsg.style.display = "";
  if (sHealth) sHealth.style.display = "";
  document.body.classList.toggle("role-admin", isAdmin);
  document.body.classList.toggle("role-user", !isAdmin);
}

const _initialAuthSession = AUTH?.getSession?.();
if (typeof _initialAuthSession?.isAdmin === "boolean") {
  setUIByRole(_initialAuthSession.isAdmin);
}

function toast(msg, kind = "ok") {
  const t = document.querySelector(".toast");
  if (!t) return;
  t.textContent = msg;
  t.style.borderColor =
    kind === "ok" ? "#16a34a" : kind === "warn" ? "#eab308" : "#ef4444";
  t.style.background =
    kind === "ok" ? "#0aa4436d" : kind === "warn" ? "#edb30689" : "#b104048e";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function setSockDot(state) {
  const dot = el("sockDot");
  if (!dot) return;
  dot.classList.remove("status-online", "status-offline", "status-reconn");
  if (state === "online") dot.classList.add("status-online");
  else if (state === "reconn") dot.classList.add("status-reconn");
  else dot.classList.add("status-offline");
  dot.title =
    state === "online"
      ? "WARest UI online"
      : state === "reconn"
      ? "reconnecting..."
      : "WARest UI offline";
}

function gateButtons(disabled) {
  ["btnCreate", "btnRefresh", "btnDeleteSess"].forEach((id) => {
    const b = el(id);
    if (b) b.disabled = disabled;
  });
}

function setBtnBusy(btn, busy, idleLabel, busyLabel) {
  if (!btn) return;
  if (busy) {
    btn.dataset.wasDisabled = btn.disabled ? "1" : "0";
    btn.disabled = true;
  } else {
    const prev = btn.dataset.wasDisabled;
    if (typeof prev !== "undefined") {
      btn.disabled = prev === "1";
      delete btn.dataset.wasDisabled;
    } else {
      btn.disabled = false;
    }
  }
  btn.textContent = busy ? busyLabel : idleLabel;
  try {
    btn.setAttribute("aria-busy", busy ? "true" : "false");
    btn.classList.toggle("is-busy", !!busy);
  } catch {}
}

function getQRBox() {
  const box =
    document.getElementById("qrBox") || document.querySelector("#qrArea .qr");
  if (box && getComputedStyle(box).position === "static") {
    box.style.position = "relative";
  }
  return box;
}

function ensureQRLoadingNode() {
  const box = getQRBox();
  if (!box) return null;
  let n = document.getElementById("qrLoading");
  if (!n) {
    n = document.createElement("div");
    n.id = "qrLoading";
    Object.assign(n.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      fontWeight: "600",
      fontSize: "14px",
      color: "#d1d5db",
      background: "rgba(0,0,0,0.10)",
      pointerEvents: "none",
      borderRadius: "12px",
      display: "none",
    });
    n.textContent = "Loading QR...";
    box.appendChild(n);
  }
  return n;
}

function setQRLoading(loading, label) {
  const loader = ensureQRLoadingNode();
  if (loader) {
    loader.style.display = loading ? "flex" : "none";
    loader.textContent = loading
      ? typeof label === "string" && label
        ? label
        : "Loading QR..."
      : loader.textContent;
  }
  const img = el("qrImg");
  if (img) {
    img.style.opacity = loading ? "0.25" : "";
    img.style.visibility =
      loading && label === "Scanning..." ? "hidden" : "visible";
  }
  if (loading && label === "Scanning...") resetQrWaitTimer();
}

function ensureQrRefreshOverlay() {
  const box = getQRBox();
  if (!box) return null;
  let ov = document.getElementById("qrRefreshOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "qrRefreshOverlay";
    ov.className = "qr-refresh-overlay";
    ov.innerHTML = `
      <button type="button" class="qr-refresh-cta" aria-label="Klik to refresh QR">
        <span class="qr-refresh-icon" aria-hidden="true">⟳</span>
        <span class="qr-refresh-label">Klik to refresh QR</span>
      </button>
    `;
    box.appendChild(ov);
    const cta = ov.querySelector(".qr-refresh-cta");
    if (cta && !cta.dataset.bound) {
      cta.dataset.bound = "1";
      cta.addEventListener("click", () => {
        try {
          qrPausedForInactivity = false;
          resetQrWaitTimer();
          setQRVisible(true);
          setQRLoading(true, "Refreshing QR...");
          refreshQrForCurrentSession();
        } catch {}
      });
    }
  }
  return ov;
}

function showQrRefreshOverlay(opts = {}) {
  const optObj = typeof opts === "object" && opts ? opts : {};
  const { sticky = false } = optObj;
  const ov = ensureQrRefreshOverlay();
  if (!ov) return;
  const cta = ov.querySelector(".qr-refresh-cta");
  if (cta) cta.style.display = "inline-flex";
  try {
    ov.classList.add("is-visible");
  } catch {}
  try {
    if (qrRefreshOverlayHideTimer) clearTimeout(qrRefreshOverlayHideTimer);
  } catch {}
  if (!sticky) {
    qrRefreshOverlayHideTimer = setTimeout(() => hideQrRefreshOverlay(), 1400);
  } else {
    qrRefreshOverlayHideTimer = 0;
  }
}

function hideQrRefreshOverlay() {
  const ov = document.getElementById("qrRefreshOverlay");
  if (ov) ov.classList.remove("is-visible");
  try {
    if (qrRefreshOverlayHideTimer) clearTimeout(qrRefreshOverlayHideTimer);
  } catch {}
  qrRefreshOverlayHideTimer = 0;
}

function resetQrWaitTimer() {
  qrWaitingSince = 0;
  qrPausedForInactivity = false;
  hideQrRefreshOverlay();
}

function markQrWaiting(id = currentSessionId) {
  if (!shouldAllowQrRequest(id)) return;
  qrPausedForInactivity = false;
  if (!qrWaitingSince) qrWaitingSince = Date.now();
}

function stopQrCountdown() {
  try {
    if (qrCountdownTimer) clearInterval(qrCountdownTimer);
  } catch {}
  qrCountdownTimer = 0;
  qrExpireAt = 0;
  activeQrSessionId = "";
  qrPausedForInactivity = false;
  hideQrRefreshOverlay();
}

function wasEverOpen(id) {
  return sessionWasOpen.get(id) === true;
}

async function maybePrefetchNextQR(id) {
  try {
    if (!id || id !== currentSessionId) return;
    if (!shouldAllowQrRequest(id)) return;
    if (qrPausedForInactivity) return;
    if (qrPrefetching && qrPrefetchForId === id) return;
    qrPrefetching = true;
    qrPrefetchForId = id;
    const resp = await api(
      `/api/v1/session/create?sessionId=${encodeURIComponent(id)}`
    ).catch(() => null);
    const detail = extractResult(resp) || {};
    if (detail?.qr && id === currentSessionId) {
      renderQRImage(
        detail.qr,
        id,
        Number(detail.qrDuration || qrDefaultDuration)
      );
    }
  } catch {
  } finally {
    qrPrefetching = false;
    qrPrefetchForId = "";
  }
}

function resetPairPhoneFor(id) {
  try {
    if (id) rememberPairPhone(id, "");
  } catch {}
  try {
    const inl = getPairPhoneInput();
    if (inl) inl.value = "";
  } catch {}
  try {
    const select = getCountryCodeSelect();
    if (select) select.value = DEFAULT_COUNTRY_CODE;
  } catch {}
  updatePairLinkedNumber("");
}

function restorePairPhoneInputs(id) {
  if (!id) return;
  const stored = pairPhones.get(id);
  if (stored) {
    try {
      setPhoneInputsFromDigits(stored);
    } catch {}
    return;
  }
  resetPairPhoneFor(id);
}

async function maybeAutoReconnect(id) {
  try {
    if (!id || id !== currentSessionId) return;
    const now = Date.now();
    const last = autoReconnectTs.get(id) || 0;
    if (now - last < 15000) return;
    autoReconnectTs.set(id, now);
    const resp = await api(
      `/api/v1/session/create?sessionId=${encodeURIComponent(id)}`
    ).catch(() => null);
    const detail = extractResult(resp) || {};
    const hasQR = !!detail?.qr;
    const hasPair = !!detail?.pairCode;
    if (hasQR || hasPair) return;
    await api(`/api/v1/session/reconnect?sessionId=${encodeURIComponent(id)}`);
  } catch {}
}

function setSessionStatus(id, status) {
  if (!id) return;
  const s = String(status || "unknown").toLowerCase();
  const prev = String(sessionStatus.get(id) || "unknown").toLowerCase();
  if (s === "open") sessionWasOpen.set(id, true);
  if (s === "logged_out" || s === "closed") sessionWasOpen.delete(id);
  sessionStatus.set(id, s);
  if ((s === "starting" || s === "reconnecting") && wasEverOpen(id)) {
    maybeAutoReconnect(id);
  }
  if (id === currentSessionId) {
    setMessagingAvailability(isSessionOpen(id));
  }
}

function isSessionOpen(id) {
  const s = String(sessionStatus.get(id) || "").toLowerCase();
  return (
    s === "open" ||
    ((s === "starting" || s === "reconnecting" || s === "unknown") &&
      wasEverOpen(id))
  );
}

function isActiveSession(id) {
  return !!id && id === currentSessionId;
}

function shouldAllowQrRequest(id = currentSessionId) {
  return isActiveSession(id) && !isSessionOpen(id);
}

function phoneFromJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const noDev = jid.split(":")[0];
  const beforeAt = noDev.split("@")[0];
  if (/^\d{6,}$/.test(beforeAt)) return beforeAt;
  return beforeAt || "";
}

async function ensureOpenStateFromServer(id) {
  try {
    const resp = await api(`/api/v1/session/list`);
    const resultObj = extractResult(resp);
    const items = resultObj?.items || [];
    items.forEach((it) => setSessionStatus(it?.id, it?.status || "unknown"));
    const found = items.find((x) => x?.id === id);
    if (found) return (found.status || "").toLowerCase() === "open";
  } catch {}
  return isSessionOpen(id);
}

function setQRPanelActive(active) {
  const qrWrap = el("qrWrap");
  if (!qrWrap) return;
  qrWrap.classList.toggle("link-device--inactive", !active);
  qrWrap.classList.toggle("link-device--hidden", !active);
  qrWrap.setAttribute("aria-disabled", active ? "false" : "true");
}

function setQRVisible(flag) {
  const area = el("qrArea");
  if (!area) return;
  const allowed = !!flag && shouldAllowQrRequest(currentSessionId);
  setQRPanelActive(allowed);
  const img = el("qrImg");
  const meta = el("qrMeta");
  if (!allowed) {
    if (img) img.src = "";
    if (meta) meta.textContent = "";
    area.classList.add("hidden");
    resetQrWaitTimer();
    setQRLoading(false);
    stopQrCountdown();
    hidePairCode();
    return;
  }
  area.classList.remove("hidden");
  markQrWaiting(currentSessionId);
  const showLoad = !img || !img.src;
  setQRLoading(!!showLoad);
}

function updateCardStatusUI(sessionId) {
  try {
    if (!sessionId) return;
    const card = document.querySelector(
      `.card[data-id="${CSS.escape(sessionId)}"]`
    );
    if (!card) return;
    const pill = card.querySelector(".pill");
    if (pill)
      pill.textContent = displayStatusFor(
        sessionId,
        sessionStatus.get(sessionId) || "-"
      );
    const mutedNodes = Array.from(card.querySelectorAll(".muted"));
    const labelNode = mutedNodes.find((n) =>
      /logged in|not logged in/i.test(n.textContent || "")
    );
    if (labelNode)
      labelNode.textContent = isSessionOpen(sessionId)
        ? "Logged in"
        : "Not logged in";
  } catch {}
}

function displayStatusFor(id, raw) {
  const s = String(raw || "").toLowerCase();
  if (isSessionOpen(id)) return "open";
  return s || "-";
}

function setMessagingAvailability(enabled) {
  const wrap = document.getElementById("msgCards");
  const note = document.getElementById("msgLockNote");
  const allow = !!enabled;
  if (wrap) {
    wrap.classList.toggle("is-disabled", !allow);
    wrap.setAttribute("aria-disabled", (!allow).toString());
    wrap.querySelectorAll(".msg-card").forEach((card) => {
      const original =
        card.dataset.tabindexOriginal || card.getAttribute("tabindex") || "0";
      card.dataset.tabindexOriginal = original;
      card.setAttribute("tabindex", allow ? original : "-1");
      card.setAttribute("aria-disabled", (!allow).toString());
    });
  }
  if (note) note.classList.toggle("hidden", allow);
}

function setActiveSessionAvatar(avatarUrl, allowCustomImage) {
  const wrap = document.querySelector(".session-avatar");
  const avatarImg = el("sessAvatarImg");
  const useCustom = !!avatarUrl && !!allowCustomImage;
  const nextSrc = useCustom ? avatarUrl : DEFAULT_AVATAR_SRC;
  if (avatarImg) {
    if (!avatarImg.getAttribute("referrerpolicy"))
      avatarImg.setAttribute("referrerpolicy", "no-referrer");
    avatarImg.src = nextSrc;
  }
  if (wrap) {
    wrap.classList.toggle("has-photo", useCustom);
  }
}

function syncProfilePictureFromProfileInfo(sessionId) {
  if (!sessionId) return;
  if (!isSessionOpen(sessionId)) return;
  if (profileInfoSyncs.has(sessionId)) return;
  const job = (async () => {
    try {
      const resp = await api(
        `/api/v1/profile/info?sessionId=${encodeURIComponent(sessionId)}`
      ).catch(() => null);
      const info = extractResult(resp) || {};
      if (sessionId !== currentSessionId) return;
      const pic =
        info?.profilePicture?.imgFull ||
        info?.profilePicture?.url ||
        info?.profilePicture?.imgPreview ||
        "";
      setActiveSessionAvatar(pic, isSessionOpen(sessionId));
    } catch (err) {
      if (typeof console !== "undefined" && console.debug) {
        console.debug("[profile-info-sync]", err);
      }
    } finally {
      profileInfoSyncs.delete(sessionId);
    }
  })();
  profileInfoSyncs.set(sessionId, job);
}

const STATUS_PILL_CLASSES = [
  "status-open",
  "status-connection",
  "status-error",
];

function statusClassFor(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized === "open") return "status-open";
  if (normalized.includes("connection")) return "status-connection";
  return "status-error";
}

function applyStatusPillClass(node, label) {
  if (!node || !node.classList) return;
  STATUS_PILL_CLASSES.forEach((cls) => node.classList.remove(cls));
  node.classList.add(statusClassFor(label));
}

function updateActiveLogoutButton(id, statusLabel) {
  const btn = el("btnActiveLogout");
  if (!btn) return;
  const normalized = String(statusLabel || "").toLowerCase();
  const canLogout =
    !!id &&
    (normalized === "open" ||
      normalized.includes("logged in") ||
      isSessionOpen(id));
  btn.hidden = !canLogout;
  btn.disabled = !canLogout;
  btn.dataset.id = canLogout ? id : "";
}

function startQrCountdown({ sessionId, durationSec }) {
  stopQrCountdown();
  const meta = el("qrMeta");
  const d = clampQrDuration(durationSec || qrDefaultDuration || 20);
  qrDefaultDuration = d;
  qrExpireAt = Date.now() + Math.max(5, d) * 1000;
  activeQrSessionId = sessionId || "";
  let prevLeft = Math.max(0, Math.ceil((qrExpireAt - Date.now()) / 1000));
  const tick = () => {
    const now = Date.now();
    let left = Math.max(0, Math.ceil((qrExpireAt - now) / 1000));
    if (left > prevLeft) left = prevLeft;
    const waitingTooLong =
      qrWaitingSince &&
      now - qrWaitingSince >= QR_INACTIVITY_MS &&
      shouldAllowQrRequest(activeQrSessionId);
    if (waitingTooLong) {
      if (!qrPausedForInactivity) {
        qrPausedForInactivity = true;
        setQRLoading(false);
        showQrRefreshOverlay({ sticky: true });
        if (meta && activeQrSessionId && !isPairingFlowActive()) {
          meta.textContent = `Session: ${activeQrSessionId}  refresh paused`;
        }
      }
      try {
        if (qrCountdownTimer) clearInterval(qrCountdownTimer);
      } catch {}
      qrCountdownTimer = 0;
      return;
    }
    if (meta && activeQrSessionId && !isPairingFlowActive()) {
      meta.textContent = `Session: ${activeQrSessionId}  QR refresh in ${left}s`;
    }
    if (left <= 1) {
      setQRLoading(true, "Refreshing QR...");
      void maybePrefetchNextQR(activeQrSessionId);
      if (left <= 0) stopQrCountdown();
    }
    prevLeft = left;
  };
  tick();
  qrCountdownTimer = setInterval(tick, 1000);
}

function renderQRImage(qr, sessionId, durationSec) {
  if (pairModeActive()) {
    setQrAreaMode(LOGIN_MODE_PAIR);
    setQRLoading(false);
    return;
  }
  if (qrPausedForInactivity && !shouldAllowQrRequest(sessionId)) {
    setQRVisible(false);
    return;
  }
  if (!shouldAllowQrRequest(sessionId)) {
    setQRVisible(false);
    setQRLoading(false);
    return;
  }
  if (isSessionOpen(sessionId)) {
    setQRVisible(false);
    setQRLoading(false);
    return;
  }
  setQRVisible(true);
  hideQrRefreshOverlay();
  markQrWaiting(sessionId);
  const base = (el("baseUrl")?.value.trim() || window.location.origin).replace(
    /\/$/,
    ""
  );
  const img = el("qrImg");
  const meta = el("qrMeta");
  if (img) {
    const isDataUrl = typeof qr === "string" && qr.startsWith("data:");
    const looksBase64Png =
      typeof qr === "string" && qr.length > 200 && !qr.includes(":");
    if (isDataUrl) img.src = qr;
    else if (looksBase64Png) img.src = `data:image/png;base64,${qr}`;
    else img.src = `${base}/utils/qr.png?data=${encodeURIComponent(qr || "")}`;
    img.style.visibility = "visible";
  }
  try {
    if (!isPairingFlowActive()) {
      if (meta) meta.textContent = `Session: ${sessionId}  QR refresh in ...`;
      if (typeof durationSec === "number")
        qrDefaultDuration = clampQrDuration(durationSec || 20);
      qrPausedForInactivity = false;
      startQrCountdown({
        sessionId,
        durationSec: clampQrDuration(durationSec || qrDefaultDuration),
      });
    } else {
      if (meta) meta.textContent = "";
    }
  } catch {}
  setQRLoading(false);
}

function ensurePairCodeDisplay() {
  let node = document.getElementById("pairCodeDisplay");
  if (!node) {
    node = document.createElement("div");
    node.id = "pairCodeDisplay";
    node.className = "hidden";
    const qrMeta = document.getElementById("qrMeta");
    const qrBox =
      document.getElementById("qrBox") || document.querySelector(".qr");
    if (qrBox && qrBox.parentNode)
      qrBox.parentNode.insertBefore(node, qrMeta || qrBox.nextSibling);
  }
  return node;
}

function renderPairCode(code) {
  const img = document.getElementById("qrImg");
  const disp = ensurePairCodeDisplay();
  if (img) img.style.display = "none";
  if (disp) {
    const shown = formatPairCodeDisplay(code) || "Waiting for pair code...";
    disp.textContent = shown;
    disp.classList.remove("hidden");
    disp.classList.add("fade-in");
    setTimeout(() => disp.classList.remove("fade-in"), 350);
  }
  const meta = document.getElementById("qrMeta");
  if (meta) meta.textContent = "Pair code mode";
  setQRVisible(true);
  setQRLoading(false);
}

function normalizePairCodeValue(code) {
  return String(code || "")
    .replace(/[^0-9A-Z]/gi, "")
    .toUpperCase()
    .slice(0, 8);
}

function formatPairCodeDisplay(code) {
  const raw = normalizePairCodeValue(code);
  if (!raw) return "";
  if (raw.length === 8) return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return raw;
}

function clearPairCodeExpiryTimer() {
  if (pairCodeExpiryTimer) {
    try {
      clearTimeout(pairCodeExpiryTimer);
    } catch {}
    pairCodeExpiryTimer = 0;
  }
}

function schedulePairCodeExpiryTimer() {
  clearPairCodeExpiryTimer();
  if (!pairModeActive() || !currentSessionId) return;
  const ts = pairCodeTs.get(currentSessionId) || 0;
  if (!ts) return;
  const age = Date.now() - ts;
  const wait =
    PAIR_CODE_TTL_MS - PAIR_CODE_REFRESH_MARGIN_MS - Math.max(0, age);
  if (wait <= 0) {
    void requestPairCodeForCurrent({ reason: "expired", quiet: true });
    return;
  }
  pairCodeExpiryTimer = setTimeout(() => {
    void requestPairCodeForCurrent({ reason: "expired", quiet: true });
  }, Math.max(2000, wait));
}

function getCurrentPairPhone() {
  const combined = getCombinedPhoneFromInputs();
  if (combined) return combined;
  try {
    if (currentSessionId) {
      const stored = pairPhones.get(currentSessionId) || "";
      if (stored) {
        setPhoneInputsFromDigits(stored);
        return stored;
      }
    }
  } catch {}
  return "";
}

function hidePairCode({ preserveCode = false } = {}) {
  const img = document.getElementById("qrImg");
  const disp = document.getElementById("pairCodeDisplay");
  const area = document.getElementById("pairCodeArea");
  const qrBox = document.querySelector("#qrArea .qr");
  if (img) img.style.display = pairModeActive() ? "none" : "";
  if (disp) disp.classList.add("hidden");
  if (area) {
    if (pairModeActive()) {
      area.classList.remove("hidden");
      const val = document.getElementById("pairCodeVal");
      if (val) val.textContent = PAIR_CODE_PLACEHOLDER;
    } else {
      area.classList.add("hidden");
    }
  }
  if (!pairModeActive() && qrBox) qrBox.classList.remove("hidden");
  try {
    if (currentSessionId && !preserveCode) {
      pairCodes.delete(currentSessionId);
      pairCodeTs.delete(currentSessionId);
      persistPairState(currentSessionId);
    }
  } catch {}
  clearPairCodeExpiryTimer();
  if (pairModeActive()) {
    if (!preserveCode)
      setPairStatusText("Click Get Pair Code to start pairing.");
  } else setPairStatusText("");
  setPairErrorText("");
  setPairRefreshVisible(false);
  setPairRefreshBusy(false);
}

function setPairCode(code, { forceRender = false, timestamp } = {}) {
  const area = document.getElementById("pairCodeArea");
  const val = document.getElementById("pairCodeVal");
  const qrBox = document.querySelector("#qrArea .qr");
  const meta = document.getElementById("qrMeta");
  const normalized = normalizePairCodeValue(code);
  const shouldRender = forceRender || pairModeActive();
  if (normalized && currentSessionId && isSessionOpen(currentSessionId)) {
    hidePairCode();
    setQRVisible(false);
    setQRLoading(false);
    return normalized;
  }
  if (currentSessionId) {
    if (normalized) {
      try {
        const ts =
          typeof timestamp === "number" && !Number.isNaN(timestamp)
            ? timestamp
            : Date.now();
        pairCodes.set(currentSessionId, normalized);
        pairCodeTs.set(currentSessionId, ts);
      } catch {}
    } else {
      try {
        pairCodes.delete(currentSessionId);
        pairCodeTs.delete(currentSessionId);
      } catch {}
    }
    persistPairState(currentSessionId);
  }
  if (!shouldRender) return normalized;
  setQrAreaMode(LOGIN_MODE_PAIR);
  if (!area || !val) {
    if (normalized) renderPairCode(formatPairCodeDisplay(normalized));
    else hidePairCode();
    return normalized;
  }
  if (normalized) {
    const display = formatPairCodeDisplay(normalized);
    val.textContent = display || PAIR_CODE_PLACEHOLDER;
    area.classList.remove("hidden");
    area.classList.add("fade-in");
    setTimeout(() => area.classList.remove("fade-in"), 400);
    if (qrBox) qrBox.classList.add("hidden");
    if (meta) meta.textContent = "";
    setQRLoading(false);
    setPairStatusText(
      "Enter this code in WhatsApp > Linked Devices > Enter pair code."
    );
    setPairErrorText("");
    updatePairLinkedNumber();
    schedulePairCodeExpiryTimer();
    setPairRefreshVisible(false);
    setPairRefreshBusy(false);
  } else {
    val.textContent = PAIR_CODE_PLACEHOLDER;
    area.classList.remove("hidden");
    const hasPhone = !!getCurrentPairPhone();
    if (hasPhone) {
      setPairStatusText("Refresh to show the latest pairing code.");
      setPairErrorText("");
      setPairRefreshVisible(true, "Refresh to show code");
      setPairRefreshBusy(false);
    } else {
      setPairStatusText(
        "Enter the WhatsApp number (e.g. 628...) then click Get Pair Code."
      );
      setPairRefreshVisible(false);
    }
    clearPairCodeExpiryTimer();
  }
  maybeStartPairCodeRefresh();
  return normalized;
}

function stopPairCodeRefresh() {
  if (pairCodeRefreshTimer) {
    try {
      clearInterval(pairCodeRefreshTimer);
    } catch {}
    pairCodeRefreshTimer = 0;
  }
  clearPairCodeExpiryTimer();
}

function shouldAutoFetchPairCode() {
  if (!currentSessionId) return false;
  const ts = pairCodeTs.get(currentSessionId) || 0;
  const hasCode = pairCodes.has(currentSessionId);
  if (!hasCode) return true;
  const age = Date.now() - ts;
  return age >= PAIR_CODE_TTL_MS - PAIR_CODE_REFRESH_MARGIN_MS;
}

function maybeStartPairCodeRefresh() {
  if (pairCodeRefreshTimer) return;
  if (!pairModeActive()) return;
  if (!currentSessionId) return;
  if (!getCurrentPairPhone()) return;
  pairCodeRefreshTimer = setInterval(async () => {
    if (!pairModeActive()) {
      stopPairCodeRefresh();
      return;
    }
    if (!currentSessionId) return;
    const phone = getCurrentPairPhone();
    if (!phone) return;
    if (!shouldAutoFetchPairCode()) return;
    try {
      await requestPairCodeForCurrent({
        reason: pairCodes.has(currentSessionId) ? "expired" : "pending",
        quiet: true,
      });
    } catch {}
  }, 5000);
}

async function requestPairCodeForCurrent({
  reason = "manual",
  quiet = false,
} = {}) {
  try {
    requireSession();
  } catch {
    return null;
  }
  ensureCountryOptions();
  let digits = getCombinedPhoneFromInputs();
  if (!digits && currentSessionId) {
    try {
      digits = pairPhones.get(currentSessionId) || "";
      if (digits) setPhoneInputsFromDigits(digits);
    } catch {}
  }
  if (!digits) {
    if (!quiet && pairModeActive()) {
      setPairStatusText(
        "Enter the WhatsApp number (e.g. 628...) before requesting a pairing code."
      );
      showPhoneLogin();
    }
    return null;
  }
  try {
    if (currentSessionId) rememberPairPhone(currentSessionId, digits);
  } catch {}
  updatePairLinkedNumber(digits);
  if (pairModeActive()) {
    const label =
      reason === "expired"
        ? "Pair code expired, requesting a new one..."
        : reason === "pending"
        ? "Waiting for a pairing code from WhatsApp..."
        : "Requesting pair code...";
    setPairStatusText(label);
  }
  setPairErrorText("");
  try {
    const resp = await api(
      `/api/v1/session/create/pair-code?sessionId=${encodeURIComponent(
        currentSessionId
      )}&phone=${encodeURIComponent(digits)}`
    );
    if (resp?.status === false) {
      const err = new Error(resp?.message || "Pair code not available");
      err.code = resp?.code;
      throw err;
    }
    const detail = extractResult(resp);
    setSessionInfo(detail);
    const openNow = await ensureOpenStateFromServer(currentSessionId);
    if (
      openNow ||
      detail?.status === "open" ||
      isSessionOpen(currentSessionId)
    ) {
      setQRVisible(false);
      setQRLoading(false);
      setPairCode("");
      hidePairCode();
      stopPairCodeRefresh();
      if (pairModeActive())
        setPairStatusText(
          "Session already logged in — pair code not required."
        );
      return detail;
    }
    if (detail?.qr && !pairModeActive()) {
      renderQRImage(
        detail.qr,
        currentSessionId,
        Number(detail.qrDuration || qrDefaultDuration)
      );
    }
    if (detail?.pairCode) setPairCode(detail.pairCode);
    else setPairCode("");
    setQRVisible(true);
    return detail;
  } catch (err) {
    const msg = err?.message || "Pair code not available";
    if (pairModeActive()) setPairErrorText(msg);
    if (!quiet) toast(msg, "err");
    if (pairModeActive())
      setPairStatusText(
        reason === "expired"
          ? "Pair code refresh failed; try again or switch to QR."
          : "Pair code not available right now."
      );
    if (pairModeActive()) setPairRefreshVisible(!!getCurrentPairPhone());
    throw err;
  }
}

function onUnauthorized(msg) {
  forceLogout(msg || "Session expired. Please sign in again.");
}

async function api(path, method = "GET", body, retry = 0) {
  const apiKey = el("apiKey")?.value.trim();
  const base = (el("baseUrl")?.value.trim() || window.location.origin).replace(
    /\/$/,
    ""
  );
  if (!apiKey) {
    onUnauthorized("Missing API Key. Please log in.");
    throw new Error('{"error":"Missing X-WAREST-API-KEY"}');
  }
  const abort = new AbortController();
  const to = setTimeout(() => abort.abort(), 25000);
  try {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-WAREST-API-KEY": apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: abort.signal,
    });
    if (!r.ok) {
      let jsonErr = null;
      try {
        const ct = r.headers.get("content-type") || "";
        if (ct.includes("application/json")) jsonErr = await r.json();
      } catch {}
      if (r.status === 401 || r.status === 403) {
        onUnauthorized("Unauthorized: Invalid or expired API key");
        const err = new Error("Unauthorized: Invalid X-WAREST-API-KEY");
        err.status = r.status;
        throw err;
      }
      const txt =
        jsonErr?.error ||
        jsonErr?.message ||
        (await r.text().catch(() => "")) ||
        r.statusText;
      const err = new Error(txt);
      err.status = r.status;
      if (jsonErr?.retryAfter) err.retryAfter = Number(jsonErr.retryAfter);
      throw err;
    }
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return r.json();
    return { ok: true };
  } catch (e) {
    const st = e && typeof e === "object" ? e.status : undefined;
    if (st === 401 || st === 403) {
      onUnauthorized("Session expired. Please sign in again.");
      throw e;
    }
    const transient =
      e?.name === "AbortError" || !st || (st >= 500 && st <= 599) || st === 408;
    if (transient && retry < 2) {
      await new Promise((r) => setTimeout(r, 650));
      return api(path, method, body, retry + 1);
    }
    throw e;
  } finally {
    clearTimeout(to);
  }
}

function setSessionInfo(s) {
  const wrap = el("sessionInfo");
  if (!wrap) return;
  const idVal = s?.id || s?.sessionId || currentSessionId || "";
  const nameEl = el("sessNameVal");
  const phoneEl = el("sessPhoneVal");
  const idLabel = el("sessIdLabel");
  const statusPill = el("sessStatusPill");
  if (!idVal) {
    wrap.innerHTML = "";
    wrap.classList.add("hidden");
    if (nameEl) nameEl.textContent = "No session selected";
    if (phoneEl) phoneEl.textContent = "Phone: -";
    if (idLabel) idLabel.textContent = "-";
    if (statusPill) {
      statusPill.textContent = "-";
      applyStatusPillClass(statusPill, "-");
    }
    updateActiveLogoutButton("", "");
    setActiveSessionAvatar("", false);
    setMessagingAvailability(false);
    return;
  }
  const me = s?.me || {};
  const who = me?.user || me?.id || me?.jid || s?.phone || "";
  const statusGuess =
    s?.status || (who ? "open" : s?.qr ? "starting" : "unknown");
  const statusVal = (statusGuess || "").toLowerCase();
  const last = s?.lastConn ? new Date(s.lastConn) : null;
  const lastStr = last && !isNaN(last) ? last.toLocaleString() : "-";
  setSessionStatus(idVal, statusVal);
  let phone = s?.phone || phoneFromJid(me?.id || me?.jid || "");
  let device = s?.device || s?.platform || "WARest";
  if (!device || device === "unknown" || device === "undefined")
    device = "WARest";
  const displayStatus = displayStatusFor(idVal, statusVal);
  const isOpenNow =
    String(statusVal || "").toLowerCase() === "open" || isSessionOpen(idVal);
  const pushName = s?.pushName || s?.me?.name || "";
  if (idLabel) idLabel.textContent = idVal;
  if (nameEl)
    nameEl.textContent =
      pushName || (isOpenNow ? "Connected device" : "Waiting for device");
  if (phoneEl) phoneEl.textContent = `Phone: ${formatDisplayPhone(phone)}`;
  if (statusPill) {
    statusPill.textContent = displayStatus;
    applyStatusPillClass(statusPill, displayStatus);
  }
  updateActiveLogoutButton(idVal, displayStatus);
  const avatarUrl =
    s?.me?.imgFull ||
    s?.me?.imgUrl ||
    s?.profilePicture?.url ||
    s?.profilePicture ||
    "";
  setActiveSessionAvatar(avatarUrl, isOpenNow);
  setMessagingAvailability(isOpenNow);
  wrap.innerHTML = `
    <div class="active-meta-card">
      <div class="label">Session</div>
      <div class="value"><code>${escapeHTML(idVal)}</code></div>
    </div>
    <div class="active-meta-card">
      <div class="label">Device</div>
      <div class="value" id="sessDeviceVal">${escapeHTML(
        device || "WARest"
      )}</div>
    </div>
    <div class="active-meta-card">
      <div class="label">Last active</div>
      <div class="value muted" id="sessLastVal">${escapeHTML(lastStr)}</div>
    </div>`;
  wrap.classList.remove("hidden");
  syncProfilePictureFromProfileInfo(idVal);
  try {
    if (
      idVal === currentSessionId &&
      typeof s?.pairCode === "string" &&
      s.pairCode.trim() !== ""
    ) {
      setPairCode(s.pairCode, {
        forceRender: pairModeActive(),
      });
    }
  } catch {}
  try {
    if (!isOpenNow && pairModeActive() && idVal === currentSessionId) {
      const lastCode = pairCodes.get(idVal);
      if (lastCode)
        setPairCode(lastCode, {
          forceRender: true,
          timestamp: pairCodeTs.get(idVal) || Date.now(),
        });
      else maybeStartPairCodeRefresh();
    }
  } catch {}
  if (isOpenNow) {
    setQRVisible(false);
    setQRLoading(false);
    setPairCode("");
    hidePairCode();
  }
  if (isOpenNow) {
    (async () => {
      try {
        const out = await api(
          `/api/v1/session/devices?sessionId=${encodeURIComponent(idVal)}`
        );
        const info = extractResult(out) || {};
        const p = phoneFromJid(info.phone || phone || "");
        let d = info.device || device || "WARest";
        if (!d || d === "unknown" || d === "undefined") d = "WARest";
        const phoneEl = document.getElementById("sessPhoneVal");
        const devEl = document.getElementById("sessDeviceVal");
        if (phoneEl && p)
          phoneEl.textContent = `Phone: ${formatDisplayPhone(p)}`;
        if (devEl) devEl.textContent = d || "WARest";
      } catch {}
    })();
  }
  (async () => {
    try {
      const resp = await api(`/api/v1/session/list`);
      const listResult = extractResult(resp);
      const items = listResult?.items || [];
      const it = items.find((x) => x?.id === idVal);
      if (it) {
        setSessionStatus(idVal, it.status || statusVal);
        const last2 = it?.lastConn ? new Date(it.lastConn) : null;
        const lastStr2 = last2 && !isNaN(last2) ? last2.toLocaleString() : "-";
        const lastEl = document.getElementById("sessLastVal");
        if (lastEl) lastEl.textContent = lastStr2;
        const pill = document.getElementById("sessStatusPill");
        const label = displayStatusFor(idVal, it.status || "-");
        if (pill) {
          pill.textContent = label;
          applyStatusPillClass(pill, label);
        }
        updateActiveLogoutButton(idVal, label);
        const freshAvatar =
          it?.me?.imgFull ||
          it?.me?.imgUrl ||
          it?.profilePicture?.url ||
          it?.profilePicture ||
          avatarUrl;
        setActiveSessionAvatar(
          freshAvatar,
          label === "open" || isSessionOpen(idVal)
        );
        if (!phone) {
          const p2 = it?.me?.id ? phoneFromJid(it.me.id) : "";
          if (p2) {
            const phoneEl = document.getElementById("sessPhoneVal");
            if (phoneEl)
              phoneEl.textContent = `Phone: ${formatDisplayPhone(p2)}`;
          }
        }
        const nameEl = document.getElementById("sessNameVal");
        const nm = it?.pushName || it?.me?.name || "";
        if (nameEl && nm) nameEl.textContent = nm;
      }
    } catch {}
  })();
}

function fillSessionSelect(items) {
  const sel = el("sessionSelect");
  if (!sel) return;
  const old = sel.value;
  sel.innerHTML = '<option value="">-- select session --</option>';
  items.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.id} (${displayStatusFor(s.id, s.status)})`;
    if (s.id === currentSessionId) opt.selected = true;
    sel.appendChild(opt);
    setSessionStatus(s.id, s.status);
  });
  if (!currentSessionId && items.some((x) => x.id === old)) sel.value = old;
}

function updateActiveUI() {
  document.querySelectorAll("#sessions .session-tile").forEach((card) => {
    const id = card.getAttribute("data-id");
    if (!id) return;
    const active = id === currentSessionId;
    card.classList.toggle("is-active", active);
    const btn = card.querySelector(".btn-set-active");
    if (btn) {
      btn.textContent = active ? "Active" : "Set Active";
      btn.classList.toggle("btn-primary", !active);
      btn.classList.toggle("btn-accent", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.disabled = !!active;
    }
  });
  const sel = el("sessionSelect");
  if (sel && currentSessionId) {
    if ([...sel.options].some((o) => o.value === currentSessionId))
      sel.value = currentSessionId;
  }
}

function updateSessionInPairCode(id = currentSessionId) {
  const n = document.getElementById("sessionInPairCode");
  if (n) {
    n.innerHTML = id
      ? `<span class="muted">Session:</span> <code>${escapeHTML(id)}</code>`
      : "";
  }
  updatePairLinkedNumber();
}

function setSessionsLoading(loading) {
  const wrap = el("sessions");
  if (!wrap) return;
  wrap.classList.toggle("loading", !!loading);
  let overlay = wrap.querySelector(".overlay");
  if (loading) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "overlay";
      overlay.innerHTML = `<div class="spinner">Refreshing...</div>`;
      wrap.appendChild(overlay);
    }
  } else {
    if (overlay) overlay.remove();
  }
}

function connectSocket({ silent = false } = {}) {
  const apiKey = el("apiKey")?.value.trim();
  const base = (el("baseUrl")?.value.trim() || window.location.origin).replace(
    /\/$/,
    ""
  );
  if (!apiKey || !base) {
    if (!silent) toast("Please log in to continue", "warn");
    setConnectedUI(false);
    setAppVisible(false);
    navigateToLogin("Please sign in to continue.");
    return;
  }
  AUTH?.ensureDocsSession?.(apiKey);
  if (typeof window.io !== "function") {
    if (!silent) toast("Socket library not loaded", "err");
    return;
  }
  try {
    if (ioClient) {
      ioClient.removeAllListeners();
      ioClient.disconnect();
      ioClient = null;
    }
    ioClient = io(base, {
      transports: ["websocket"],
      auth: { apiKey },
      withCredentials: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    ioClient.on("connect", () => {
      setSockDot("online");
      gateButtons(false);
      setConnectedUI(true);
      setAppVisible(true);
      if (!silent) toast("Socket connected");
      if (currentSessionId) ioClient.emit("join", { room: currentSessionId });
      el("btnRefresh")?.click();
    });
    ioClient.on("welcome", ({ role, isAdmin, version }) => {
      const titleElement = document.getElementById("connect-title");
      if (titleElement) {
        titleElement.textContent.includes("{WARestVersion}") &&
          (titleElement.textContent = titleElement.textContent.replace(
            "{WARestVersion}",
            typeof version !== "undefined" ? version : "0.0.0"
          ));
      }
      if (typeof isAdmin === "boolean") setUIByRole(isAdmin);
      else if (role) setUIByRole(role);
    });
    ioClient.on("reconnect_attempt", () => setSockDot("reconn"));
    ioClient.on("reconnect", () => {
      setSockDot("online");
      gateButtons(false);
      setConnectedUI(true);
      setAppVisible(true);
      if (currentSessionId) ioClient.emit("join", { room: currentSessionId });
      el("btnRefresh")?.click();
    });
    ioClient.on("reconnect_error", () => setSockDot("reconn"));
    ioClient.on("reconnect_failed", () => {
      setSockDot("offline");
      gateButtons(true);
      setConnectedUI(false);
    });
    ioClient.on("sessions_changed", () => {
      try {
        el("btnRefresh")?.click();
      } catch {}
    });
    ioClient.on("connect_error", (err) => {
      setSockDot("offline");
      gateButtons(true);
      setConnectedUI(false);
      currentRole = null;
      const unauthorized =
        err?.data?.code === 401 ||
        err?.message?.toLowerCase?.().includes("unauthorized") ||
        err?.message?.toLowerCase?.().includes("invalid");
      if (unauthorized) {
        onUnauthorized("Unauthorized: Please sign in again");
      } else {
        if (!silent) {
          let msg = "connect_error";
          if (err && (err.message || err.data)) msg = err.message || err.data;
          toast("Error: " + msg, "err");
        }
      }
      console.debug("[socket connect_error]", err);
    });
    ioClient.on("disconnect", (reason) => {
      setSockDot("offline");
      setConnectedUI(false);
      currentRole = null;
      if (reason !== "io client disconnect")
        toast("Disconnected: " + reason, "warn");
    });
    ioClient.on("qr", ({ id, qr, qrDuration }) => {
      if (id !== currentSessionId) return;
      if (isSessionOpen(id)) return;
      if (isPairingFlowActive()) return;
      if (typeof qrDuration === "number")
        qrDefaultDuration = clampQrDuration(qrDuration);
      renderQRImage(qr, id, Number(qrDuration || qrDefaultDuration));
    });
    ioClient.on("pairing_code", ({ id, code }) => {
      if (id !== currentSessionId) return;
      if (isSessionOpen(id)) return;
      setPairCode(code);
    });
    ioClient.on("ready", ({ id }) => {
      if (id !== currentSessionId) return;
      setSessionStatus(id, "open");
      setQRVisible(false);
      setQRLoading(false);
      stopQrCountdown();
      setPairCode("");
      hidePairCode();
      stopPairCodeRefresh();
      updateCardStatusUI(id);
      el("btnRefresh")?.click();
    });
    ioClient.on("closed", async ({ id }) => {
      if (id !== currentSessionId) return;
      try {
        const stillOpen = await ensureOpenStateFromServer(id);
        if (stillOpen) {
          setSessionStatus(id, "open");
          setQRVisible(false);
          setQRLoading(false);
          setPairCode("");
          hidePairCode();
          updateCardStatusUI(id);
          maybeAutoReconnect(id);
          return;
        }
      } catch {}
      setSessionStatus(id, "closed");
      toast(`Session "${id}" closed`, "warn");
      if (pairModeActive()) {
        try {
          await requestPairCodeForCurrent({ reason: "pending", quiet: true });
        } catch {}
        if (!ioClient?.connected) maybeStartPairCodeRefresh();
      } else {
        if (!isSessionOpen(id)) {
          setQRVisible(true);
          setQRLoading(true, "Scanning...");
          setPairCode("");
        } else {
          setQRVisible(false);
        }
      }
      el("btnRefresh")?.click();
    });
  } catch (e) {
    console.error(e);
    if (!silent) toast(e.message || "Socket init failed", "err");
    setConnectedUI(false);
  }
}

function setConnectedUI(connected) {
  const s1 = el("secSessions");
  const s2 = el("secMessaging");
  const s3 = el("secHealth");
  if (s1) s1.style.display = connected ? "" : "none";
  if (s2) s2.style.display = connected ? "" : "none";
  if (s3) s3.style.display = connected ? "" : "none";
  const btn = el("btnLoad");
  if (btn) {
    if (connected) {
      btn.textContent = "Log Out";
      btn.classList.remove("btn-primary");
      btn.classList.add("btn-danger");
      btn.setAttribute("aria-label", "Log out from Socket");
    } else {
      btn.textContent = "Connect";
      btn.classList.remove("btn-danger");
      btn.classList.add("btn-primary");
      btn.setAttribute("aria-label", "Connect to Socket");
    }
  }
}

function logoutSocket() {
  try {
    if (ioClient) {
      ioClient.removeAllListeners();
      ioClient.disconnect();
      ioClient = null;
    }
  } catch {}
  currentRole = null;
  setSockDot("offline");
  gateButtons(true);
  setConnectedUI(false);
  setQRVisible(false);
  setQRLoading(false);
  stopAutoReconnectMonitor();
}

function persistInputs() {
  const apiKeyValue = el("apiKey")?.value.trim() || "";
  const baseValue = el("baseUrl")?.value.trim() || "";
  if (AUTH?.setSession) {
    const existing = (AUTH.getSession && AUTH.getSession()) || {};
    AUTH.setSession(
      {
        apiKey: apiKeyValue,
        baseUrl:
          baseValue ||
          existing.baseUrl ||
          (window.location && window.location.origin) ||
          "",
        username: existing.username || "",
      },
      { broadcast: false, source: "dashboard" }
    );
  } else {
    localStorage.setItem(LS_KEYS.apiKey, apiKeyValue);
    localStorage.setItem(LS_KEYS.baseUrl, baseValue);
  }
  localStorage.setItem(LS_KEYS.currentSessionId, currentSessionId || "");
}

function loadInputsFromStorage() {
  const stored = (AUTH?.getSession && AUTH.getSession()) || {
    apiKey: localStorage.getItem(LS_KEYS.apiKey) || "",
    baseUrl: localStorage.getItem(LS_KEYS.baseUrl) || "",
  };
  const savedApiKey =
    stored.apiKey || localStorage.getItem(LS_KEYS.apiKey) || "";
  const savedBase =
    stored.baseUrl ||
    localStorage.getItem(LS_KEYS.baseUrl) ||
    window.location.origin;
  if (el("apiKey") && !el("apiKey").value) el("apiKey").value = savedApiKey;
  if (el("baseUrl") && !el("baseUrl").value) el("baseUrl").value = savedBase;
}

window.addEventListener("online", () => toast("Back online", "ok"));
window.addEventListener("offline", () => toast("You are offline", "warn"));

document.addEventListener("DOMContentLoaded", async () => {
  setConnectedUI(false);
  setQRPanelActive(false);
  loadInputsFromStorage();
  ensureCountryOptions();
  restoreLoginView();
  if (el("baseUrl") && !el("baseUrl").value)
    el("baseUrl").value = window.location.origin;
  gateButtons(true);
  const hasKey = !!(el("apiKey")?.value && el("baseUrl")?.value);
  if (hasKey) {
    setAppVisible(true);
    connectSocket({ silent: true });
    startAutoReconnectMonitor();
    if (currentSessionId) {
      const tryFetch = async () => {
        try {
          const resp = await api(
            `/api/v1/session/create?sessionId=${encodeURIComponent(
              currentSessionId
            )}`
          );
          const detail = extractResult(resp) || {};
          setSessionInfo(detail);
          const openNow = await ensureOpenStateFromServer(currentSessionId);
          const allowQr = shouldAllowQrRequest(currentSessionId);
          const isOpen =
            openNow ||
            detail.status === "open" ||
            isSessionOpen(currentSessionId);
          if (isOpen || !allowQr) {
            setQRVisible(false);
            setQRLoading(false);
            setPairCode("");
            hidePairCode();
          } else {
            setQRVisible(true);
            if (detail.qr && !isPairingFlowActive()) {
              renderQRImage(
                detail.qr,
                currentSessionId,
                Number(detail.qrDuration || qrDefaultDuration)
              );
            } else if (!detail.qr && !isPairingFlowActive()) {
              setQRLoading(true, "Scanning...");
            }
            if (pairModeActive()) setPairCode(detail.pairCode || "");
            else setPairCode("");
          }
        } catch {}
      };
      await tryFetch();
      setTimeout(tryFetch, 800);
    }
  } else {
    setAppVisible(false);
    navigateToLogin();
  }
  document.querySelector("[data-autofocus]")?.focus();
});

el("btnLoad")?.addEventListener("click", () => {
  if (ioClient?.connected) {
    forceLogout("Signed out from WARest");
    return;
  }
  connectSocket({ silent: false });
});

function switchToQR() {
  setLoginMode(LOGIN_MODE_QR);
  setQrAreaMode(LOGIN_MODE_QR);
  const altLink = document.getElementById("qrLinkAlt");
  if (altLink) altLink.classList.remove("hidden");
  const backBtn = document.getElementById("btnBackToQR");
  if (backBtn) backBtn.classList.add("hidden");
  hidePairCode({ preserveCode: true });
  stopPairCodeRefresh();
  setPairRefreshVisible(false);
  setPairRefreshBusy(false);
  const qrBox = document.querySelector("#qrArea .qr");
  if (qrBox) qrBox.classList.remove("hidden");
  try {
    if (currentSessionId && isSessionOpen(currentSessionId)) {
      setQRVisible(false);
      return;
    }
  } catch {}
  setQRVisible(true);
}

function showPhoneLogin() {
  if (!currentSessionId) {
    toast("Select/activate a session first", "warn");
    return;
  }
  setLoginMode(LOGIN_MODE_PHONE);
  ensureCountryOptions();
  setQrAreaMode(LOGIN_MODE_PHONE);
  const altLink = document.getElementById("qrLinkAlt");
  if (altLink) altLink.classList.add("hidden");
  const backBtn = document.getElementById("btnBackToQR");
  if (backBtn) backBtn.classList.remove("hidden");
  setPairErrorText("");
  setPairRefreshVisible(false);
  setPairRefreshBusy(false);
  const existingDigits = getCurrentPairPhone();
  const hasPhone = !!digitsOnly(existingDigits);
  setPairStatusText(
    hasPhone
      ? "Click Next to request a pairing code."
      : "Enter the WhatsApp number (e.g. 628...) then click Next."
  );
  const qrBox = document.querySelector("#qrArea .qr");
  if (qrBox) qrBox.classList.add("hidden");
  stopPairCodeRefresh();
  try {
    getPairPhoneInput()?.focus({ preventScroll: true });
  } catch {}
  if (hasPhone) updatePairLinkedNumber(existingDigits);
  if (hasPhone && pairCodes.has(currentSessionId)) {
    const ts = pairCodeTs.get(currentSessionId) || Date.now();
    setPairCode(pairCodes.get(currentSessionId), {
      forceRender: true,
      timestamp: ts,
    });
  } else if (hasPhone) {
    setPairRefreshVisible(true, "Refresh to show code");
  }
}

function switchToPair() {
  setLoginMode(LOGIN_MODE_PAIR);
  setQrAreaMode(LOGIN_MODE_PAIR);
  ensureCountryOptions();
  updatePairLinkedNumber();
  const altLink = document.getElementById("qrLinkAlt");
  if (altLink) altLink.classList.add("hidden");
  const backBtn = document.getElementById("btnBackToQR");
  if (backBtn) backBtn.classList.remove("hidden");
  setPairErrorText("");
  const hasPhone = !!getCurrentPairPhone();
  if (hasPhone && pairCodes.has(currentSessionId))
    setPairStatusText(
      "Use the code shown or click Get Pair Code to refresh it."
    );
  else if (hasPhone)
    setPairStatusText("Click Get Pair Code to request a pairing code.");
  else
    setPairStatusText(
      "Enter the WhatsApp number (e.g. 628...) then click Get Pair Code."
    );
  const qrBox = document.querySelector("#qrArea .qr");
  if (qrBox) qrBox.classList.add("hidden");
  if (pairCodes.has(currentSessionId)) {
    const ts = pairCodeTs.get(currentSessionId) || Date.now();
    setPairCode(pairCodes.get(currentSessionId), {
      timestamp: ts,
    });
  } else {
    setPairCode("");
  }
  try {
    if (currentSessionId && isSessionOpen(currentSessionId)) {
      setQRVisible(false);
      return;
    }
  } catch {}
  setQRVisible(true);
  try {
    if (ioClient?.connected && currentSessionId) {
      ioClient.emit("join", { room: currentSessionId });
    }
  } catch {}
  maybeStartPairCodeRefresh();
}

function restoreLoginView() {
  const mode = getLoginMode();
  if (!currentSessionId) {
    if (mode !== LOGIN_MODE_QR) setLoginMode(LOGIN_MODE_QR);
    switchToQR();
    return;
  }
  if (mode === LOGIN_MODE_PAIR) {
    switchToPair();
  } else if (mode === LOGIN_MODE_PHONE) {
    showPhoneLogin();
  } else {
    switchToQR();
  }
}

async function refreshQrForCurrentSession() {
  try {
    resetQrWaitTimer();
    switchToQR();
    if (!currentSessionId) return;
    const resp = await api(
      `/api/v1/session/create?sessionId=${encodeURIComponent(currentSessionId)}`
    );
    const detail = extractResult(resp) || {};
    setSessionInfo(detail);
    const openNow = await ensureOpenStateFromServer(currentSessionId);
    const allowQr = shouldAllowQrRequest(currentSessionId);
    const isOpen =
      openNow || detail.status === "open" || isSessionOpen(currentSessionId);
    if (isOpen || !allowQr) {
      setQRVisible(false);
      setQRLoading(false);
      setPairCode("");
      hidePairCode();
    } else {
      setQRVisible(true);
      if (detail.qr && !isPairingFlowActive()) {
        renderQRImage(
          detail.qr,
          currentSessionId,
          Number(detail.qrDuration || qrDefaultDuration)
        );
      } else if (!detail.qr && !isPairingFlowActive()) {
        setQRLoading(true, "Scanning...");
      }
      setPairCode("");
    }
  } catch (e) {
    toast(e.message || "Error", "err");
  }
}

document
  .getElementById("btnShowPair")
  ?.addEventListener("click", () => showPhoneLogin());
document
  .getElementById("btnBackToQR")
  ?.addEventListener("click", () => refreshQrForCurrentSession());

document
  .getElementById("btnPairRefresh")
  ?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      requireSession();
      const combined = getCombinedPhoneFromInputs();
      if (!combined) {
        showPhoneLogin();
        return;
      }
      setPairRefreshBusy(true);
      await requestPairCodeForCurrent({ reason: "manual-refresh" });
    } catch (err) {
      toast(err?.message || "Unable to refresh pair code", "err");
    } finally {
      setPairRefreshBusy(false);
    }
  });

document.getElementById("pairPhone")?.addEventListener("input", () => {
  try {
    const digits = getCombinedPhoneFromInputs();
    if (currentSessionId) {
      rememberPairPhone(currentSessionId, digits);
      pairCodes.delete(currentSessionId);
      pairCodeTs.delete(currentSessionId);
    }
    updatePairLinkedNumber(digits);
    setPairCode("");
    stopPairCodeRefresh();
  } catch {}
});

function showEdit(flag) {
  const ov = el("editOverlay");
  if (!ov) return;
  ov.classList.toggle("show", !!flag);
  document.body.classList.toggle("modal-open", !!flag);
  const err = el("editError");
  if (err) {
    err.textContent = "";
    err.style.display = "none";
  }
  if (flag) {
    try {
      setTimeout(() => {
        const first = el("editWebhookUrl") || el("editSessionId");
        first?.focus({ preventScroll: true });
      }, 0);
    } catch {}
  }
}

el("btnEditCancel")?.addEventListener("click", (e) => {
  e.preventDefault();
  showEdit(false);
  editSessionId = null;
});

el("btnEditSave")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = e.target;
  try {
    if (!editSessionId) throw new Error("No session selected");
    setBtnBusy(btn, true, "Save", "Saving...");
    const webhookUrl = el("editWebhookUrl")?.value?.trim();
    const webhookSecret = el("editWebhookSecret")?.value;
    if (webhookUrl && webhookSecret) {
      const r = await api("/api/webhooks/preflight", "POST", {
        sessionId: editSessionId,
        url: webhookUrl,
        secret: webhookSecret,
      });
      const arr = extractResultsArray(r);
      const ok = arr.length && arr.every((x) => x.ok);
      const area = el("editPreflightResult");
      if (area) {
        area.textContent = arr
          .map(
            (x) =>
              `${x.target || webhookUrl}: ${x.ok ? "OK" : "FAIL"}${
                x.status ? ` (HTTP ${x.status})` : ""
              }${
                typeof x.roundTripMs === "number" ? `  ${x.roundTripMs}ms` : ""
              }`
          )
          .join("\n");
      }
      if (!ok) throw new Error("Webhook verification failed");
    }
    const payload = {
      webhookUrl: webhookUrl || "",
      webhookSecret: webhookSecret || "",
      preflightVerify: !!webhookUrl,
    };
    const updated = await api(
      `/api/v1/session/${encodeURIComponent(editSessionId)}/config`,
      "POST",
      payload
    );
    toast("Session updated");
    showEdit(false);
    const up = extractResult(updated) || {};
    if (up?.sessionId && currentSessionId === up.sessionId) {
      try {
        const resp = await api(
          `/api/v1/session/create?sessionId=${encodeURIComponent(up.sessionId)}`
        );
        const detail = extractResult(resp) || {};
        setSessionInfo(detail);
      } catch {}
    }
    el("btnRefresh")?.click();
    const _si = el("sessId");
    if (_si) _si.value = "";
  } catch (err) {
    const msg = err?.message || "Update failed";
    const area = el("editError");
    if (area) {
      area.textContent = msg;
      area.style.display = "block";
    }
    toast(msg, "err");
  } finally {
    setBtnBusy(btn, false, "Save", "Saving...");
  }
});

function now() {
  return Date.now();
}

async function apiDeleteSession(id) {
  return api(
    `/api/v1/session/delete?sessionId=${encodeURIComponent(id)}`,
    "DELETE"
  );
}

async function apiLogoutSession(id) {
  return api(
    `/api/v1/session/logout?sessionId=${encodeURIComponent(id)}`,
    "GET"
  );
}

function afterDeleteCleanup(idJustDeleted) {
  if (currentSessionId === idJustDeleted) {
    currentSessionId = "";
    persistInputs();
    setQRVisible(false);
    setQRLoading(false);
    const sel = el("sessionSelect");
    if (sel) sel.value = "";
    const info = el("sessionInfo");
    if (info) {
      info.innerHTML = "";
      info.classList.add("hidden");
    }
    setMessagingAvailability(false);
  }
  sessionStatus.delete(idJustDeleted);
}

function attachSessionCardsHandlers(wrap) {
  wrap.querySelectorAll(".btn-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        const id = btn.dataset.id;
        const ok = window.confirm(
          `Delete session "${id}"?\n\nThis will remove runtime, credentials, and registry metadata.`
        );
        if (!ok) return;
        setBtnBusy(btn, true, "Delete", "Deleting...");
        await apiDeleteSession(id);
        afterDeleteCleanup(id);
        el("btnRefresh")?.click();
        toast(`Session deleted`);
      } catch (e) {
        toast(e.message || "Error", "err");
      } finally {
        setBtnBusy(btn, false, "Delete", "Deleting...");
      }
    })
  );
  wrap.querySelectorAll(".btn-set-active").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      try {
        setBtnBusy(btn, true, btn.textContent || "Set Active", "Setting...");
        currentSessionId = btn.dataset.id;
        resetQrWaitTimer();
        setMessagingAvailability(false);
        restorePairPhoneInputs(currentSessionId);
        persistInputs();
        updateSessionInPairCode();
        const resp = await api(
          `/api/v1/session/create?sessionId=${encodeURIComponent(
            currentSessionId
          )}`
        );
        const detail = extractResult(resp) || {};
        setSessionInfo(detail);
        if (ioClient?.connected)
          ioClient.emit("join", { room: currentSessionId });
        const openNow = await ensureOpenStateFromServer(currentSessionId);
        const allowQr = shouldAllowQrRequest(currentSessionId);
        const isOpen =
          openNow ||
          detail.status === "open" ||
          isSessionOpen(currentSessionId);
        if (isOpen || !allowQr) {
          setQRVisible(false);
          setQRLoading(false);
          setPairCode("");
          hidePairCode();
        } else {
          const modeNow = getLoginMode();
          const missingPairData =
            !pairCodes.has(currentSessionId) && !getCurrentPairPhone();
          if (
            isPhoneEntryMode() ||
            (modeNow === LOGIN_MODE_PAIR && missingPairData)
          ) {
            showPhoneLogin();
          }
          setQRVisible(true);
          if (detail.qr && !isPairingFlowActive())
            renderQRImage(
              detail.qr,
              currentSessionId,
              Number(detail.qrDuration || qrDefaultDuration)
            );
          else if (!detail.qr && !isPairingFlowActive())
            setQRLoading(true, "Scanning...");
          if (modeNow === LOGIN_MODE_PAIR && !missingPairData)
            setPairCode(detail.pairCode || "");
          else setPairCode("");
        }
        updateActiveUI();
      } catch (e) {
        toast(e.message || "Error", "err");
        setBtnBusy(btn, false, "Set Active", "Setting...");
      } finally {
      }
    })
  );
  wrap.querySelectorAll(".btn-edit").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        setBtnBusy(btn, true, "Edit", "Loading...");
        const id = btn.dataset.id;
        const resp = await api(
          `/api/v1/session/create?sessionId=${encodeURIComponent(id)}`
        );
        const detail = extractResult(resp) || {};
        setSessionStatus(id, detail?.status || "unknown");
        editSessionId = id;
        const idInp = el("editSessionId");
        const whUrlInp = el("editWebhookUrl");
        const whSecInp = el("editWebhookSecret");
        if (idInp) idInp.value = id;
        if (whUrlInp) whUrlInp.value = detail.webhookUrl || "";
        if (whSecInp) whSecInp.value = detail.webhookSecret || "";
        try {
          const urlNow = (whUrlInp?.value || "").trim();
          const secNow = (whSecInp?.value || "").trim();
          if (!urlNow && (!secNow || secNow.length < 6)) {
            const fresh = genWebhookSecret(12);
            if (whSecInp) whSecInp.value = fresh;
          }
        } catch {}
        showEdit(true);
      } catch (e) {
        toast(e.message || "Failed to load session", "err");
      } finally {
        setBtnBusy(btn, false, "Edit", "Loading...");
      }
    })
  );
}

el("btnCreate")?.addEventListener("click", async (ev) => {
  const btn = ev.target;
  try {
    setBtnBusy(btn, true, "Create / Start", "Starting...");
    const idVal = el("sessId")?.value || "";
    if (!idVal) return toast("Enter session ID", "warn");
    const resp = await api(
      `/api/v1/session/create?sessionId=${encodeURIComponent(idVal)}`
    );
    const data = extractResult(resp) || {};
    const newId = data.sessionId || data.id || idVal;
    toast("Started session " + newId);
    currentSessionId = newId;
    resetQrWaitTimer();
    setMessagingAvailability(false);
    setSessionStatus(currentSessionId, data.status || "unknown");
    persistInputs();
    updateSessionInPairCode();
    if (ioClient?.connected) ioClient.emit("join", { room: currentSessionId });
    if (data) {
      setSessionInfo(data);
      const openNow = await ensureOpenStateFromServer(currentSessionId);
      const allowQr = shouldAllowQrRequest(currentSessionId);
      const isOpen =
        openNow || data.status === "open" || isSessionOpen(currentSessionId);
      if (isOpen || !allowQr) {
        setQRVisible(false);
        setQRLoading(false);
        setPairCode("");
        hidePairCode();
      } else {
        setQRVisible(true);
        if (data.qr)
          renderQRImage(
            data.qr,
            currentSessionId,
            Number(data.qrDuration || qrDefaultDuration)
          );
        else setQRLoading(true, "Scanning...");
        setPairCode(data.pairCode || "");
      }
    }
    el("btnRefresh")?.click();
  } catch (e) {
    toast(e.message || "Error", "err");
  } finally {
    setBtnBusy(btn, false, "Create / Start", "Starting...");
  }
});

el("btnPairCode")?.addEventListener("click", async (e) => {
  const btn = e.target;
  try {
    requireSession();
    const combined = getCombinedPhoneFromInputs();
    if (!combined) {
      showPhoneLogin();
      return toast("Enter phone number for pairing", "warn");
    }
    setBtnBusy(btn, true, "Next", "Requesting...");
    const detail = await requestPairCodeForCurrent({ reason: "manual" });
    if (detail && detail.status === "open") {
      toast("Session already open", "ok");
      switchToQR();
      return;
    }
    switchToPair();
    toast("Pair code requested", "ok");
  } catch (err) {
    if (err?.message && String(err.message).includes("Session already open")) {
      toast(err.message, "ok");
      switchToQR();
    }
  } finally {
    setBtnBusy(btn, false, "Next", "Requesting...");
  }
});

document
  .getElementById("linkPhoneToQr")
  ?.addEventListener("click", () => switchToQR());

document
  .getElementById("btnEditPhone")
  ?.addEventListener("click", () => showPhoneLogin());

getCountryCodeSelect()?.addEventListener("change", () => {
  try {
    const digits = getCombinedPhoneFromInputs();
    if (currentSessionId) {
      rememberPairPhone(currentSessionId, digits);
      pairCodes.delete(currentSessionId);
      pairCodeTs.delete(currentSessionId);
    }
    updatePairLinkedNumber(digits);
    setPairCode("");
    stopPairCodeRefresh();
  } catch {}
});

el("btnRefresh")?.addEventListener("click", async (ev) => {
  const btn = ev.target;
  try {
    setBtnBusy(btn, true, "Refresh", "Refreshing...");
    setSessionsLoading(true);
    let items = [];
    try {
      const resp = await api(`/api/v1/session/list`);
      const resultList = extractResult(resp);
      items = resultList?.items || [];
    } catch {}
    fillSessionSelect(items);
    const wrap = el("sessions");
    if (!wrap) return;
    if (items.length === 0) {
      wrap.innerHTML =
        '<div class="muted" style="text-align:center; padding: 20px;">No sessions. Create one above to get started.</div>';
      updateActiveUI();
      return;
    }
    wrap.innerHTML = "";
    items.forEach((s) => {
      const isActive = s.id === currentSessionId;
      const statusLabel = displayStatusFor(s.id, s.status);
      const statusClass = statusClassFor(statusLabel);
      const div = document.createElement("div");
      div.className = "session-tile" + (isActive ? " is-active" : "");
      div.setAttribute("data-id", s.id);
      div.innerHTML = `
        <div class="session-title">
          <span>${escapeHTML(s.id)}</span>
          <span class="session-status-pill ${statusClass}">${escapeHTML(
        statusLabel
      )}</span>
        </div>
        <div class="muted">
          ${isSessionOpen(s.id) ? "Logged in" : "Not logged in"}
        </div>
        <div class="session-actions">
          <button data-id="${escapeHTML(s.id)}" class="btn-edit">Edit</button>
          <button data-id="${escapeHTML(s.id)}" class="btn-set-active ${
        isActive ? "btn-accent" : "btn-primary"
      }" ${isActive ? "disabled" : ""}>${
        isActive ? "Active" : "Set Active"
      }</button>
          <button data-id="${escapeHTML(
            s.id
          )}" class="btn-del btn-danger">Delete</button>
        </div>`;
      wrap.appendChild(div);
    });
    try {
      if (ioClient?.connected && currentSessionId) {
        ioClient.emit("join", { room: currentSessionId });
      }
    } catch {}
    attachSessionCardsHandlers(wrap);
    updateActiveUI();
    try {
      const curr = items.find((x) => x.id === currentSessionId);
      if (!currentSessionId || !curr) {
        setQRVisible(false);
        setQRLoading(false);
        setPairCode("");
        hidePairCode();
      } else {
        const status = String(curr.status || "").toLowerCase();
        const allowQr = shouldAllowQrRequest(currentSessionId);
        if (status === "open" || isSessionOpen(currentSessionId) || !allowQr) {
          setQRVisible(false);
          setQRLoading(false);
          setPairCode("");
          hidePairCode();
        } else {
          try {
            const resp = await api(
              `/api/v1/session/create?sessionId=${encodeURIComponent(
                currentSessionId
              )}`
            );
            const detail = extractResult(resp) || {};
            setSessionInfo(detail);
            setQRVisible(true);
            if (detail?.qr && !isPairingFlowActive()) {
              renderQRImage(
                detail.qr,
                currentSessionId,
                Number(detail.qrDuration || qrDefaultDuration)
              );
            } else if (!detail?.qr && !isPairingFlowActive()) {
              setQRLoading(true, "Waiting for QR...");
            }
            if (pairModeActive()) {
              setPairCode(detail?.pairCode || "");
            } else {
              setPairCode("");
            }
          } catch {
            setQRVisible(true);
            setQRLoading(true, "Waiting for QR...");
          }
        }
      }
    } catch {}
  } catch (e) {
    toast(e.message || "Error", "err");
  } finally {
    setSessionsLoading(false);
    setBtnBusy(btn, false, "Refresh", "Refreshing...");
  }
});

el("btnActiveLogout")?.addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  const id = currentSessionId;
  if (!id) return toast("Select a session", "warn");
  try {
    setBtnBusy(btn, true, "Logout", "Logging out...");
    await apiLogoutSession(id);
    toast("Session logout requested");
    el("btnRefresh")?.click();
  } catch (e) {
    toast(e.message || "Error", "err");
  } finally {
    setBtnBusy(btn, false, "Logout", "Logging out...");
  }
});

el("btnDeleteSess")?.addEventListener("click", async () => {
  const sel = el("sessionSelect");
  const id = sel?.value;
  if (!id) return toast("Select a session", "warn");
  try {
    const ok = window.confirm(
      `Delete session "${id}"?\n\nThis will remove runtime, credentials, and registry metadata.`
    );
    if (!ok) return;
    const btn = el("btnDeleteSess");
    if (btn) setBtnBusy(btn, true, "Delete Current", "Deleting...");
    await apiDeleteSession(id);
    afterDeleteCleanup(id);
    el("btnRefresh")?.click();
    updateActiveUI();
    toast(`Session deleted`, "warn");
  } catch (e) {
    toast(e.message || "Error", "err");
  } finally {
    const btn = el("btnDeleteSess");
    if (btn) setBtnBusy(btn, false, "Delete Current", "Deleting...");
  }
});

el("sessionSelect")?.addEventListener("change", async () => {
  const id = el("sessionSelect")?.value;
  if (!id) {
    const info = el("sessionInfo");
    if (info) {
      info.innerHTML = "";
      info.classList.add("hidden");
    }
    return;
  }
  try {
    currentSessionId = id;
    resetQrWaitTimer();
    setMessagingAvailability(false);
    restorePairPhoneInputs(currentSessionId);
    updateSessionInPairCode();
    const resp = await api(
      `/api/v1/session/create?sessionId=${encodeURIComponent(id)}`
    );
    const detail = extractResult(resp) || {};
    setSessionInfo(detail);
    const openNow = await ensureOpenStateFromServer(id);
    const allowQr = shouldAllowQrRequest(id);
    const isOpen = openNow || detail.status === "open" || isSessionOpen(id);
    if (isOpen || !allowQr) {
      setQRVisible(false);
      setQRLoading(false);
      setPairCode("");
      hidePairCode();
    } else {
      const modeNow = getLoginMode();
      const missingPairData = !pairCodes.has(id) && !getCurrentPairPhone();
      if (
        isPhoneEntryMode() ||
        (modeNow === LOGIN_MODE_PAIR && missingPairData)
      ) {
        showPhoneLogin();
      }
      setQRVisible(true);
      if (detail.qr && !isPairingFlowActive())
        renderQRImage(
          detail.qr,
          id,
          Number(detail.qrDuration || qrDefaultDuration)
        );
      else if (!detail.qr && !isPairingFlowActive())
        setQRLoading(true, "Scanning...");
      if (pairModeActive() && !missingPairData)
        setPairCode(detail.pairCode || "");
      else setPairCode("");
    }
    if (ioClient?.connected) ioClient.emit("join", { room: id });
    updateActiveUI();
  } catch (e) {
    toast(e.message || "Error", "err");
  }
});

function requireSession(opts = {}) {
  const { mustBeOpen = false } = opts || {};
  if (!currentSessionId) {
    toast("Select/activate a session first", "warn");
    throw new Error("no session");
  }
  if (mustBeOpen && !isSessionOpen(currentSessionId)) {
    toast("Session is not logged in. Connect the device first.", "warn");
    throw new Error("session not open");
  }
}

window.addEventListener("storage", (ev) => {
  if (ev.key === LS_KEYS.currentSessionId) {
    try {
      const oldPairArea = document.getElementById("pairCodeArea");
      if (oldPairArea) oldPairArea.style.display = "none";
    } catch {}
    currentSessionId = localStorage.getItem(LS_KEYS.currentSessionId) || "";
    resetQrWaitTimer();
    restorePairPhoneInputs(currentSessionId);
    setMessagingAvailability(false);
    connectSocket({ silent: true });
    restoreLoginView();
    return;
  }
  if (ev.key === LS_KEYS.loginMode) {
    const stored = localStorage.getItem(LS_KEYS.loginMode);
    if (VALID_LOGIN_MODES.includes(stored)) {
      loginMethod = stored;
      window.loginMethod = stored;
      restoreLoginView();
    }
    return;
  }
  if (!AUTH && (ev.key === LS_KEYS.apiKey || ev.key === LS_KEYS.baseUrl)) {
    loadInputsFromStorage();
    currentSessionId = localStorage.getItem(LS_KEYS.currentSessionId) || "";
    setMessagingAvailability(false);
    connectSocket({ silent: true });
  }
});

(function () {
  const _origRenderQR =
    typeof window.renderQRImage === "function"
      ? window.renderQRImage
      : typeof renderQRImage === "function"
      ? renderQRImage
      : null;
  if (_origRenderQR) {
    window.renderQRImage = function (qr, sessionId) {
      if (pairModeActive()) {
        setQrAreaMode(LOGIN_MODE_PAIR);
        setQRLoading(false);
        return;
      }
      return _origRenderQR(qr, sessionId);
    };
  }
  const _origSetPair =
    typeof window.setPairCode === "function"
      ? window.setPairCode
      : typeof setPairCode === "function"
      ? setPairCode
      : null;
  if (_origSetPair) {
    window.setPairCode = function (code) {
      const out = _origSetPair(code);
      updateSessionInPairCode();
      return out;
    };
  }
})();

let _msgModalType = null;
let _msgModalSendHandler = null;

function extractResultsArray(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.results))
    return payload.results.filter((v) => v !== undefined);
  const single = payload.result;
  if (single == null) return [];
  return Array.isArray(single) ? single : [single];
}

function extractResult(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const arr = extractResultsArray(payload);
  if (arr.length === 0) return payload.result ?? payload;
  if (arr.length === 1) return arr[0];
  return arr;
}

function msgModalEl() {
  return {
    overlay: document.getElementById("msgModalOverlay"),
    title: document.getElementById("msgModalTitle"),
    body: document.getElementById("msgModalBody"),
    send: document.getElementById("msgModalSend"),
    cancel: document.getElementById("msgModalCancel"),
    close: document.getElementById("msgModalClose"),
  };
}

function attachMsgCommonOptions(root) {
  try {
    if (!root) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="form-row mt-8" id="msg_opts_row">
        <div class="toggle-field"><span>Presence</span>
          <div class="checkbox-wrapper-8">
            <input class="tgl tgl-skewed" id="msg_presence" type="checkbox" />
            <label class="tgl-btn" data-tg-off="OFF" data-tg-on="ON" for="msg_presence"></label>
          </div>
        </div>
        <div class="toggle-field"><span>Forwarded</span>
          <div class="checkbox-wrapper-8">
            <input class="tgl tgl-skewed" id="msg_forwarded" type="checkbox" />
            <label class="tgl-btn" data-tg-off="OFF" data-tg-on="ON" for="msg_forwarded"></label>
          </div>
        </div>
        <button type="button" id="msg_reply_toggle" class="btn btn-secondary btn-sm">Reply message</button>
      </div>
      <div class="row mt-4" id="msg_presence_hint_row" style="display:none">
        <span class="inline-note">Presence ON briefly marks you online/available and shows typing or recording cues before sending.</span>
      </div>
      <div class="form-row mt-8" id="msg_reply_row" style="display:none">
        <input id="msg_reply_id" placeholder="reply message ID" />
      </div>
    `;
    Array.from(wrap.childNodes).forEach((n) => root.appendChild(n));
    const tgl = document.getElementById("msg_reply_toggle");
    const row = document.getElementById("msg_reply_row");
    tgl?.addEventListener("click", () => {
      const isHidden = row?.style.display === "none";
      const show = isHidden;
      if (row) row.style.display = show ? "" : "none";
      if (tgl) tgl.textContent = show ? "Hide reply" : "Reply message";
      if (show) {
        setTimeout(() => document.getElementById("msg_reply_id")?.focus(), 0);
      } else {
        const ri = document.getElementById("msg_reply_id");
        if (ri) ri.value = "";
      }
    });
    const presenceTgl = document.getElementById("msg_presence");
    const presenceHintRow = document.getElementById("msg_presence_hint_row");
    const updatePresenceHint = () => {
      if (!presenceHintRow) return;
      presenceHintRow.style.display = presenceTgl?.checked ? "" : "none";
    };
    updatePresenceHint();
    presenceTgl?.addEventListener("change", updatePresenceHint);
  } catch {}
}

function readMsgCommonOptions(presenceState = "composing") {
  const presenceEnabled = !!document.getElementById("msg_presence")?.checked;
  const isForwarded = !!document.getElementById("msg_forwarded")?.checked;
  let replyMessageId = (
    document.getElementById("msg_reply_id")?.value || ""
  ).trim();
  if (/^(undefined|null)$/i.test(replyMessageId)) replyMessageId = "";
  const state = String(presenceState || "composing").trim() || "composing";
  const presence = presenceEnabled ? state : undefined;
  return { presence, isForwarded, replyMessageId };
}

function openMsgModal(type, builder) {
  try {
    requireSession({ mustBeOpen: true });
  } catch {
    return;
  }
  const { overlay, title, body, send } = msgModalEl();
  _msgModalType = type;
  if (body) body.innerHTML = "";
  if (title)
    title.textContent =
      type === "text"
        ? "Send Text"
        : type === "media"
        ? "Send Media"
        : type === "media-multi"
        ? "Send Multi Media"
        : type === "audio"
        ? "Send Audio"
        : type === "document"
        ? "Send Document"
        : type === "button"
        ? "Send Button"
        : type === "list"
        ? "Send List"
        : type === "sticker"
        ? "Send Sticker"
        : type === "location"
        ? "Send Location"
        : type === "poll"
        ? "Send Poll"
        : type === "contact"
        ? "Send Contact"
        : type === "gif"
        ? "Send GIF"
        : "Compose";
  try {
    builder?.(body);
  } catch (e) {
    if (body)
      body.innerHTML =
        '<div class="error-text">Failed to render form. Please reload.</div>';
  }
  attachMsgCommonOptions(body);
  try {
    if (body) body.scrollTop = 0;
  } catch {}
  try {
    document.body.classList.add("modal-open");
  } catch {}
  try {
    if (!currentSessionId && send) {
      send.disabled = true;
      const warn = document.createElement("div");
      warn.className = "row mt-6";
      warn.innerHTML =
        '<span class="inline-note">Select/activate a session first to enable sending.</span>';
      if (body?.firstChild) body.insertBefore(warn, body.firstChild);
      else body?.appendChild(warn);
    }
  } catch {}
  overlay?.classList.add("show");
  overlay?.setAttribute("aria-hidden", "false");
  if (send) send.disabled = currentSessionId ? false : true;
  try {
    body
      ?.querySelector("input,textarea,select")
      ?.focus({ preventScroll: true });
  } catch {}
}

function closeMsgModal() {
  const { overlay, body, send } = msgModalEl();
  overlay?.classList.remove("show");
  overlay?.setAttribute("aria-hidden", "true");
  _msgModalType = null;
  _msgModalSendHandler = null;
  if (send) send.disabled = false;
  if (body) body.innerHTML = "";
  try {
    const stillOpen =
      document.getElementById("editOverlay")?.classList.contains("show") ||
      document.getElementById("phoneOverlay")?.classList.contains("show");
    if (!stillOpen) document.body.classList.remove("modal-open");
  } catch {}
}

async function apiUpload(path, formData) {
  requireSession();
  const apiKey = el("apiKey")?.value.trim();
  const base = (el("baseUrl")?.value.trim() || window.location.origin).replace(
    /\/$/,
    ""
  );
  const abort = new AbortController();
  const to = setTimeout(() => abort.abort(), 60000);
  try {
    const r = await fetch(base + path, {
      method: "POST",
      headers: {
        "X-WAREST-API-KEY": apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: abort.signal,
    });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        const j = await r.json();
        msg = j?.error || j?.message || msg;
      } catch {}
      const e = new Error(msg || "Upload failed");
      e.status = r.status;
      throw e;
    }
    const ct = r.headers.get("content-type") || "";
    return ct.includes("application/json") ? r.json() : { ok: true };
  } finally {
    clearTimeout(to);
  }
}

function buildTextForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="msg_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <textarea id="msg_text" placeholder="message text..." class="flex-1"></textarea>
    </div>
    <div class="row mt-8">
      <label class="inline-note">Supports markdown.</label>
    </div>
  `;
  _msgModalSendHandler = async () => {
    const to = el("msg_to")?.value.trim();
    const message = el("msg_text")?.value || "";
    if (!to || !message) throw new Error("Enter destination and message");
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/text", "POST", {
      sessionId: currentSessionId,
      to,
      message,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildMediaMultiForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row mt-6">
      <input id="media_to" placeholder="to (62xxxx or JID)" />
    </div>
   
    <div id="mm_list" class="mt-8"></div>
    <div class="row mt-6">
      <button id="mm_add" type="button" class="btn btn-secondary">+ Add More</button>
    </div>
  `;
  const list = el("mm_list");
  const btnAdd = el("mm_add");
  const addItem = () => {
    const d = document.createElement("div");
    d.className = "mm-item card mt-8";
    d.innerHTML = `
      <div class="subcard-head">
        <div class="subcard-title">Media Item</div>
      </div>
      <div class="form-row">
        <div class="segctrl" role="tablist" aria-label="Input mode">
          <button type="button" class="mm-mode-upload active" role="tab" aria-selected="true">Upload</button>
          <button type="button" class="mm-mode-url" role="tab" aria-selected="false">URL</button>
        </div>
        <button type="button" class="btn btn-secondary mm-remove" style="margin-left:auto;">Remove</button>
      </div>
      <div class="form-row mt-8">
        <span class="hint" style="min-width:88px;display:inline-block;">Caption</span>
        <textarea class="mm-caption flex-1" rows="3" placeholder="caption (optional)"></textarea>
      </div>
      <div class="form-row mt-8">
        <span class="hint" style="min-width:88px;display:inline-block;">Filename</span>
        <input class="mm-filename flex-1" type="text" placeholder="filename (optional)" />
      </div>
      <div class="form-row mt-8 mm-upload-area">
        <span class="hint" style="min-width:88px;display:inline-block;">Upload</span>
        <input class="mm-file" type="file" accept="*/*" />
      </div>
      <div class="form-row mt-8 mm-url-area" style="display:none">
        <span class="hint" style="min-width:88px;display:inline-block;">URL</span>
        <input class="mm-url" type="url" placeholder="https://..." />
      </div>`;
    list.appendChild(d);
    const bUpload = d.querySelector(".mm-mode-upload");
    const bUrl = d.querySelector(".mm-mode-url");
    const upArea = d.querySelector(".mm-upload-area");
    const urlArea = d.querySelector(".mm-url-area");
    const btnRemove = d.querySelector(".mm-remove");
    bUpload.addEventListener("click", () => {
      bUpload.classList.add("active");
      bUpload.setAttribute("aria-selected", "true");
      bUrl.classList.remove("active");
      bUrl.setAttribute("aria-selected", "false");
      upArea.style.display = "";
      urlArea.style.display = "none";
    });
    bUrl.addEventListener("click", () => {
      bUrl.classList.add("active");
      bUrl.setAttribute("aria-selected", "true");
      bUpload.classList.remove("active");
      bUpload.setAttribute("aria-selected", "false");
      upArea.style.display = "none";
      urlArea.style.display = "";
    });
    btnRemove.addEventListener("click", () => {
      if (list.children.length <= 1) return;
      d.remove();
      Array.from(list.querySelectorAll(".mm-remove")).forEach((b) => {
        b.style.display = list.children.length > 1 ? "" : "none";
      });
    });
    btnRemove.style.display = list.children.length > 1 ? "" : "none";
  };
  addItem();
  btnAdd.addEventListener("click", () => {
    addItem();
    Array.from(list.querySelectorAll(".mm-remove")).forEach((b) => {
      b.style.display = list.children.length > 1 ? "" : "none";
    });
  });
  _msgModalSendHandler = async () => {
    const to = el("media_to")?.value.trim();
    if (!to) throw new Error("Enter destination");
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    const items = Array.from(list.querySelectorAll(".mm-item"));
    if (!items.length) throw new Error("Add at least one file item");
    const files = [];
    for (const item of items) {
      const isUpload = item
        .querySelector(".mm-mode-upload")
        ?.classList.contains("active");
      const caption = item.querySelector(".mm-caption")?.value || "";
      const filename = item.querySelector(".mm-filename")?.value || "";
      if (isUpload) {
        const finp = item.querySelector(".mm-file");
        const f = finp?.files?.[0];
        if (!f) continue;
        const data = await readFileAsDataURL(f);
        files.push({
          file: String(data),
          caption: caption || undefined,
          filename: filename || undefined,
        });
      } else {
        const url = item.querySelector(".mm-url")?.value.trim();
        if (!url) continue;
        files.push({
          file: url,
          caption: caption || undefined,
          filename: filename || undefined,
        });
      }
    }
    if (!files.length)
      throw new Error("Please provide at least one file or URL");
    await api("/api/v1/messages/send/files", "POST", {
      sessionId: currentSessionId,
      to,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
      files,
    });
  };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    } catch (e) {
      reject(e);
    }
  });
}

function buildMediaSingleForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="sm_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <div class="segctrl" role="tablist" aria-label="Input mode">
        <button id="sm_mode_url" class="active" type="button" role="tab" aria-selected="true">URL</button>
        <button id="sm_mode_file" type="button" role="tab" aria-selected="false">Upload</button>
      </div>
    </div>
    <div class="form-row mt-8">
      <textarea id="sm_caption" class="flex-1" rows="3" placeholder="caption (optional)"></textarea>
    </div>
    <div id="sm_url_area" class="form-row mt-8">
      <input id="sm_url" type="url" placeholder="https://... (image/video)" />
    </div>
    <div id="sm_file_area" class="form-row mt-8" style="display:none">
      <input id="sm_file" type="file" accept="image/*,video/*" />
    </div>
    <div class="form-row mt-8">
      <div class="toggle-field"><span>Compress</span>
        <div class="checkbox-wrapper-8">
          <input class="tgl tgl-skewed" id="sm_compress" type="checkbox" checked />
          <label class="tgl-btn" data-tg-off="OFF" data-tg-on="ON" for="sm_compress"></label>
        </div>
      </div>
      <div class="toggle-field"><span>View Once</span>
        <div class="checkbox-wrapper-8">
          <input class="tgl tgl-skewed" id="sm_viewonce" type="checkbox" />
          <label class="tgl-btn" data-tg-off="OFF" data-tg-on="ON" for="sm_viewonce"></label>
        </div>
      </div>
    </div>
    <div class="row mt-6"><span class="inline-note">/send/media only supports image/video.</span></div>
  `;
  const bURL = el("sm_mode_url");
  const bFile = el("sm_mode_file");
  const urlArea = el("sm_url_area");
  const fileArea = el("sm_file_area");
  bURL.addEventListener("click", () => {
    bURL.classList.add("active");
    bFile.classList.remove("active");
    urlArea.style.display = "";
    fileArea.style.display = "none";
  });
  bFile.addEventListener("click", () => {
    bFile.classList.add("active");
    bURL.classList.remove("active");
    urlArea.style.display = "none";
    fileArea.style.display = "";
  });
  _msgModalSendHandler = async () => {
    const to = el("sm_to")?.value.trim();
    const caption = el("sm_caption")?.value || "";
    const compress = !!el("sm_compress")?.checked;
    const viewOnce = !!el("sm_viewonce")?.checked;
    if (!to) throw new Error("Enter destination");
    let media = null;
    if (bURL.classList.contains("active")) {
      media = el("sm_url")?.value.trim();
      if (!media) throw new Error("Enter media URL");
    } else {
      const f = el("sm_file")?.files?.[0];
      if (!f) throw new Error("Pick a file");
      media = await readFileAsDataURL(f);
    }
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    let resp;
    try {
      resp = await api("/api/v1/messages/send/media", "POST", {
        sessionId: currentSessionId,
        to,
        media,
        caption,
        compress,
        viewOnce,
        presence,
        replyMessageId: replyMessageId || undefined,
        isForwarded,
      });
    } catch (err) {
      if (err?.message?.includes("limit")) throw err;
      throw err;
    }
  };
}

function buildAudioForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="au_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <div class="segctrl" role="tablist" aria-label="Input mode">
        <button id="au_mode_url" class="active" type="button" role="tab" aria-selected="true">URL</button>
        <button id="au_mode_file" type="button" role="tab" aria-selected="false">Upload</button>
      </div>
      <div class="toggle-field"><span>Send as voice note (PTT)</span>
        <div class="checkbox-wrapper-8">
          <input class="tgl tgl-skewed" id="au_isvn" type="checkbox" />
          <label class="tgl-btn" data-tg-off="OFF" data-tg-on="ON" for="au_isvn"></label>
        </div>
      </div>
    </div>
    <div id="au_url_area" class="form-row mt-8">
      <input id="au_url" type="url" placeholder="https://... (audio)" />
    </div>
    <div id="au_file_area" class="form-row mt-8" style="display:none">
      <input id="au_file" type="file" accept="audio/*" />
    </div>
  `;
  const bURL = el("au_mode_url");
  const bFile = el("au_mode_file");
  const urlArea = el("au_url_area");
  const fileArea = el("au_file_area");
  bURL.addEventListener("click", () => {
    bURL.classList.add("active");
    bFile.classList.remove("active");
    urlArea.style.display = "";
    fileArea.style.display = "none";
  });
  bFile.addEventListener("click", () => {
    bFile.classList.add("active");
    bURL.classList.remove("active");
    urlArea.style.display = "none";
    fileArea.style.display = "";
  });
  _msgModalSendHandler = async () => {
    const to = el("au_to")?.value.trim();
    if (!to) throw new Error("Enter destination");
    const isVN = !!el("au_isvn")?.checked;
    let audio = null;
    if (bURL.classList.contains("active")) {
      audio = el("au_url")?.value.trim();
      if (!audio) throw new Error("Enter audio URL");
    } else {
      const f = el("au_file")?.files?.[0];
      if (!f) throw new Error("Pick a file");
      audio = await readFileAsDataURL(f);
    }
    const { presence, isForwarded, replyMessageId } =
      readMsgCommonOptions("recording");
    await api("/api/v1/messages/send/audio", "POST", {
      sessionId: currentSessionId,
      to,
      audio,
      isVN,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildDocumentForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="doc_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <div class="segctrl" role="tablist" aria-label="Input mode">
        <button id="doc_mode_url" class="active" type="button" role="tab" aria-selected="true">URL</button>
        <button id="doc_mode_file" type="button" role="tab" aria-selected="false">Upload</button>
      </div>
      <input id="doc_filename" placeholder="filename (optional)" />
    </div>
    <div id="doc_url_area" class="form-row mt-8">
      <input id="doc_url" type="url" placeholder="https://... (any file)" />
    </div>
    <div id="doc_file_area" class="form-row mt-8" style="display:none">
      <input id="doc_file" type="file" />
    </div>
    <div class="form-row mt-8">
      <textarea id="doc_caption" class="flex-1" rows="3" placeholder="caption (optional)"></textarea>
    </div>
  `;
  const bURL = el("doc_mode_url");
  const bFile = el("doc_mode_file");
  const urlArea = el("doc_url_area");
  const fileArea = el("doc_file_area");
  bURL.addEventListener("click", () => {
    bURL.classList.add("active");
    bFile.classList.remove("active");
    urlArea.style.display = "";
    fileArea.style.display = "none";
  });
  bFile.addEventListener("click", () => {
    bFile.classList.add("active");
    bURL.classList.remove("active");
    urlArea.style.display = "none";
    fileArea.style.display = "";
  });
  _msgModalSendHandler = async () => {
    const to = el("doc_to")?.value.trim();
    if (!to) throw new Error("Enter destination");
    const filename = el("doc_filename")?.value || undefined;
    const caption = el("doc_caption")?.value || undefined;
    let documentVal = null;
    if (bURL.classList.contains("active")) {
      documentVal = el("doc_url")?.value.trim();
      if (!documentVal) throw new Error("Enter document URL");
    } else {
      const f = el("doc_file")?.files?.[0];
      if (!f) throw new Error("Pick a file");
      documentVal = await readFileAsDataURL(f);
    }
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/document", "POST", {
      sessionId: currentSessionId,
      to,
      document: documentVal,
      filename,
      caption,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildStickerForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="st_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <div class="segctrl" role="tablist" aria-label="Input mode">
        <button id="st_mode_url" class="active" type="button" role="tab" aria-selected="true">URL</button>
        <button id="st_mode_file" type="button" role="tab" aria-selected="false">Upload</button>
      </div>
    </div>
    <div id="st_url_area" class="form-row mt-8">
      <input id="st_url" type="url" placeholder="https://... (image/webp/gif)" />
    </div>
    <div id="st_file_area" class="form-row mt-8" style="display:none">
      <input id="st_file" type="file" accept="image/*" />
    </div>
    <div class="form-row mt-8">
      <div class="toggle-field"><span>Compress</span>
        <div class="checkbox-wrapper-8">
          <input class="tgl tgl-skewed" id="st_compress" type="checkbox" checked />
          <label class="tgl-btn" data-tg-off="OFF" data-tg-on="ON" for="st_compress"></label>
        </div>
      </div>
    </div>
    <div class="row mt-6"><span class="inline-note">Non-webp images will be auto-converted to 512x512 WebP.</span></div>
  `;
  const bURL = el("st_mode_url");
  const bFile = el("st_mode_file");
  const urlArea = el("st_url_area");
  const fileArea = el("st_file_area");
  bURL.addEventListener("click", () => {
    bURL.classList.add("active");
    bFile.classList.remove("active");
    urlArea.style.display = "";
    fileArea.style.display = "none";
  });
  bFile.addEventListener("click", () => {
    bFile.classList.add("active");
    bURL.classList.remove("active");
    urlArea.style.display = "none";
    fileArea.style.display = "";
  });
  _msgModalSendHandler = async () => {
    const to = el("st_to")?.value.trim();
    if (!to) throw new Error("Enter destination");
    let sticker = null;
    if (bURL.classList.contains("active")) {
      sticker = el("st_url")?.value.trim();
      if (!sticker) throw new Error("Enter sticker URL");
    } else {
      const f = el("st_file")?.files?.[0];
      if (!f) throw new Error("Pick an image file");
      sticker = await readFileAsDataURL(f);
    }
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/sticker", "POST", {
      sessionId: currentSessionId,
      to,
      sticker,
      compress: !!el("st_compress")?.checked,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildGifForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="gif_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <div class="segctrl" role="tablist" aria-label="Input mode">
        <button id="gif_mode_url" class="active" type="button" role="tab" aria-selected="true">URL</button>
        <button id="gif_mode_file" type="button" role="tab" aria-selected="false">Upload</button>
      </div>
    </div>
    <div class="form-row mt-8">
      <textarea id="gif_caption" class="flex-1" rows="3" placeholder="caption (optional)"></textarea>
    </div>
    <div id="gif_url_area" class="form-row mt-8">
      <input id="gif_url" type="url" placeholder="https://... (gif/video)" />
    </div>
    <div id="gif_file_area" class="form-row mt-8" style="display:none">
      <input id="gif_file" type="file" accept="image/gif,video/*" />
    </div>
    <div class="form-row mt-8">
      <div class="toggle-field"><span>Compress</span>
        <div class="checkbox-wrapper-8">
          <input class="tgl tgl-skewed" id="gif_compress" type="checkbox" checked />
          <label class="tgl-btn" data-tg-off="OFF" data-tg-on="ON" for="gif_compress"></label>
        </div>
      </div>
    </div>
  `;
  const bURL = el("gif_mode_url");
  const bFile = el("gif_mode_file");
  const urlArea = el("gif_url_area");
  const fileArea = el("gif_file_area");
  bURL.addEventListener("click", () => {
    bURL.classList.add("active");
    bFile.classList.remove("active");
    urlArea.style.display = "";
    fileArea.style.display = "none";
  });
  bFile.addEventListener("click", () => {
    bFile.classList.add("active");
    bURL.classList.remove("active");
    urlArea.style.display = "none";
    fileArea.style.display = "";
  });
  _msgModalSendHandler = async () => {
    const to = el("gif_to")?.value.trim();
    if (!to) throw new Error("Enter destination");
    const caption = el("gif_caption")?.value || undefined;
    let gif = null;
    if (bURL.classList.contains("active")) {
      gif = el("gif_url")?.value.trim();
      if (!gif) throw new Error("Enter GIF/Video URL");
    } else {
      const f = el("gif_file")?.files?.[0];
      if (!f) throw new Error("Pick a file");
      gif = await readFileAsDataURL(f);
    }
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/gif", "POST", {
      sessionId: currentSessionId,
      to,
      gif,
      caption,
      compress: !!el("gif_compress")?.checked,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildLocationForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="loc_to2" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <input id="loc_search" placeholder="search place (optional)" />
      <button id="loc_search_btn" type="button" class="btn btn-secondary">Search</button>
      <button id="loc_geo_btn" type="button" class="btn btn-secondary">Use My Location</button>
    </div>
    <div class="map-wrap mt-8"><div id="leafletMap"></div></div>
    <div class="form-row mt-8">
      <input id="loc_name2" placeholder="name (optional)" />
      <input id="loc_addr2" placeholder="address (optional)" />
    </div>
    <div class="form-row mt-8">
      <input id="loc_lat2" placeholder="latitude" readonly />
      <input id="loc_lng2" placeholder="longitude" readonly />
    </div>
    <div class="row mt-6"><span class="inline-note">Click map to set point, or search a place. Lat/Lng auto-filled.</span></div>
  `;
  let map, marker;
  const initMap = () => {
    if (!window.L || map) return;
    map = L.map("leafletMap").setView([-6.2, 106.8], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    const markerSvg = `<?xml version='1.0' encoding='UTF-8'?><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 36'><defs><linearGradient id='g' x1='0' x2='0' y1='0' y2='1'><stop offset='0' stop-color='#3b82f6'/><stop offset='1' stop-color='#2563eb'/></linearGradient></defs><path fill='url(#g)' d='M12 0C5.4 0 0 5.1 0 11.4 0 19.1 12 36 12 36s12-16.9 12-24.6C24 5.1 18.6 0 12 0z'/><circle cx='12' cy='11.5' r='4.5' fill='#ffffff' fill-opacity='0.95'/><circle cx='12' cy='11.5' r='2.5' fill='#3b82f6'/><ellipse cx='12' cy='35' rx='4' ry='1' fill='#000' fill-opacity='0.12'/></svg>`;
    const markerIcon = L.icon({
      iconUrl:
        "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(markerSvg),
      iconSize: [28, 40],
      iconAnchor: [14, 38],
      popupAnchor: [0, -34],
      className: "leaflet-marker-modern",
    });
    const setPoint = async (latlng) => {
      if (!marker) marker = L.marker(latlng, { icon: markerIcon }).addTo(map);
      else {
        marker.setLatLng(latlng);
        marker.setIcon(markerIcon);
      }
      el("loc_lat2").value = String(latlng.lat.toFixed(6));
      el("loc_lng2").value = String(latlng.lng.toFixed(6));
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latlng.lat}&lon=${latlng.lng}`
        );
        const j = await r.json();
        if (j) {
          const disp = j.display_name || "";
          const addr = j.address || {};
          if (disp) el("loc_name2").value = disp;
          const addrStr = [
            addr.road,
            addr.suburb,
            addr.city || addr.town,
            addr.state,
            addr.country,
          ]
            .filter(Boolean)
            .join(", ");
          if (addrStr) el("loc_addr2").value = addrStr;
        }
      } catch {}
    };
    map.on("click", (e) => setPoint(e.latlng));
    const geoBtn = el("loc_geo_btn");
    geoBtn?.addEventListener("click", () => {
      if (!navigator.geolocation)
        return toast("Geolocation unsupported", "warn");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          const ll = { lat: latitude, lng: longitude };
          map.setView(ll, 15);
          setPoint(ll);
        },
        () => toast("Location blocked", "warn"),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
    const searchBox = el("loc_search");
    const row = searchBox?.parentElement;
    if (row) row.style.position = row.style.position || "relative";
    const suggestList = document.createElement("div");
    suggestList.className = "suggest-list";
    row?.appendChild(suggestList);
    let lastCtrl = null;
    const renderList = (items) => {
      suggestList.innerHTML = "";
      if (!items || !items.length) {
        suggestList.classList.remove("show");
        return;
      }
      items.forEach((it) => {
        const di = document.createElement("div");
        di.className = "suggest-item";
        di.textContent = it.display_name || "";
        di.addEventListener("click", () => {
          const ll = { lat: parseFloat(it.lat), lng: parseFloat(it.lon) };
          map.setView(ll, 15);
          setPoint(ll);
          if (searchBox) searchBox.value = it.display_name || searchBox.value;
          suggestList.classList.remove("show");
        });
        suggestList.appendChild(di);
      });
      suggestList.classList.add("show");
    };
    const doSearch = async () => {
      const q = searchBox?.value?.trim();
      if (!q) {
        suggestList.classList.remove("show");
        return;
      }
      try {
        if (lastCtrl) lastCtrl.abort();
        lastCtrl = new AbortController();
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(
            q
          )}`,
          { headers: { Accept: "application/json" }, signal: lastCtrl.signal }
        );
        const items = await r.json();
        renderList(Array.isArray(items) ? items : []);
      } catch {}
    };
    el("loc_search_btn")?.addEventListener("click", doSearch);
    searchBox?.addEventListener("input", debounce(doSearch, 250));
  };
  setTimeout(initMap, 0);
  _msgModalSendHandler = async () => {
    const to = el("loc_to2")?.value.trim();
    const lat = parseFloat(el("loc_lat2")?.value);
    const lng = parseFloat(el("loc_lng2")?.value);
    const name = el("loc_name2")?.value || undefined;
    const address = el("loc_addr2")?.value || undefined;
    if (!to || !Number.isFinite(lat) || !Number.isFinite(lng))
      throw new Error("Pick a location and destination");
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/location", "POST", {
      sessionId: currentSessionId,
      to,
      location: { latitude: lat, longitude: lng, name, address },
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildPollForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="poll_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <input id="poll_q" placeholder="poll title / question" />
      <input id="poll_max" type="number" min="1" value="1" placeholder="max selection" />
    </div>
    <div class="form-row mt-8">
      <div class="url-list" id="poll_opts"></div>
      <div><button id="btnAddOpt" type="button" class="btn btn-secondary">+ Add Option</button></div>
    </div>
  `;
  const list = el("poll_opts");
  const addOpt = (val = "") => {
    const row = document.createElement("div");
    row.className = "list-item";
    const safeVal = escapeHTML(val || "");
    row.innerHTML = `<input type="text" placeholder="option" value="${safeVal}"/><button type="button" class="btn btn-secondary">Remove</button>`;
    row.querySelector("button").addEventListener("click", () => row.remove());
    list.appendChild(row);
  };
  ["Yes", "No"].forEach((v) => addOpt(v));
  el("btnAddOpt").addEventListener("click", () => addOpt(""));
  _msgModalSendHandler = async () => {
    const to = el("poll_to")?.value.trim();
    const question = el("poll_q")?.value.trim();
    const maxSelection = Math.max(1, parseInt(el("poll_max")?.value) || 1);
    const options = Array.from(list.querySelectorAll("input"))
      .map((i) => (i.value || "").trim())
      .filter(Boolean);
    if (!to || !question || options.length < 2) {
      throw new Error("Enter destination, question, and at least 2 options");
    }
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/poll", "POST", {
      sessionId: currentSessionId,
      to,
      poll: { question, options, maxSelection },
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildContactForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="vc_to2" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <input id="vc_name" placeholder="Full Name" />
      <input id="vc_org2" placeholder="Organization (optional)" />
    </div>
    <div class="form-row mt-8">
      <input id="vc_phone2" placeholder="Phone 62xxxx" />
      <input id="vc_email2" placeholder="Email (optional)" />
    </div>
  `;
  _msgModalSendHandler = async () => {
    const to = el("vc_to2")?.value.trim();
    const name = el("vc_name")?.value.trim();
    const phone = el("vc_phone2")?.value.trim();
    const organization = el("vc_org2")?.value || undefined;
    const email = el("vc_email2")?.value || undefined;
    if (!to || !name || !phone) throw new Error("Fill to, name, and phone");
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/contact", "POST", {
      sessionId: currentSessionId,
      to,
      contact: { name, phone, organization, email },
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildButtonForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="btn_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <textarea id="btn_text" class="flex-1" rows="3" placeholder="message text..."></textarea>
    </div>
    <div class="form-row mt-8">
      <input id="btn_footer" placeholder="footer (optional)" />
    </div>
    <div class="form-row mt-8">
      <div class="segctrl" role="tablist" aria-label="Image mode">
              <div class="mr-2"> Header Image: </div> 
        <button id="btn_img_mode_default" class="active" type="button" role="tab" aria-selected="true">Default</button>
        <button id="btn_img_mode_url" type="button" role="tab" aria-selected="false">URL</button>
        <button id="btn_img_mode_file" type="button" role="tab" aria-selected="false">Upload</button>
      </div>
    </div>
    <div id="btn_img_url_area" class="form-row mt-8" style="display:none">
      <input id="btn_image_url" type="url" placeholder="https://... (image)" />
    </div>
    <div id="btn_img_file_area" class="form-row mt-8" style="display:none">
      <input id="btn_image_file" type="file" accept="image/*" />
    </div>
    <div class="form-row mt-8">
      <div class="subcard full">
        <div class="subcard-head">
          <div class="subcard-title">Buttons</div>
          <div><button id="btn_add" type="button" class="btn btn-secondary">+ Add Button</button></div>
        </div>
        <div id="btn_rows" class="url-list"></div>
      </div>
    </div>
  `;
  const list = el("btn_rows");
  const btnImgDefault = el("btn_img_mode_default");
  const btnImgUrl = el("btn_img_mode_url");
  const btnImgFile = el("btn_img_mode_file");
  const btnImgUrlArea = el("btn_img_url_area");
  const btnImgFileArea = el("btn_img_file_area");
  const setBtnImgMode = (mode) => {
    const isDef = mode === "default";
    const isUrl = mode === "url";
    const isFile = mode === "file";
    if (btnImgDefault) {
      btnImgDefault.classList.toggle("active", isDef);
      btnImgDefault.setAttribute("aria-selected", isDef ? "true" : "false");
    }
    if (btnImgUrl) {
      btnImgUrl.classList.toggle("active", isUrl);
      btnImgUrl.setAttribute("aria-selected", isUrl ? "true" : "false");
    }
    if (btnImgFile) {
      btnImgFile.classList.toggle("active", isFile);
      btnImgFile.setAttribute("aria-selected", isFile ? "true" : "false");
    }
    if (btnImgUrlArea) btnImgUrlArea.style.display = isUrl ? "" : "none";
    if (btnImgFileArea) btnImgFileArea.style.display = isFile ? "" : "none";
  };
  btnImgDefault?.addEventListener("click", () => setBtnImgMode("default"));
  btnImgUrl?.addEventListener("click", () => setBtnImgMode("url"));
  btnImgFile?.addEventListener("click", () => setBtnImgMode("file"));
  setBtnImgMode("default");
  const MAX_BTNS = 3;
  const updateAddState = () => {
    const btn = el("btn_add");
    if (btn)
      btn.disabled = list.querySelectorAll(".list-item").length >= MAX_BTNS;
  };
  const addRow = (data = {}) => {
    if (list.querySelectorAll(".list-item").length >= MAX_BTNS) return;
    const row = document.createElement("div");
    row.className = "list-item";
    const type = data.type || "reply";
    const displayText = data.displayText || "";
    const id = data.id || "";
    const url = data.url || "";
    const phoneNumber = data.phoneNumber || "";
    const copyCode = data.copyCode || "";
    const safeDisplayText = escapeHTML(displayText);
    const safeId = escapeHTML(id);
    const safeUrl = escapeHTML(url);
    const safePhone = escapeHTML(phoneNumber);
    const safeCopy = escapeHTML(copyCode);
    row.innerHTML = `
      <select class="btn-type">
        <option value="reply" ${
          type === "reply" ? "selected" : ""
        }>Reply</option>
        <option value="url" ${type === "url" ? "selected" : ""}>URL</option>
        <option value="call" ${type === "call" ? "selected" : ""}>Call</option>
        <option value="copy" ${type === "copy" ? "selected" : ""}>Copy</option>
      </select>
      <input class="btn-text" placeholder="display text" value="${safeDisplayText}" />
      <input class="btn-id" placeholder="id (reply)" value="${safeId}" />
      <input class="btn-url" placeholder="url (for URL)" value="${safeUrl}" />
      <input class="btn-phone" placeholder="phone (for Call)" value="${safePhone}" />
      <input class="btn-copy" placeholder="copy code (for Copy)" value="${safeCopy}" />
      <button type="button" class="btn btn-secondary btn-remove">Remove</button>
    `;
    row.querySelector(".btn-remove").addEventListener("click", () => {
      row.remove();
      updateAddState();
    });
    const typeSel = row.querySelector(".btn-type");
    const syncVis = () => {
      const t = typeSel.value;
      row.querySelector(".btn-id").style.display = t === "reply" ? "" : "none";
      row.querySelector(".btn-url").style.display = t === "url" ? "" : "none";
      row.querySelector(".btn-phone").style.display =
        t === "call" ? "" : "none";
      row.querySelector(".btn-copy").style.display = t === "copy" ? "" : "none";
    };
    typeSel.addEventListener("change", syncVis);
    syncVis();
    list.appendChild(row);
  };
  el("btn_add").addEventListener("click", () => {
    addRow();
    updateAddState();
  });
  updateAddState();
  _msgModalSendHandler = async () => {
    const to = el("btn_to")?.value.trim();
    const text = el("btn_text")?.value || "";
    const footer = el("btn_footer")?.value || undefined;
    let image = undefined;
    try {
      if (btnImgUrl?.classList.contains("active")) {
        const url = el("btn_image_url")?.value.trim();
        if (url) image = url;
      } else if (btnImgFile?.classList.contains("active")) {
        const f = el("btn_image_file")?.files?.[0];
        if (f) image = await readFileAsDataURL(f);
      }
    } catch {}
    if (!to || !text) throw new Error("Enter destination and text");
    const buttons = Array.from(list.querySelectorAll(".list-item"))
      .map((r) => {
        const type = r.querySelector(".btn-type").value;
        const displayText = (r.querySelector(".btn-text").value || "").trim();
        const id = (r.querySelector(".btn-id").value || "").trim();
        const url = (r.querySelector(".btn-url").value || "").trim();
        const phoneNumber = (r.querySelector(".btn-phone").value || "").trim();
        const copyCode = (r.querySelector(".btn-copy").value || "").trim();
        const base = { type, displayText };
        if (type === "reply" && id) base.id = id;
        if (type === "url" && url) base.url = url;
        if (type === "call" && phoneNumber) base.phoneNumber = phoneNumber;
        if (type === "copy" && copyCode) base.copyCode = copyCode;
        return base;
      })
      .filter((b) => b.displayText)
      .slice(0, MAX_BTNS);
    if (!buttons.length) throw new Error("Add at least one button");
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    await api("/api/v1/messages/send/button", "POST", {
      sessionId: currentSessionId,
      to,
      text,
      footer,
      image,
      buttons,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    });
  };
}

function buildListForm(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="form-row">
      <input id="list_to" placeholder="to (62xxxx or JID)" />
    </div>
    <div class="form-row mt-8">
      <textarea id="list_text" class="flex-1" rows="3" placeholder="text"></textarea>
    </div>
    <div class="form-row mt-8">
      <input id="list_footer" placeholder="footer (optional)" />
    </div>
    <div class="form-row mt-8">
      <div class="segctrl" role="tablist" aria-label="Image mode">
        <div class="mr-2"> Header Image: </div> 
      <button id="list_img_mode_default" class="active" type="button" role="tab" aria-selected="true">Default</button>
        <button id="list_img_mode_url" type="button" role="tab" aria-selected="false">URL</button>
        <button id="list_img_mode_file" type="button" role="tab" aria-selected="false">Upload</button>
      </div>
    </div>
    <div id="list_img_url_area" class="form-row mt-8" style="display:none">
      <input id="list_image_url" type="url" placeholder="https://... (image)" />
    </div>
    <div id="list_img_file_area" class="form-row mt-8" style="display:none">
      <input id="list_image_file" type="file" accept="image/*" />
    </div>
    <div class="form-row mt-8">
      <div class="subcard full">
        <div class="subcard-head">
          <div class="subcard-title">List Buttons</div>
          <div><button id="lb_add" type="button" class="btn btn-secondary">+ Add List Button</button></div>
        </div>
        <div id="lb_items" class="mt-4"></div>
      </div>
    </div>
  `;
  const container = el("lb_items");
  const listImgDefault = el("list_img_mode_default");
  const listImgUrl = el("list_img_mode_url");
  const listImgFile = el("list_img_mode_file");
  const listImgUrlArea = el("list_img_url_area");
  const listImgFileArea = el("list_img_file_area");
  const setListImgMode = (mode) => {
    const isDef = mode === "default";
    const isUrl = mode === "url";
    const isFile = mode === "file";
    if (listImgDefault) {
      listImgDefault.classList.toggle("active", isDef);
      listImgDefault.setAttribute("aria-selected", isDef ? "true" : "false");
    }
    if (listImgUrl) {
      listImgUrl.classList.toggle("active", isUrl);
      listImgUrl.setAttribute("aria-selected", isUrl ? "true" : "false");
    }
    if (listImgFile) {
      listImgFile.classList.toggle("active", isFile);
      listImgFile.setAttribute("aria-selected", isFile ? "true" : "false");
    }
    if (listImgUrlArea) listImgUrlArea.style.display = isUrl ? "" : "none";
    if (listImgFileArea) listImgFileArea.style.display = isFile ? "" : "none";
  };
  listImgDefault?.addEventListener("click", () => setListImgMode("default"));
  listImgUrl?.addEventListener("click", () => setListImgMode("url"));
  listImgFile?.addEventListener("click", () => setListImgMode("file"));
  setListImgMode("default");
  const btnAdd = el("lb_add");
  const MAX_ITEMS = 3;
  const updateAddState = () => {
    const count = container.querySelectorAll(".lb-item").length;
    if (btnAdd) btnAdd.disabled = count >= MAX_ITEMS;
  };
  const addListButton = (data = {}) => {
    if (container.querySelectorAll(".lb-item").length >= MAX_ITEMS) return;
    const wrap = document.createElement("div");
    wrap.className = "lb-item subcard mt-8";
    const safeBtnText = escapeHTML(data.buttonText || "");
    wrap.innerHTML = `
      <div class="subcard-head">
        <div class="subcard-title">Button Item</div>
        <div><button type="button" class="btn btn-secondary lb-remove">Remove</button></div>
      </div>
      <div class="form-row">
        <input class="lb-btntext" placeholder="button text (e.g. Open)" value="${safeBtnText}" />
      </div>
      <div class="form-row mt-8">
        <div class="subcard full">
          <div class="subcard-head">
            <div class="subcard-title">Sections</div>
            <div><button type="button" class="btn btn-secondary sec-add">+ Add Section</button></div>
          </div>
          <div class="sections"></div>
        </div>
      </div>
    `;
    const sections = wrap.querySelector(".sections");
    const addSection = (sec = {}) => {
      const secEl = document.createElement("div");
      secEl.className = "section subcard mt-6";
      const safeSectionTitle = escapeHTML(sec.title || "");
      secEl.innerHTML = `
        <div class="subcard-head">
          <div class="subcard-title">Section</div>
          <div><button type="button" class="btn btn-secondary sec-remove">Remove</button></div>
        </div>
        <div class="form-row">
          <input class="sec-title" placeholder="Title Row" value="${safeSectionTitle}" />
        </div>
        <div class="form-row mt-8">
          <div class="subcard full">
            <div class="subcard-head">
              <div class="subcard-title">Rows</div>
              <div><button type="button" class="btn btn-secondary row-add">+ Add Row</button></div>
            </div>
            <div class="rows"></div>
          </div>
        </div>
      `;
      const rows = secEl.querySelector(".rows");
      const addRow = (row = {}) => {
        const r = document.createElement("div");
        r.className = "list-item";
        const safeRowId = escapeHTML(row.id || "");
        const safeRowTitle = escapeHTML(row.title || "");
        const safeRowDesc = escapeHTML(row.description || "");
        const safeRowHeader = escapeHTML(row.header || "");
        r.innerHTML = `
          <input class="row-id" placeholder="id (reply)" value="${safeRowId}" />
          <input class="row-title" placeholder="title" value="${safeRowTitle}" />
          <input class="row-desc" placeholder="description (optional)" value="${safeRowDesc}" />
          <input class="row-header" placeholder="header (optional)" value="${safeRowHeader}" />
          <button type="button" class="btn btn-secondary row-remove">Remove</button>
        `;
        r.querySelector(".row-remove").addEventListener("click", () =>
          r.remove()
        );
        rows.appendChild(r);
      };
      secEl
        .querySelector(".row-add")
        .addEventListener("click", () => addRow({}));
      secEl
        .querySelector(".sec-remove")
        .addEventListener("click", () => secEl.remove());
      if (!sec.rows || !sec.rows.length) {
      } else {
        sec.rows.forEach(addRow);
      }
      sections.appendChild(secEl);
    };
    wrap
      .querySelector(".sec-add")
      .addEventListener("click", () => addSection({}));
    wrap.querySelector(".lb-remove").addEventListener("click", () => {
      wrap.remove();
      updateAddState();
    });
    container.appendChild(wrap);
    updateAddState();
  };
  btnAdd?.addEventListener("click", () => {
    addListButton({});
    updateAddState();
  });
  _msgModalSendHandler = async () => {
    const to = el("list_to")?.value.trim();
    const text = el("list_text")?.value || "";
    const footer = el("list_footer")?.value || undefined;
    let image = undefined;
    try {
      if (listImgUrl?.classList.contains("active")) {
        const url = el("list_image_url")?.value.trim();
        if (url) image = url;
      } else if (listImgFile?.classList.contains("active")) {
        const f = el("list_image_file")?.files?.[0];
        if (f) image = await readFileAsDataURL(f);
      }
    } catch {}
    if (!to || !text) throw new Error("Enter destination and text");
    const items = Array.from(container.querySelectorAll(".lb-item"))
      .map((it) => {
        const buttonText =
          (it.querySelector(".lb-btntext").value || "").trim() || "Open";
        const sections = Array.from(it.querySelectorAll(".section"))
          .map((s) => {
            const title = (s.querySelector(".sec-title").value || "").trim();
            const rows = Array.from(s.querySelectorAll(".rows .list-item"))
              .map((r) => ({
                id:
                  (r.querySelector(".row-id").value || "").trim() || undefined,
                title: (r.querySelector(".row-title").value || "").trim(),
                description:
                  (r.querySelector(".row-desc").value || "").trim() ||
                  undefined,
                header:
                  (r.querySelector(".row-header").value || "").trim() ||
                  undefined,
              }))
              .filter((r) => r.title);
            return { title, rows };
          })
          .filter((sec) => sec.rows.length);
        return { buttonText, sections };
      })
      .filter((it) => it.sections && it.sections.length);
    if (!items.length) throw new Error("Add at least one section and row");
    const { presence, isForwarded, replyMessageId } = readMsgCommonOptions();
    const body = {
      sessionId: currentSessionId,
      to,
      text,
      footer,
      image,
      presence,
      replyMessageId: replyMessageId || undefined,
      isForwarded,
    };
    if (items.length === 1) body.list = items[0];
    else body.lists = items.slice(0, 3);
    await api("/api/v1/messages/send/list", "POST", body);
  };
}

function initMessagingCards() {
  const wrap = document.getElementById("msgCards");
  if (!wrap) return;
  const handler = (type) => {
    try {
      requireSession({ mustBeOpen: true });
    } catch {
      return;
    }
    if (type === "text") return openMsgModal(type, buildTextForm);
    if (type === "media-single")
      return openMsgModal("media", buildMediaSingleForm);
    if (type === "audio") return openMsgModal("audio", buildAudioForm);
    if (type === "document") return openMsgModal("document", buildDocumentForm);
    if (type === "sticker") return openMsgModal("sticker", buildStickerForm);
    if (type === "contact") return openMsgModal("contact", buildContactForm);
    if (type === "location") return openMsgModal("location", buildLocationForm);
    if (type === "poll") return openMsgModal("poll", buildPollForm);
    if (type === "gif") return openMsgModal("gif", buildGifForm);
    if (type === "button") return openMsgModal("button", buildButtonForm);
    if (type === "list") return openMsgModal("list", buildListForm);
    if (type === "media-file")
      return openMsgModal("media-multi", (root) => buildMediaMultiForm(root));
  };
  wrap.querySelectorAll(".msg-card").forEach((card) => {
    card.addEventListener("click", () => handler(card.dataset.type));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler(card.dataset.type);
      }
    });
  });
  const { overlay, send, cancel, close } = msgModalEl();
  const onClose = () => closeMsgModal();
  cancel?.addEventListener("click", onClose);
  close?.addEventListener("click", onClose);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) onClose();
  });
  send?.addEventListener("click", async () => {
    if (!send) return;
    try {
      requireSession({ mustBeOpen: true });
    } catch {
      return;
    }
    try {
      setBtnBusy(send, true, "Send", "Sending...");
      if (typeof _msgModalSendHandler === "function")
        await _msgModalSendHandler();
      toast("Message has been sent");
      closeMsgModal();
    } catch (e) {
      toast(e.message || "Failed", "err");
    } finally {
      setBtnBusy(send, false, "Send", "Sending...");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    initMessagingCards();
  } catch {}
  try {
    setMessagingAvailability(
      currentSessionId ? isSessionOpen(currentSessionId) : false
    );
  } catch {}
  try {
    if (
      pairModeActive() &&
      currentSessionId &&
      pairCodes.has(currentSessionId)
    ) {
      const ts = pairCodeTs.get(currentSessionId) || Date.now();
      setPairCode(pairCodes.get(currentSessionId), {
        forceRender: true,
        timestamp: ts,
      });
    }
  } catch {}
});

(function () {
  const ov = document.getElementById("editOverlay");
  const closeBtn = document.getElementById("editModalClose");
  if (ov) {
    ov.addEventListener("click", (e) => {
      if (e.target === ov)
        try {
          showEdit(false);
        } catch {}
    });
  }
  const doClose = () => {
    try {
      showEdit(false);
    } catch {}
  };
  if (closeBtn) closeBtn.addEventListener("click", doClose);
})();

function startAutoReconnectMonitor() {
  try {
    if (autoReconnTimer) return;
    autoReconnTimer = setInterval(async () => {
      try {
        if (!currentSessionId) return;
        const openDB = await ensureOpenStateFromServer(currentSessionId);
        if (openDB) {
          setSessionStatus(currentSessionId, "open");
          if (ioClient?.connected)
            ioClient.emit("join", { room: currentSessionId });
          updateCardStatusUI(currentSessionId);
        } else if (wasEverOpen(currentSessionId)) {
          maybeAutoReconnect(currentSessionId);
        }
      } catch {}
    }, 20000);
  } catch {}
}

function stopAutoReconnectMonitor() {
  try {
    if (autoReconnTimer) clearInterval(autoReconnTimer);
  } catch {}
  autoReconnTimer = 0;
}
