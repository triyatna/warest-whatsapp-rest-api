---
outline: deep
---

# Key Concepts & Terminology

Key Concepts & Terminology lists every core term used across WAREST: sessions, users, devices, registry, chats, messages, media objects, webhooks, the storage/cache/queue/proxy layers, identifier formats (phone numbers, JIDs/LIDs, message IDs, API keys), webhook events/actions/payload shapes, and the mapping to native WhatsApp concepts. Treat it as the authoritative vocabulary so integrations, UI, and automation jobs speak the same language as the platform.

## Definitions

### Session

A session represents a single authenticated WhatsApp account that WAREST controls. Sessions store Baileys credentials, webhook configuration, storage preferences, proxy assignments, and runtime flags such as queue overrides or auto-reply toggles. They can be created via `/api/v1/session/create` (QR) or `/api/v1/session/create/pair-code`, appear in the registry, and emit `session_status` webhooks whenever their lifecycle changes (connecting, open, reconnecting, logged_out, delete, etc.).

### User & API Key

WAREST ships with an admin user seeded from `WAREST_AUTHADMIN_USERNAME`/`WAREST_AUTHADMIN_PASSWORD` and an admin API key (`WAREST_ADMIN_APIKEY`). Additional users can be created via the UI or database seeds. API keys are required for REST access, docs browsing (cookie `WAREST_DOCS_SESSION`), and CLI automation. Each user may own a registry namespace so sessions can be scoped to a tenant.

### Device

Within WhatsApp multi-device, a device is a companion (phone, browser, or embedded client) bound to the session. WAREST reports paired devices via `/api/v1/session/devices` and can reconnect or logout specific devices. Device metadata includes the platform, last seen time, and proxies applied to that session.

### Registry

The session registry is the authoritative store that keeps every session's serialized credentials and metadata in SQLite/MySQL/PostgreSQL. It records `ownerId` (user/tenant), `label`, webhook URL/secret, storage preferences, and other flags. When WAREST boots, it loads the registry, bootstraps active sessions, and keeps the registry synchronized so workers or Docker replicas do not clash. Any session CRUD call updates the registry via `sessionRegistry.js`.

### Chat

Chats describe WhatsApp conversations (1:1, group, or community) exposed through `/api/v1/chats` and `/api/v1/chats/:chatId/messages`. Chat IDs always align with WhatsApp JIDs (`<number>@s.whatsapp.net` or `<group>@g.us`). Chat operations (pin, mark read, archive, mute) map directly to WhatsApp chat states.

### Message

Messages are WhatsApp payloads that include content, media, metadata (message ID, timestamps, mentions, context info). Sending endpoints live under `/api/v1/messages/send/*`, while message actions (star, unstar, react, revoke, edit, delete) live under `/api/v1/messages/:messageId/action/*`. Incoming messages generate `message_received`, `message_reaction`, `message_command`, `message_edited`, or `message_revoked` webhook events.

### Media Object

A media object is any attachment (image, video, audio, document, sticker, GIF, contact, location file) processed through WAREST. Media is compressed via sharp/FFmpeg and persisted using the selected storage driver. Metadata includes MIME type, file size, signed URL (for local storage), and S3 presigned URLs when using remote buckets.

### Webhook

Webhooks are signed HTTP callbacks that notify downstream systems about session status, messages, group events, presence, or call updates. Each session can override its webhook URL/secret, or fall back to `WEBHOOK_DEFAULT_URL`/`WEBHOOK_DEFAULT_SECRET`. WAREST signs bodies using SHA-2 HMAC and sends `X-WAREST-*` headers so receivers can verify authenticity. Preflight checks (`/api/v1/webhook/preflight`) verify reachability and signature handling before persisting URLs.

### Webhook Preflight

The preflight endpoint (`POST /api/v1/webhook/preflight`) performs a lightweight delivery test using the configured URL/secret. It sends a minimal payload with `X-WAREST-Preflight: 1` so receivers can validate signatures before live events flow. Failures prevent the URL from being stored until corrected.

### Action Runner

When webhook receivers return `actions`, WAREST executes them through the action runner embedded in the webhook service. The runner supports send actions (`text`, `media`, `document`, `location`, `sticker`, `vcard`, `button`, `list`, `poll`, `forward`, `raw`, `noop`) and control/flow actions (`delay`, `typing`, `presence`, `react`, `star`, `unstar`, `delete`, `revoke`, `edit`, `read`, `queue`, `parallel`, `when`, `retry`). Each action ultimately calls a Baileys socket helper, so payloads must contain the same keys the REST API expects (e.g., `to`, `jid`, `key`, `message`).

### Storage Driver

Storage drivers handle binary persistence for media and static assets. Two drivers ship out of the box:

- `local` - stores encrypted blobs under `data/private/storages` (and publicly served files under `data/public/storages`). Supports AES-256-GCM, signed URLs, and TTL configuration.
- `s3` - integrates with any S3-compatible service (AWS S3, MinIO, R2) and generates presigned URLs, optional SSE/KMS, path-style toggles, and CDN overrides.

### Cache

Caching accelerates deduplication and metadata lookups. Available drivers: `local` (in-memory), `redis`, `memcached`, and `mongodb`. Each driver is configured through the corresponding `WAREST_CACHE_*` environment variables. Cache entries back features such as version negotiation, signature throttling, and session metadata.

### Queue

WAREST includes a guarded task queue that wraps rate limiting, retry-with-backoff, anti-spam cooldowns, and concurrency controls for outbound sends. Queue parameters include `WAREST_QUEUE_CONCURRENCY`, `WAREST_QUEUE_MAX_SIZE`, `WAREST_QUEUE_TIMEOUT_MS`, and retry/backoff/jitter settings. Every send call passes through the queue before hitting the Baileys transport.

### Guards & Middleware

Dynamic rate limiting (`RATE_LIMIT_*`), anti-spam cooldowns (`SPAM_COOLDOWN_MS`, `QUOTA_*`), auth checks, and per-session quotas enforce fair usage before requests reach business logic. Guards apply per user/API key and integrate with the queue to reject or delay abusive traffic.

### Proxy Pool

Proxy pools help route outbound traffic through HTTP/SOCKS proxies to evade IP throttling or to satisfy corporate network policies. Configure proxies via `WAREST_PROXY_URLS` and set strategy (`failover`, `round_robin`, or `random`). Additional knobs govern sticky sessions, failure thresholds, cooldowns, and backoff multipliers.

### Observability Endpoints

`/api/v1/server/*` exposes readiness/health, CPU history, restart controls, and queue metrics so you can gauge node-level health. These endpoints feed dashboards or alerting rules.

## Identifiers

| Identifier | Description | Example |
| ---------- | ----------- | ------- |
| **Session ID** | UUID-like string assigned by WAREST when a session is created (also used as `:sessionId` in REST routes). | `b1a6191b-bc1d-4a08-9097-46b392e77bd0` |
| **Device ID** | WhatsApp/MD-specific unique identifier for a paired device (surface via `/session/devices`). | `4C6E21F0B3EB4F0D8B` |
| **Phone Number** | Input supplied by clients to identify a destination (digits only). Normalized by WAREST using `WAREST_DEFAULT_COUNTRY_CODE` before being converted to JIDs/LIDs. | `6281234567890` |
| **JID (Jabber/WhatsApp ID)** | Canonical identifier WhatsApp uses for contacts/chats (`<digits>@s.whatsapp.net`, `<group>@g.us`, `<business>@c.us`). Required by Baileys for send targets and webhook payloads. Validate via `/api/v1/misc/whatsapp/validate/jid`. | `6281234567890@s.whatsapp.net` |
| **LID (Long ID)** | Numeric "LID" namespace used by some WhatsApp APIs for business and marketing workloads. Resolve to JIDs via `/api/v1/misc/whatsapp/resolve/jid-or-lid`. | `16501234567890123` |
| **Chat ID** | Alias for JID when referencing chat routes; includes groups and community sub-chats. | `120363025386030504@g.us` |
| **Message ID** | Unique WhatsApp message key (status: `fromMe`, `id`, `remoteJid`). Passed to action endpoints and shipped in webhook payloads. | `3EB0EC4ED6916F3F123` |
| **Webhook Event ID** | UUID assigned per event to support idempotency and deduplication on receivers (`X-WAREST-Event-Id`). | `evt_01HF5QZVQSK3T1SH4Z2RCB2DQB` |
| **Delivery Attempt** | Counter attached to a webhook retry (`X-WAREST-Delivery-Attempt`). | `3` |
| **Admin API Key** | Value of `WAREST_ADMIN_APIKEY` or user-specific keys stored in the DB. Required in `Authorization: Bearer` or `X-WAREST-API-Key`. | `warest-admin-key` |
| **Registry ID** | User/tenant identifier stored with each session (`ownerId`). Appears in `X-WAREST-Registry` header. | `usr_01HF5R3Y34W8Y3S6J1X` |
| **Session Label** | Human-friendly label stored alongside each session. Included in `X-WAREST-Label`. | `support-bot` |
| **Webhook Secret** | Session-specific HMAC secret stored in `sessionRegistry`. Combined with username when hashing payloads. | `rQYrmT5h3vP2` |
| **Storage Object Key** | Path generated by the storage driver (local path or S3 key). Signed URLs embed this key. | `sessions/WAREST-01/media/2024/11/24/abc12345.webp` |

## Webhook Events, Actions, and Payloads

WAREST emits webhook events whenever interesting activity occurs. Core properties:

- **Headers**: `X-WAREST-Signature`, `X-WAREST-Signature-Alg`, `X-WAREST-Timestamp`, `X-WAREST-Event`, `X-WAREST-Event-Id`, `X-WAREST-Session`, `X-WAREST-Registry`, `X-WAREST-Label`, `X-WAREST-Username`, `X-WAREST-Version`, and `X-WAREST-Delivery-Attempt` (per try).
- **Body fields**: `event` (string), `data` (event payload), `ts` (epoch millis), and `session` (object with `id`, `label`, `registry`, `username`).
- **Signing**: `HMAC-SHAxxx` (length configurable) computed over the raw JSON body with key = `secret + username`.
- **Retries**: Controlled by `WAREST_WEBHOOK_RETRIES`, `WAREST_WEBHOOK_BACKOFF_MS`, `WAREST_WEBHOOK_JITTER_MS`. 401/403 responses pause delivery longer; 404/410 clear the URL.
- **Actions in Response**: Receivers can respond with `{ "actions": [...] }` to instruct WAREST to send replies, mark read, mute chats, etc.

### Event Catalog

| Event | Purpose | Payload Highlights |
| ----- | ------- | ------------------ |
| `session_status` | Session lifecycle changes (create/open/reconnecting/logged_out/qr/pairing_code/delete). | `data.tags`, `qr`, `qrDuration`, `me` (self JID). |
| `message_received` | Incoming message of any type. | `contentType`, `message`, `media` (signed URL + metadata), `sender`, normalized mentions. |
| `message_reaction` | Reaction added/removed. | `reaction`, `message key`. |
| `message_command` | Registered command triggered. | Command payload + chat context. |
| `message_edited` / `message_revoked` | Edits or revocations detected. | Previous message metadata and deltas. |
| `group_participants`, `group_join`, `group_leave`, `group_update` | Group lifecycle events (add/remove/promote/demote, join/leave, subject/announce changes). | Participant JIDs, admin, group JID, new settings. |
| `presence_update` | Contact presence change. | Contact JID, presence state, optional `lastSeen`. |
| `creds_update` | Credential refresh (Baileys). | Minimal fields to persist or audit. |
| `call` | Incoming/outgoing calls. | Call ID, from, `isVideo`, `isGroup`, timestamp. |

### Action Types

**Send actions (`type` field) available in `runAction`:**

- `text` – send plain text with optional `mentions`, `quoted`, and `options` recognized by Baileys.
- `media` – `mediaType` (`image`, `video`, `gif`, `audio`) plus source `url`. Optional `transform.sharp` (resize/WebP/JPEG/PNG) and `transcode` (FFmpeg) allow on-the-fly processing. Supports `caption`.
- `document` – document `url`, optional `filename`, `caption`. MIME type inferred from HTTP response and file extension.
- `location` – `lat`, `lng`, with optional `name`, `address`.
- `sticker` – either `webpUrl` or `imageUrl`. Non-WebP sources are resized to 512×512 and converted to WebP.
- `vcard` – `contact` payload (`fullName`, `org`, `phone`, `email`) generates a standard VCARD.
- `button` – interactive buttons; provide prebuilt `message` or define `buttons`, `text`, `footer`, `image`, `quoted`.
- `list` – interactive list message using `list`/`lists` or `sections` + `buttonText`.
- `poll` – pass the message object generated by `/api/v1/messages/send/poll`.
- `forward` – forward an existing message by supplying `message`.
- `raw` – send any Baileys-compatible payload verbatim (advanced usage).
- `noop` – explicit no-op (useful for branching without output).

**Control/flow actions handled by `runControlAction`:**

- `delay` – sleep for `ms` or `seconds`; optional `state` (`composing`, `recording`) + `to` emit presence before/after sleeping.
- `typing` – shorthand for `composing` presence for `ms` milliseconds.
- `presence` – set presence state (`available`, `unavailable`, etc.) globally or for a specific chat.
- `react` – send emoji reaction; needs `key` and optional `to`.
- `star` / `unstar` – toggle star state using `key` (`fromMe` flag respected).
- `delete` – delete message for current device with optional `deleteMedia`.
- `revoke` – delete for everyone (`delete`), plus optional local delete via `deleteForMe`.
- `edit` – replace message content; requires `key` and new `text`/`message`.
- `read` – mark messages read; accept single `key` or `keys` array.
- `queue` – run `items` sequentially with optional per-step `delayMs`.
- `parallel` – execute `items` concurrently.
- `when` – branch based on `cond`/`condition`; evaluate string truthiness and run `then`/`else` arrays.
- `retry` – retry `item`/`items[0]` up to `attempts` times with `delayMs`/`backoffMs`, then optionally run `onFail`.

All control actions eventually call the same Baileys helpers used by REST endpoints, so payload shapes mirror their REST equivalents (e.g., `chatModify`, `sendPresenceUpdate`, `sendMessage` with `react`).

### Example Payload Structure

```json
{
  "event": "message_received",
  "ts": 1732364392000,
  "session": {
    "id": "WAREST-01",
    "label": "Support Bot",
    "registry": "usr_01HF5R3Y34W8Y3S6J1X",
    "username": "support-admin"
  },
  "data": {
    "sessionId": "WAREST-01",
    "eventId": "evt_01HF5QZVQSK3T1SH4Z2RCB2DQB",
    "messageId": "3EB0EC4ED6916F3F123",
    "chatId": "6281234567890@s.whatsapp.net",
    "sender": "6281234567890@s.whatsapp.net",
    "contentType": "text",
    "message": {
      "text": "Hello from WAREST!"
    },
    "media": null,
    "tags": ["inbound"]
  }
}
```

To respond with actions (plus optional `delayMs` between each item) return JSON like:

```json
{
  "ok": true,
  "delayMs": 800,
  "actions": [
    {
      "act": "read",
      "keys": [
        {
          "remoteJid": "6281234567890@s.whatsapp.net",
          "id": "3EB0EC4ED6916F3F123",
          "fromMe": false
        }
      ]
    },
    {
      "act": "delay",
      "ms": 1200,
      "state": "composing",
      "to": "6281234567890@s.whatsapp.net"
    },
    {
      "type": "text",
      "to": "6281234567890",
      "text": "Auto-reply from webhook."
    }
  ]
}
```

## Storage, Cache, Queue, and Proxy in WAREST

- **Storage**: Choose `WAREST_STORAGE_DRIVER=local` for encrypted on-disk storage (signed URLs served from `/storages`), or `s3` for external buckets. Configure TTLs, encryption keys, and public URLs via `WAREST_STORAGE_*`.
- **Cache**: Offload repetitive lookups and metadata to Redis/Memcached/Mongo (or use local memory). Caches keep track of Baileys version negotiation, webhook rate limiting, and deduplication tokens.
- **Queue**: Outbound requests pass through a queue that enforces concurrency and guard rails. Coupled with anti-spam settings (`SPAM_COOLDOWN_MS`, `QUOTA_WINDOW_MS`) and rate limit settings (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`).
- **Proxy**: Optional HTTP/SOCKS proxies keep WhatsApp traffic resilient. Provide multiple endpoints and select strategy, stickiness, rotate-after-failure, cooloff, and jitter using `WAREST_PROXY_*`.

Each subsystem contributes to reliability: Storage ensures media availability, Cache reduces DB load, Queue smooths bursty writes, Proxy manages network resilience.

## Mapping WAREST Terminology to WhatsApp Concepts

| WAREST Term | WhatsApp Concept | Notes |
| ----------- | ---------------- | ----- |
| Session | Logged-in WhatsApp account/device pair handled by Baileys | Mirrors WA multi-device session; includes credentials and device metadata. |
| Device | Companion device (phone/browser) | Derived from WhatsApp MD; WAREST exposes via `/session/devices`. |
| Registry | WhatsApp session store | Equivalent to WhatsApp's persistent auth store; WAREST keeps it in relational DB. |
| Chat | Conversation (1:1, group, community) | Backed by `remoteJid`; operations map to WA chat actions (pin, mute, archive). |
| Message | WhatsApp message payload | Represents a WA stanza with `key.id`, `message`, `contextInfo`, etc. |
| Media Object | WhatsApp media stream | Upload/download flows follow WA media encryption/URL patterns; stored locally/S3. |
| Webhook Event | WhatsApp event feed | Baileys surfaces the same events WA clients receive; WAREST forwards them. |
| Action Runner | WhatsApp client behaviors (send/edit/read/etc.) | Executes Baileys socket helpers identical to WA client actions. |
| Phone Number | WhatsApp MSISDN | Normalized digits used to derive `@s.whatsapp.net` JIDs. |
| JID | WhatsApp ID | Standard WA addressing; same format WAREST uses in APIs + webhooks. |
| LID | WhatsApp LID | WhatsApp-specific long IDs; resolvable to JIDs via misc endpoints. |
| Chat ID | WhatsApp `remoteJid` | Used for `/chats` and webhook payloads; equals contact/group JID. |
| Message ID | WhatsApp stanza ID | Provided in `message.key.id`; required for revoke/edit/read actions. |
| Storage Driver | WhatsApp media store equivalent | Replaces WA CDN with your own local/S3 storage while keeping signed URL semantics. |
| Queue/Proxy | WhatsApp connection management | Mimic WA client throttling/proxying for stable delivery under load. |

By aligning terminology across docs, OpenAPI, and runtime logs, decoder/encoder implementations stay consistent with WhatsApp's expectations while still taking advantage of WAREST-specific infrastructure.
