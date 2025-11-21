import express from "express";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8080);

const SECRETS = String("secret2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEBUG_SIG = process.env.DEBUG_SIGNATURE === "1";
const VERIFY_TS = process.env.WAREST_VERIFY_TS === "1";
const TOLERANCE_SEC = Number(process.env.WAREST_TOLERANCE_SEC || 300);

const app = express();

app.use(
  express.json({
    type: "application/json",
    verify: (req, _res, buf) => {
      try {
        req.rawBody = Buffer.from(buf);
      } catch {
        req.rawBody = buf;
      }
    },
  })
);

function algoFromHeader(header) {
  try {
    const m = String(header || "")
      .toUpperCase()
      .match(/^HMAC-SHA(224|256|384|512)$/);
    const bits = m ? m[1] : "256";
    return bits === "224"
      ? "sha224"
      : bits === "384"
      ? "sha384"
      : bits === "512"
      ? "sha512"
      : "sha256";
  } catch {
    return "sha256";
  }
}

function safeEqual(a, b) {
  try {
    const A = Buffer.from(String(a || ""), "utf8");
    const B = Buffer.from(String(b || ""), "utf8");
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function verify(req) {
  try {
    const sigHeader = String(req.get("X-WAREST-Signature") || "");
    const algHeader = String(req.get("X-WAREST-Signature-Alg") || "");
    const algo = algoFromHeader(algHeader);
    const username = String(req.get("X-WAREST-Username") || "");
    const tsStr = String(req.get("X-WAREST-Timestamp") || "");
    const raw =
      req.rawBody instanceof Buffer
        ? req.rawBody
        : Buffer.from(JSON.stringify(req.body || {}));

    // Expected header: "HMAC-SHAxxx=<hex>"
    const parts = sigHeader.split("=");
    const token = (parts[0] || "").trim().toUpperCase();
    const hex = (parts[1] || "").trim();
    if (!token || !hex) return false;
    // Optionally cross-check token with Alg header; prefer Alg for algo choice
    const key = String(SECRETS[0] || "") + username; // try all secrets below
    for (const base of SECRETS) {
      const k = String(base || "") + username;
      const expected = crypto.createHmac(algo, k).update(raw).digest("hex");
      if (hex && safeEqual(expected, hex)) return true;
      if (DEBUG_SIG) {
        console.warn("[DEBUG] signature not matched with secret:", base);
        console.warn("[DEBUG] expected:", expected);
        console.warn("[DEBUG] got:", hex);
      }
    }
    return false;
  } catch {
    return false;
  }
}

app.post("/webhook", (req, res) => {
  const hdrs = {
    event: req.get("X-WAREST-Event"),
    session: req.get("X-WAREST-Session"),
    registry: req.get("X-WAREST-Registry"),
    username: req.get("X-WAREST-Username"),
    ts: req.get("X-WAREST-Timestamp"),
    eventId: req.get("X-WAREST-Event-Id") || null,
    version: req.get("X-WAREST-Version") || null,
  };
  const ok = verify(req);
  // Optional timestamp freshness check
  if (ok && VERIFY_TS) {
    const now = Date.now();
    const ts = Number(hdrs.ts || 0);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SEC * 1000) {
      console.warn("[WEBHOOK] timestamp out of tolerance");
      return res.status(401).json({ ok: false, error: "stale timestamp" });
    }
  }
  console.log("\n[WEBHOOK] headers:", hdrs);
  console.log("[WEBHOOK] body:", JSON.stringify(req.body, null, 2));
  if (!ok) {
    console.warn("[WEBHOOK] signature mismatch");
    return res.status(401).json({ ok: false, error: "bad signature" });
  }

  const actions = [];
  if (hdrs.event === "preflight") {
    return res.json({ ok: true, pong: true });
  }
  if (hdrs.event === "message_received") {
    const text = (req.body?.data?.text || "").trim().toLowerCase();
    const to = req.body?.data?.sender?.chatId;
    const ctype = String(req.body?.data?.contentType || "");
    const key = req.body?.data?.message?.key;
    if (!to) return res.json({ ok: true });

    switch (text) {
      case "test": {
        actions.push({ type: "text", to, text: "pong (from receiver)" });
        actions.push({ act: "delay", ms: 1000 });
        actions.push({ type: "text", to, text: `After delay for ${to}` });
        break;
      }

      case "typing": {
        actions.push({ act: "typing", ms: 12000, to });
        actions.push({ type: "text", to, text: "Typing done." });
        break;
      }

      case "delay-state": {
        actions.push({ act: "delay", ms: 1500, state: "composing", to });
        actions.push({ type: "text", to, text: "After composing delay" });
        break;
      }

      case "text": {
        actions.push({ type: "text", to, text: "Echo: text" });
        break;
      }

      case "button": {
        actions.push({
          type: "button",
          to,
          text: "Choose an option:",
          buttons: [
            { Btype: "reply", displayText: "Ping", id: "btn-ping" },
            {
              Btype: "url",
              displayText: "Open Docs",
              url: "https://baileys.wiki",
            },
            { Btype: "copy", displayText: "Copy Code", copyCode: "PROMO-2025" },
          ],
        });
        break;
      }

      case "list": {
        actions.push({
          type: "list",
          to,
          text: "Please select an item:",
          list: {
            buttonText: "Open Menu",
            sections: [
              {
                title: "Category A",
                rows: [
                  { id: "A1", title: "Item A1" },
                  { id: "A2", title: "Item A2", description: "Optional" },
                ],
              },
              { title: "Category B", rows: ["Item B1", "Item B2"] },
            ],
          },
        });
        break;
      }
      case "react": {
        if (key) actions.push({ act: "react", to, emoji: "👍", key });
        break;
      }
      case "read": {
        if (key) actions.push({ act: "read", key });
        break;
      }
      case "star": {
        if (key)
          actions.push({
            act: "star",
            to,
            key,
          });
        break;
      }
      case "presence": {
        actions.push({ act: "presence", state: "available" });
        actions.push({ act: "delay", ms: 500, state: "composing", to });
        break;
      }
      case "image": {
        actions.push({
          type: "media",
          to,
          mediaType: "image",
          url: "https://placehold.co/600x400.png",
          caption: "Sample image",
        });
        break;
      }
      case "video": {
        actions.push({
          type: "media",
          to,
          mediaType: "video",
          url: "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
          caption: "Sample video",
        });
        break;
      }
      case "gif": {
        actions.push({
          type: "media",
          to,
          mediaType: "gif",
          url: "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
          caption: "Sample gif",
        });
        break;
      }
      case "audio": {
        actions.push({
          type: "media",
          to,
          mediaType: "audio",
          url: "https://samplelib.com/lib/preview/mp3/sample-3s.mp3",
        });
        break;
      }
      case "doc":
      case "document": {
        actions.push({
          type: "document",
          to,
          url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
          filename: "sample.pdf",
          caption: "Here is your document",
        });
        break;
      }
      case "location": {
        actions.push({
          type: "location",
          to,
          lat: -6.2,
          lng: 106.816666,
          name: "HQ",
          address: "Jakarta",
        });
        break;
      }
      case "sticker": {
        actions.push({
          type: "sticker",
          to,
          imageUrl: "https://placehold.co/512x512.png",
        });
        break;
      }
      case "sticker-webp": {
        actions.push({
          type: "sticker",
          to,
          webpUrl: "https://www.gstatic.com/webp/gallery/1.sm.webp",
        });
        break;
      }
      case "vcard": {
        actions.push({
          type: "vcard",
          to,
          contact: {
            fullName: "John Doe",
            org: "Example Inc.",
            phone: "6281212345678",
            email: "john@example.com",
          },
        });
        break;
      }
      case "raw": {
        actions.push({
          type: "raw",
          to,
          message: { text: "Raw Baileys content body's" },
        });
        break;
      }
      case "forward": {
        actions.push({
          type: "forward",
          to,
          message: { text: "Forwarded content" },
        });
        break;
      }
      case "poll": {
        actions.push({
          type: "poll",
          to,
          message: {
            poll: {
              name: "Your favorite?",
              values: ["One", "Two", "Three"],
              selectableCount: 1,
            },
          },
        });
        break;
      }

      case "queue": {
        actions.push({
          act: "queue",
          delayMs: 500,
          items: [
            { type: "text", to, text: "Step 1" },
            { act: "delay", ms: 700 },
            { type: "text", to, text: "Step 2" },
            { act: "delay", ms: 10000, state: "composing", to },
            { type: "text", to, text: "Step 3" },
          ],
        });
        break;
      }

      case "parallel": {
        actions.push({
          act: "parallel",
          items: [
            {
              act: "queue",
              items: [
                { act: "delay", ms: 800 },
                { type: "text", to, text: "Branch A after 0.8s" },
              ],
            },
            { type: "text", to, text: "Branch B now" },
          ],
        });
        break;
      }

      case "when": {
        actions.push({
          act: "when",
          cond: "{{session.id}}",
          then: [
            { type: "text", to, text: "Condition truthy: session present" },
          ],
          else: [{ type: "text", to, text: "Condition falsy" }],
        });
        break;
      }

      case "retry": {
        actions.push({
          act: "retry",
          attempts: 3,
          delayMs: 400,
          item: { type: "raw", to, message: { bogus: true } },
          onFail: [{ type: "text", to, text: `Retry exhausted for ${to}` }],
        });
        break;
      }

      case "flow":
      case "combo": {
        actions.push({ type: "text", to, text: "Starting complex flow..." });
        actions.push({
          act: "parallel",
          items: [
            {
              act: "queue",
              delayMs: 300,
              items: [
                { type: "text", to, text: "A1" },
                { act: "delay", ms: 500 },
                { type: "text", to, text: "A2" },
              ],
            },
            {
              act: "queue",
              items: [
                { act: "delay", ms: 200 },
                { type: "text", to, text: "B1" },
                { type: "text", to, text: `B2 after list for ${to}` },
              ],
            },
          ],
        });
        break;
      }

      default: {
        const interactiveKinds = [
          "interactiveResponseMessage",
          "buttonsResponseMessage",
          "listResponseMessage",
          "templateButtonReplyMessage",
          "pollUpdateMessage",
        ];
        if (interactiveKinds.includes(ctype)) break;

        if (ctype === "conversation" || ctype === "extendedTextMessage") {
          // actions.push({
          //   type: "text",
          //   to,
          //   text: [
          //     "Try one of these commands:",
          //     "test | buttons | list | document | sticker | raw | poll",
          //     "queue | parallel | when | retry | combo",
          //   ].join("\n"),
          // });
        }
      }
    }
  }

  return res.json({ ok: true, actions, delayMs: 600 });
});

app.listen(PORT, () => {
  console.log(`[receiver] listening on http://localhost:${PORT}/webhook`);
  console.log(`[receiver] set WARest session webhookUrl to this endpoint`);
  console.log(
    `[receiver] Set env WAREST_SECRET as comma-separated for rotation`
  );
  console.log(
    `[receiver] Optional: WAREST_VERIFY_TS=1 to check timestamp freshness`
  );
});
