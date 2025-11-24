---
outline: deep
---

# Features

WAREST consolidates every capability required to run a production-grade WhatsApp REST gateway: hardened authentication, tenant-aware session registry, end-to-end messaging coverage, group and participant tooling, webhook orchestration, and an operations stack that covers storage, compression, caching, proxying, and rate enforcement. This page lists the full feature surface so teams can map business requirements to concrete endpoints and behaviors.

## Feature Categories

### Authentication & Access

- **API Keys & Users** – Credentials seeded from `WAREST_AUTHADMIN_*` and `WAREST_ADMIN_APIKEY`, with additional users scoped to registry namespaces. Every protected endpoint accepts `X-WAREST-API-KEY` or `Authorization: Bearer`. User accounts own registry labels, ensuring tenant isolation.
- **Docs/Auth Bridge** – `/api/auth/login`, `/api/auth/session`, and `/api/auth/logout` manage the `WAREST_DOCS_SESSION` cookie so that authenticated browser sessions can browse `/docs` without exposing raw API keys.
- **Role Awareness** – Every API response brings context via `X-WAREST-Registry`, `X-WAREST-Username`, `X-WAREST-Label`, and `X-WAREST-Version`, allowing downstream services to audit who triggered an action.
- **Guards & Middleware** – The Express stack layers auth checks, rate limiting, and anti-spam cooldowns before requests hit WhatsApp sockets. Requests must pass middleware in `middleware/auth.js`, `middleware/ratelimit.js`, and `middleware/antispam.js`.
- **Endpoints** – `/api/auth/*` for login/session/logout, plus `/api/v1/*` endpoints guarded by the API key middleware.

### Server & Runtime

- **Gateway** – Express routes host the REST API, while Socket.IO powers the internal admin UI (session list, QR scanner, docs viewer). Helmet + CORS protect the surface.
- **Health & Operations** – `/api/v1/server/health`, `/ready`, `/cpu-history`, `/restart`, `/restart/scheduled`, and queue metrics expose server health, CPU trends, and lifecycle controls for SRE teams.
- **OpenAPI Docs** – `/docs` serves OpenAPI 1.3.42 with caching for `openapi.yaml`, giving developers a live API explorer gated behind auth.
- **Lifecycle & Logs** – Startup hooks initialize the database, session registry, and WhatsApp sockets. `closeRegisteredServers` ensures graceful shutdown. Pino logging keeps output structured without leaking payload secrets.
- **UI Assets** – `src/ui` bundles the login, dashboard, QR display, and docs viewer so admins can manage sessions visually without additional services.

### Sessions & Registry

- **Multi-Session Support** – Create via QR (`/api/v1/session/create`) or pair code (`/api/v1/session/create/pair-code`), list, reconnect, logout, delete, and configure per-session webhooks (URL + secret).
- **Device Management** – `/api/v1/session/devices` exposes companion metadata; admin endpoints reconnect or logout stalled devices.
- **Tenant-Aware Registry** – Sessions persist to SQLite/MySQL/PostgreSQL with owner/user metadata, labels, webhook settings, and auto-start flags. Sync routines keep worker nodes aligned.
- **Status Webhooks** – `session_status` events broadcast lifecycle changes (`create`, `connecting`, `open`, `logged_out`, `qr`, `pairing_code`, `delete`) with QR data where relevant.
- **Endpoints** – `/api/v1/session/create`, `/create/pair-code`, `/logout`, `/reconnect`, `/delete`, `/devices`, `/list`, `/session/:sessionId/config`.

### Messaging Capabilities

**Send APIs**

- Text (`/api/v1/messages/send/text`), files (multipart), binary media, audio/PTT, document, sticker, GIF, contact, location, poll, button, list, plus custom interactive flows (buttons/lists supply images, footers, quoted context).
- Media transformations: sharp-based resizing, WebP/JPEG/PNG conversions, FFmpeg transcode for audio/video/gif, and caption support.
- **Endpoints** – `/api/v1/messages/send/{text,files,media,audio,document,sticker,gif,contact,location,poll,button,list}`.

**Action APIs**

- Star/unstar, react/unreact, revoke, edit, delete, mark-as-read, mute/unmute, archive/unarchive, clear-all, pin message. Each aligns with WhatsApp capabilities exposed via Baileys.
- **Endpoints** – `/api/v1/messages/:messageId/action/{star,unstar,reaction,unreaction,revoke,edit,delete,mark-as-read}`, `/api/v1/messages/action/{mute,unmute,archive,unarchive,clear-all}`, `/api/v1/chats/:chatId/messages/:messageId/pin`.

**Webhook Actions-in-Response**

- Receivers can return `actions` (`text`, `media`, `document`, `location`, `sticker`, `vcard`, `button`, `list`, `poll`, `forward`, `raw`, `noop`) and control primitives (`delay`, `typing`, `presence`, `react`, `star`, `unstar`, `delete`, `revoke`, `edit`, `read`, `queue`, `parallel`, `when`, `retry`). The action runner renders templates, enforces optional delays, and pipes output back through the same session.

### Chats

- **Listing & Search** – `/api/v1/chats` and `/api/v1/chats/:chatId/messages` supply conversation listings and message history with pagination.
- **Chat State Controls** – Pin/unpin, mark read, mute/unmute, archive/unarchive, clear, and pin specific messages through `/api/v1/messages/action/*` and `/api/v1/chats/:chatId/messages/:messageId/pin`.
- **Mentions & Metadata** – Chat payloads normalize mentions, reaction counts, quoted contexts, and message keys, matching WhatsApp semantics.

- **Endpoints** – `/api/v1/chats`, `/api/v1/chats/:chatId/messages`, `/api/v1/messages/action/*`, `/api/v1/chats/:chatId/messages/:messageId/pin`.

### Groups & Participant Management

- **Group CRUD** – Create/delete groups, fetch info, and update subject, description, and profile picture.
- **Access & Governance** – Toggle locked/announcement modes, fetch invite links, revoke invites, or join via link.
- **Approval Workflows** – List participant requests, approve/reject pending members, and enforce moderated join flows.
- **Participant Controls** – Add/remove members, promote/demote admins, list participants, and manage group join/leaves with event webhooks (`group_participants`, `group_join`, `group_leave`, `group_update`).

- **Endpoints** – `/api/v1/groups`, `/api/v1/group/{create,delete,info}`, `/api/v1/group/name`, `/description`, `/locked`, `/announcement`, `/invite`, `/invite/revoke`, `/join-via-link`, `/participants/*`, `/picture` (get/post/delete).

### Profiles & Contacts

- **Profile Info & Business Data** – `/profile/info` and `/profile/business-profile` mirror the official WhatsApp profile metadata, enabling CRM enrichment.
- **Profile Photo & Privacy** – Get/update/delete profile photos (`/profile/picture`) and fetch privacy settings (`/profile/privacy`) to sync with compliance policies.
- Fetch/update/delete profile photos, read privacy settings, and return business profile data.
- Enumerate contact lists and check if numbers are on WhatsApp (`/profile/on-whatsapp`).
- Resolve presence info, last seen, and call events through `presence_update` and `call` webhook events.
- **Endpoints** – `/api/v1/profile/info`, `/picture` (get/post/delete), `/privacy`, `/list-contacts`, `/on-whatsapp`, `/business-profile`.

### Miscellaneous Utilities

- **Identity Utilities** – Validate/normalize phone numbers and JIDs, resolve JID/LID combos, generate/validate UUIDs.
- **Media Helpers** – Generate thumbnails or perform image operations via `/api/v1/misc/media/*`.
- **Crypto Tools** – Hashing, HMAC, and Base64 helpers to mirror WhatsApp’s signature formats.
- **QR & Poll Tools** – Convert arbitrary strings to QR (`/misc/convert-string-toqr/:target`) and update poll votes.
- **Misc Endpoints** – `/api/v1/misc/whatsapp/validate/{phone,jid}`, `/resolve/jid-or-lid`, `/uuid/{generate,validate}`, `/misc/media/{thumbnail,image}`, `/misc/crypto/{hash,hmac}`, `/misc/base64`, `/misc/convert-string-toqr/:target`, `/misc/whatsapp/poll-update-vote`.
- **UUID/QR/Poll** – Generate/validate UUIDs, convert strings to QR codes, and update poll votes via the misc endpoints listed above.

## Message Type Support

WAREST covers the entire WhatsApp payload matrix out of the box:

| Type             | REST Endpoint(s)                                      | Capabilities                                                                                                                                         |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text             | `/api/v1/messages/send/text`                          | Unicode text, markdown/emoji, mentions, quoted contexts, and templated replies.                                                                      |
| Files / Media    | `/api/v1/messages/send/files`, `/send/media`          | Binary uploads (multipart) or remote URLs; supports images, video, GIF, audio/PTT with captions, thumbnail hints, and optional sharp/FFmpeg transforms. |
| Audio / Voice    | `/api/v1/messages/send/audio`                         | Sends push-to-talk voice notes or audio clips with optional transcode and PTT flag.                                                                  |
| Documents        | `/api/v1/messages/send/document`                      | Any MIME type with custom filename, caption, and optional signature; ideal for PDFs, spreadsheets, or presentations.                                 |
| Stickers         | `/api/v1/messages/send/sticker`                       | Accepts pre-WebP sticker files or auto-converts images to WebP (512x512) via sharp.                                                                  |
| GIF              | `/api/v1/messages/send/gif`                           | Animated GIF payload with autoplay in WhatsApp clients, automatically handled via FFmpeg.                                                            |
| Contacts (vCard) | `/api/v1/messages/send/contact`                       | Multi-field contacts built as VCARD 3.0 entries; supports multiple phone numbers and metadata.                                                       |
| Location         | `/api/v1/messages/send/location`                      | Latitude/longitude plus optional name, address, and URL metadata for map pins.                                                                       |
| Polls            | `/api/v1/messages/send/poll`                          | Multi-option polls with context info; vote updates can be applied via `/misc/whatsapp/poll-update-vote`.                                            |
| Buttons          | `/api/v1/messages/send/button`                        | Interactive button templates with text, footer, image, quick replies, or call-to-action buttons.                                                     |
| Lists            | `/api/v1/messages/send/list`                          | List-style replies with sections, rows, and optional header/footer/media attachments.                                                                |
| Raw Payloads     | `/api/v1/messages/send/files` (advanced)              | Send low-level WhatsApp payloads when you need to replicate bespoke message structures (advanced/experimental).                                      |

Inbound webhook events surface the same message types (plus metadata such as mentions, reactions, and context info), ensuring symmetrical parsing between outbound sends and received payloads.

## Group & Participant Highlights

- **Lifecycle Automation** – Webhook events fire on joins/leaves, promotions/demotions, subject/announce/lock changes, enabling automated governance workflows.
- **Profile & Asset Updates** – APIs manage group avatars and descriptions, and webhooks mirror changes for synchronization in external systems.
- **Approval Queues** – Dedicated endpoints for listing and moderating join requests, with webhook notifications to escalate approvals.
- **Compliance Controls** – Lock or convert groups to announcement-only mode programmatically, mirroring WhatsApp’s admin panel.
 - **Invite Management** – Fetch, revoke, and regenerate invite links, and allow bots to join via link when permitted.
 - **Participant Moderation** – Bulk add/remove participants, promote/demote admins, and automate removals when compliance policies fail.
 - **Event Traceability** – `group_participants`, `group_join`, `group_leave`, and `group_update` events include actor/target metadata so you can audit every membership change.
 - **Emergency Actions** – `/api/v1/group/leave`, `/delete`, and participant remove endpoints enable immediate remediation for compromised chats.

## Webhook Delivery & Actions

- **Signing & Metadata** – HMAC SHA-2 signatures with timestamp, event, session, registry, label, username, and delivery attempt headers. Body includes `{ event, data, ts, session }`.
- **Retry Logic** – Configurable timeout, retry count, exponential backoff, jitter, and circuit breaking. 404/410 automatically clear stored URLs; 401/403 enter security cool-off.
- **Preflight Endpoint** – `/api/v1/webhook/preflight` validates reachability/signature acceptance before saving URLs.
- **Actions-in-Response** – Receivers execute follow-up sends or control flows inline; the action runner honors optional `delayMs` between entries and templated payloads.
- **Parallel Fan-out** – Multiple webhook URLs per session are delivered sequentially or in parallel (configurable) with circuit breakers per target.
- **Webhook Secrets & Rotation** – Each session stores its own webhook secret; `/session/:id/config` updates URLs or rotates secrets without downtime. 404/410 responses clear URLs but retain secrets for safety.
- **Event Catalog** – `session_status`, `message_received`, `message_reaction`, `message_command`, `message_edited`, `message_revoked`, `group_participants`, `group_join`, `group_leave`, `group_update`, `presence_update`, `creds_update`, and `call` keep integrations aware of every WhatsApp event surfaced by Baileys.

## Storage, Compression, and Media Handling

- **Storage Drivers** – `local` with AES-256-GCM encryption, signed URLs, TTLs, and `data/public/storages` for public assets; or `s3` with any S3-compatible backend (R2, MinIO, Wasabi) supporting SSE/KMS, path-style, and CDN overrides.
- **Compression Stack** – sharp handles images/WebP conversion; FFmpeg (system binary or `ffmpeg-static`) transcodes video, audio, and GIF payloads.
- **Signed Delivery** – Outbound webhooks can reference storage URLs with TTL-limited signatures, enabling secure media retrieval.
- **Mirroring Controls** – `WAREST_DOWNLOAD_MEDIA_RECEIVED` toggles inbound media mirroring to storage, enabling audit or analytics pipelines.
- **Public vs Private Paths** – Local storage separates `data/private/storages` (encrypted) from `data/public/storages` (served via `/storages` or CDN). S3 driver can expose `WAREST_STORAGE_S3_PUBLIC_URL` to front media through custom domains.
- **Media Metadata** – Stored objects record MIME type, byte size, and hash so webhook payloads can include safe download hints for downstream systems.
- **Shared Secrets & TTL** – `WAREST_STORAGE_SHARED_SECRET`, `WAREST_STORAGE_LOCAL_SIGNED_TTL_SEC`, and `WAREST_STORAGE_S3_SIGNED_TTL_SEC` govern signed URL lifetimes, ensuring media links expire automatically.

## Caching, Queueing, Rate Limiting, and Anti-Spam

- **Cache Drivers** – Local in-memory, Redis, Memcached, or MongoDB caches accelerate version negotiation, dedupe tokens, presence snapshots, and ephemeral metadata. Configure via `WAREST_CACHING_DRIVER` and `WAREST_CACHE_*` env vars.
- **Task Queue** – Configurable concurrency, max size, timeout, retries, jitter, and backoff per `WAREST_QUEUE_*`. Every send request flows through the queue to protect WhatsApp sockets.
- **Rate Limiters** – Dynamic per-user limits (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`) throttle HTTP calls, while `SPAM_COOLDOWN_MS` and `QUOTA_*` enforce WhatsApp-friendly pacing.
- **Proxy Pool** – Optional HTTP/SOCKS proxies with failover/round-robin/random strategies, sticky sessions, rotate-after-failures, cool-off timers, and backoff multipliers keep transport resilient.
- **Anti-Spam Queue Glue** – Rate limiters, anti-spam cooldowns, and queue backpressure are wired together so that repeated abuse gets delayed automatically rather than overwhelming the upstream WhatsApp session.
- **Observability** – Queue metrics (current size, concurrency, retries) are exposed via `/api/v1/server/*` and logs, making it easy to tune `WAREST_QUEUE_*` values.

## Additional Highlights

- **Observability** – Health endpoints, CPU history, queue stats, and logging (Pino) provide transparency for SRE teams. Structured logs avoid leaking sensitive payloads.
- **Deployment Flexibility** – Bare metal Node.js >= 22 or Docker (`docker run`, `docker compose`) with environment-driven config. Includes FFmpeg guidance and volume mappings.
- **Security Defaults** – Helmet CSP, optional AES-256-GCM storage encryption, hashed secrets, and session-specific HMAC keys keep data secure.

Use this catalog to identify the exact features your integration needs. Each entry maps directly to REST endpoints or webhook behaviors implemented in the codebase, ensuring parity between documentation and runtime behavior.
