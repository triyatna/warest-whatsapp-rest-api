<div align="center">
  <img src="/data/public/media/favicon.png" alt="WAREST logo" width="240" />
  
## WAREST - WhatsApp REST API Unofficial Build with NODEJS

</div>

[![Release](https://img.shields.io/github/v/release/triyatna/warest-whatsapp-rest-api)](#) [![Node](https://img.shields.io/badge/node-%3E%3D22-43853d)](#) [![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

WAREST is a unofficial WhatsApp REST API (multi-device, multi-session). It exposes a REST API, webhooks, and a small UI so you can automate messaging, manage sessions, and integrate WhatsApp flows into your own stack.

> WARNING: This project is **not** affiliated with WhatsApp/Facebook/Meta. Use at your own risk. Violating WhatsApp terms may lead to bans. Accounts may be rate limited or banned if abused; respect WhatsApp ToS and sender limits.

---

## Highlights

- Multi-session and multi-device with registry sync and bootstrap.
- OpenAPI v1.3.42 at `/docs` (protected by login/API key).
- Full messaging surface: text, media/files/audio/doc/sticker/GIF, contact, location, poll, button, list, plus edit/revoke/react/star/read/mute/archive/pin.
- Group management: create/delete, invite/revoke/join-link, lock/announcement, photo/name/description, admin promote/demote, participant approvals.
- Profiling and contacts: avatar, privacy reads, contact list, on-whatsapp check, business profile.
- Webhooks: HMAC (SHA-2) signing, retries with backoff+jitter, preflight verification, reply actions, optional media mirroring.
- Storage drivers: local (AES-256-GCM optional, signed URL) or S3-compatible (presign, SSE/KMS). Media compression via sharp + ffmpeg.
- Guards: rate limit, anti-spam, queue with retry/backoff, proxy pool, health/readiness endpoints.
- n8n community node available via npm `@triyatna/n8n-nodes-warest` (see n8n section).

---

## UI Screenshots

<div align="center">

![WAREST dashboard](data/public/media/ui-warest-1.png)
![Session list](data/public/media/ui-warest-2.png)
![Docs viewer](data/public/media/ui-warest-docs.png)

</div>

---

## System Requirements

- Node.js >= 22 (CLI and runtime) with npm.
- FFmpeg requirements:
  - Without Docker: install ffmpeg from your OS package manager or downloaded builds, and ensure `ffmpeg` is on PATH (preferred for performance).
  - With Docker: the image includes `ffmpeg-static` as a fallback; you can mount a faster ffmpeg binary and point `WAREST_COMPRESS_FFMPEG_PATH` to it if needed.
- Write access to `data/` (contains DB, sessions, and `data/public/storages/` for static/media when using local storage; or S3 bucket if using S3 driver).
- Database: SQLite (default), or MySQL/PostgreSQL when configured.

## Quick Start

### Basic

```bash
git clone https://github.com/triyatna/warest-whatsapp-rest-api.git
cd warest-whatsapp-rest-api
cp .env.example .env     # fill admin creds, API key, DB/storage as needed
npm install
npm run db:migrate       # run migrations
npm run dev              # development (NODE_ENV=development)

# npm run win-dev # windows use

# or
npm start                # production-style (NODE_ENV=production)
```

Access UI at `http://localhost:7308/` (adjust to your PORT). Docs live at `/docs` (requires login/API key).

---

### Docker

1. Clone this repo `git clone https://github.com/triyatna/warest-whatsapp-rest-api.git`
2. in `.env.docker` set at least `WAREST_AUTHADMIN_USERNAME`, `WAREST_AUTHADMIN_PASSWORD`, `WAREST_ADMIN_APIKEY`, DB/storage config.
3. Start (terminal/cmd at project root):

   ```bash
   docker compose up -d
   ```

   > Volume:
   >
   > - `warest_data` -> `/app/data` (DB, sessions, private/public storages, media, vendor assets)

   > Image ARG defaults: `NODE_VERSION=22-bookworm-slim`.

---

### Docker run (Production)

```bash
docker run -d \
  --name warest \
  --restart always \
  -p 7308:7308 \
  -e NODE_ENV=production \
  -e WAREST_AUTHADMIN_USERNAME=admin \
  -e WAREST_AUTHADMIN_PASSWORD=supersecret \
  -e WAREST_ADMIN_APIKEY=warest-admin-key \
  -e WAREST_BASE_URL=https://example.com \
  -e GENERIC_TIMEZONE=UTC \
  -e TZ_LOCALE=en-US \
  -v warest_data:/app/data \
  triyatna/warest-whatsapp-rest-api:latest

```

### Docker compose (Production)

using enironment variables:

```yaml
services:
  warest:
    image: triyatna/warest-whatsapp-rest-api:latest
    restart: always
    ports:
      - "7308:7308"
    environment:
      NODE_ENV: production
      WAREST_AUTHADMIN_USERNAME: admin
      WAREST_AUTHADMIN_PASSWORD: supersecret
      WAREST_ADMIN_APIKEY: warest-admin-key
      WAREST_BASE_URL: https://example.com
      GENERIC_TIMEZONE: UTC
      TZ_LOCALE: en-US
    volumes:
      - warest_data:/app/data
volumes:
  warest_data:
```

or using `.env.docker` file:

```yaml
services:
  warest:
    image: triyatna/warest-whatsapp-rest-api:latest
    restart: always
    ports:
      - "7308:7308"
    env_file:
      - .env.docker
    volumes:
      - warest_data:/app/data
volumes:
  warest_data:
```

---

### FFmpeg install quicknotes (bare metal) — recommended

- macOS: `brew install ffmpeg`
- Debian/Ubuntu: `sudo apt-get update && sudo apt-get install -y ffmpeg`
- RHEL/CentOS/Alma/Rocky: `sudo yum install -y epel-release && sudo yum install -y ffmpeg` (or `dnf` on newer)
- Windows: install via [https://www.gyan.dev/ffmpeg/builds/](https://www.gyan.dev/ffmpeg/builds/) or package managers (`choco install ffmpeg` / `scoop install ffmpeg`) and add the `bin` folder to PATH.
- Custom binary: set `WAREST_COMPRESS_FFMPEG_PATH=/path/to/ffmpeg` to force a specific executable (useful inside Docker if you mount your own build).
- Recommended: use a native/system ffmpeg for better codec support and speed; the bundled `ffmpeg-static` is a fallback and may lack some encoders/filters.

---

## Environment Variables Ready

| Variable                                   | Description                                    | Default                        | Example                                 |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------ | --------------------------------------- |
| PORT                                       | HTTP port                                      | 7308                           | 7308                                    |
| HOST                                       | Bind host                                      | 0.0.0.0                        | 127.0.0.1                               |
| ALLOWED_ORIGINS / WAREST_ALLOWED_ORIGINS   | Comma/newline list for CORS (`*` to allow all) | (auto: localhost & host:port)  | http://localhost:7308                   |
| WAREST_BASE_URL (alias: WAREST_PUBLIC_URL) | Public base URL used in docs, links, webhooks  | (empty)                        | https://api.example.com                 |
| WAREST_TIMEZONE / GENERIC_TIMEZONE         | Server timezone                                | UTC                            | Asia/Jakarta                            |
| WAREST_TZ_LOCALE / TZ_LOCALE               | Locale for date formatting                     | en-US                          | id-ID                                   |
| WAREST_DEFAULT_COUNTRY_CODE                | Phone normalization                            | 62                             | 1                                       |
| WAREST_AUTHADMIN_USERNAME                  | Seed admin username                            | (empty)                        | admin                                   |
| WAREST_AUTHADMIN_PASSWORD                  | Seed admin password                            | (empty)                        | supersecret                             |
| WAREST_ADMIN_APIKEY                        | Seed admin API key (fixed)                     | (empty)                        | warest-admin-key                        |
| WAREST_DB_CLIENT                           | sqlite, mysql, or postgres                     | sqlite                         | postgres                                |
| WAREST_DB_SQLITE_PATH                      | SQLite file path                               | data/warest.sqlite             | /data/warest.sqlite                     |
| WAREST_DB_HOST                             | DB host (MySQL/Postgres)                       | (empty)                        | db.internal                             |
| WAREST_DB_PORT                             | DB port                                        | 3306 (mysql) / 5432 (postgres) | 5432                                    |
| WAREST_DB_USER                             | DB username                                    | (empty)                        | warest                                  |
| WAREST_DB_PASSWORD                         | DB password                                    | (empty)                        | strongpass                              |
| WAREST_DB_DATABASE                         | DB name                                        | (empty)                        | warest                                  |
| WAREST_DB_POSTGRES_URL / WAREST_DB_URL     | Full Postgres URL alternative                  | (empty)                        | postgres://user:pass@host:5432/db       |
| RATE_LIMIT_WINDOW_MS                       | Rate limit window size                         | 60000                          | 60000                                   |
| RATE_LIMIT_MAX                             | Requests per window                            | 120                            | 200                                     |
| SPAM_COOLDOWN_MS                           | Anti-spam cooldown                             | 3000                           | 5000                                    |
| QUOTA_WINDOW_MS                            | Spam quota window                              | 60000                          | 60000                                   |
| QUOTA_MAX                                  | Max actions per spam window                    | 500                            | 300                                     |
| WAREST_QUEUE_CONCURRENCY                   | Queue parallelism                              | 1                              | 2                                       |
| WAREST_QUEUE_MAX_SIZE                      | Max queued tasks (empty = no limit)            | (empty)                        | 500                                     |
| WAREST_QUEUE_TIMEOUT_MS                    | Per-task timeout                               | 0 (disabled)                   | 30000                                   |
| WAREST_QUEUE_MAX_RETRIES                   | Retries after failure                          | 0                              | 3                                       |
| WAREST_QUEUE_RETRY_DELAY_MS                | Base retry delay (ms)                          | 75                             | 1200                                    |
| WAREST_QUEUE_BACKOFF_FACTOR                | Retry backoff multiplier                       | 2                              | 1.5                                     |
| WAREST_QUEUE_RETRY_JITTER                  | Retry jitter ratio (0-1)                       | 0.2                            | 0.5                                     |
| WAREST_CACHING_DRIVER                      | local, redis, memcached, mongodb               | local                          | redis                                   |
| WAREST_CACHE_REDIS_URL                     | Redis URL                                      | (empty)                        | redis://127.0.0.1:6379                  |
| WAREST_CACHE_MEMCACHED_SERVERS             | Memcached servers                              | 127.0.0.1:11211                | 10.0.0.1:11211,10.0.0.2:11211           |
| WAREST_CACHE_MONGODB_URL                   | MongoDB URL for cache                          | mongodb://127.0.0.1:27017      | mongodb://mongo:27017                   |
| WAREST_CACHE_MONGODB_DB                    | Mongo cache database                           | warest                         | cache                                   |
| WAREST_CACHE_MONGODB_COLLECTION            | Mongo cache collection                         | cacheEntries                   | cacheEntries                            |
| WAREST_STORAGE_DRIVER                      | local or s3                                    | local                          | s3                                      |
| WAREST_STORAGE_LOCAL_PATH                  | Local root path                                | data/private/storages          | /data/private/storages                  |
| WAREST_STORAGE_LOCAL_PUBLIC_URL            | Local public URL base                          | /storages                      | https://cdn.example.com/storages        |
| WAREST_STORAGE_LOCAL_ENCRYPT               | Encrypt local files by default                 | true                           | false                                   |
| WAREST_STORAGE_LOCAL_SIGNED_TTL_SEC        | Signed URL TTL (local)                         | 900                            | 600                                     |
| WAREST_STORAGE_SHARED_SECRET               | Shared secret (encryption/signed URLs)         | warest-storage-secret          | supersecret                             |
| WAREST_STORAGE_S3_BUCKET                   | S3 bucket                                      | (empty)                        | warest-media                            |
| WAREST_STORAGE_S3_REGION                   | S3 region                                      | auto                           | ap-southeast-1                          |
| WAREST_STORAGE_S3_ENDPOINT                 | Custom S3 endpoint                             | (empty)                        | https://s3.wasabisys.com                |
| WAREST_STORAGE_S3_FORCE_PATH_STYLE         | Path-style S3 requests                         | false                          | true                                    |
| WAREST_STORAGE_S3_SIGNED_TTL_SEC           | S3 presign TTL                                 | 900                            | 1800                                    |
| WAREST_STORAGE_S3_PUBLIC_URL               | CDN/override URL                               | (empty)                        | https://cdn.example.com                 |
| WAREST_DOWNLOAD_MEDIA_RECEIVED             | Mirror inbound media to storage                | true                           | false                                   |
| WAREST_MIMETYPE_FILES_ALLOWLIST            | Allowed upload MIME list                       | (wide list)                    | image/jpeg,video/mp4                    |
| MSG_JSON_LIMIT_MB                          | JSON body size for messaging                   | 1000                           | 50                                      |
| FILE_RAW_LIMIT_MB                          | Raw body size                                  | 2000                           | 500                                     |
| MEDIA_PER_FILE_MB                          | Per-media size limit                           | 1024                           | 50                                      |
| FILE_PER_FILE_MB                           | Per-file size limit                            | 2048                           | 200                                     |
| WAREST_COMPRESS_ENABLED                    | Enable media compression                       | true                           | false                                   |
| WAREST_COMPRESS_IMAGE_MAX_DIMENSION        | Max image dimension                            | 1280                           | 1080                                    |
| WAREST_COMPRESS_VIDEO_MAX_WIDTH            | Max video width                                | 720                            | 720                                     |
| WAREST_COMPRESS_VIDEO_CRF                  | Video CRF default                              | 28                             | 24                                      |
| WAREST_COMPRESS_AUDIO_BITRATE_K            | Audio bitrate                                  | 96                             | 128                                     |
| WAREST_WEBHOOK_TIMEOUT_MS                  | Webhook timeout                                | 10000                          | 7000                                    |
| WAREST_WEBHOOK_RETRIES                     | Webhook retries                                | 3                              | 5                                       |
| WAREST_WEBHOOK_BACKOFF_MS                  | Webhook backoff base                           | 800                            | 1200                                    |
| WAREST_WEBHOOK_JITTER_MS                   | Webhook jitter                                 | 300                            | 400                                     |
| WAREST_WEBHOOK_ACTIONS_DELAY_MS            | Delay for action webhooks                      | 1200                           | 1500                                    |
| WAREST_WEBHOOK_SIGNATURE_SHA2              | Hash length for signature                      | 256                            | 512                                     |
| WEBHOOK_DEFAULT_URL                        | Fallback webhook URL                           | (empty)                        | https://hooks.example.com/warest        |
| WEBHOOK_DEFAULT_SECRET                     | Fallback webhook secret                        | supersecret                    | changeme                                |
| WAREST_PROXY_URLS                          | Proxy pool (comma/newline)                     | (empty)                        | http://proxy-a:8080,http://proxy-b:8080 |
| WAREST_PROXY_STRATEGY                      | failover, round_robin, random                  | failover (or rr if >1)         | round_robin                             |
| WAREST_PROXY_STICKY_SESSION                | Stick session to proxy                         | true if proxies set            | false                                   |
| WAREST_PROXY_ROTATE_AFTER_FAILURES         | Failures before rotate                         | 2 (or 1 if single)             | 3                                       |
| WAREST_PROXY_FAILURE_COOLOFF_MS            | Cooloff before retry                           | 15000                          | 20000                                   |
| WAREST_PROXY_FAILURE_BACKOFF_MULTIPLIER    | Backoff multiplier                             | 3                              | 2                                       |
| LOG_PRETTY                                 | Pretty logging                                 | true                           | false                                   |
| LOG_LEVEL                                  | Pino log level                                 | info                           | debug                                   |
| AUTOREPLY_ENABLED                          | Auto-reply on                                  | false                          | true                                    |
| AUTOREPLY_PING_PONG                        | Respond to ping/pong                           | true                           | false                                   |

### Minimum essentials to set

- `WAREST_AUTHADMIN_USERNAME`, `WAREST_AUTHADMIN_PASSWORD`, `WAREST_ADMIN_APIKEY`
- `WAREST_DB_CLIENT`; if not using SQLite also set `WAREST_DB_HOST`, `WAREST_DB_PORT`, `WAREST_DB_USER`, `WAREST_DB_PASSWORD`, `WAREST_DB_DATABASE` (or `WAREST_DB_POSTGRES_URL` for Postgres)
- `WAREST_ALLOWED_ORIGINS` (pick this; aliases optional)
- `WAREST_STORAGE_DRIVER` (and its related paths/URLs for the chosen driver)
- `WAREST_BASE_URL` (use this; `WAREST_PUBLIC_URL` works as an alias) for absolute links/webhooks

Example `.env` (minimum essentials):

```
PORT=7308
NODE_ENV=production
GENERIC_TIMEZONE=UTC
TZ_LOCALE=en-US
NODE_ENV=production
WAREST_BASE_URL=https://api.example.com
WAREST_AUTHADMIN_USERNAME=admin
WAREST_AUTHADMIN_PASSWORD=supersecret
WAREST_ADMIN_APIKEY=warest-admin-key
WAREST_DB_CLIENT=sqlite
WAREST_DOWNLOAD_MEDIA_RECEIVED=true
```

---

## Database and Migrations

- Commands (`package.json`): `npm run db:migrate`, `npm run db:rollback`, `npm run db:rollback:all`, `npm run db:seed`, `npm run db:status`, `npm run db:make:migration`, `npm run db:make:seed`, `npm run db:ping`.
- CLI alternative: `node src/database/models/cli.js <command>`.
- Default SQLite at `data/warest.sqlite`; switch to MySQL/PostgreSQL by setting DB env vars.
- Driver requirements:
  - SQLite: `WAREST_DB_CLIENT=sqlite` (no other DB env needed).
  - MySQL: `WAREST_DB_CLIENT=mysql` and set `WAREST_DB_HOST`, `WAREST_DB_PORT`, `WAREST_DB_USER`, `WAREST_DB_PASSWORD`, `WAREST_DB_DATABASE`.
  - PostgreSQL: either `WAREST_DB_POSTGRES_URL` (preferred) or `WAREST_DB_CLIENT=postgres` plus `WAREST_DB_HOST`, `WAREST_DB_PORT`, `WAREST_DB_USER`, `WAREST_DB_PASSWORD`, `WAREST_DB_DATABASE`.
- Always rerun migrations after changing DB targets.

---

## Authentication Model

- Most endpoints require an API key: `X-WAREST-API-KEY: <key>` or `Authorization: Bearer <key>`.
- Obtain key: `POST /api/auth/login` with `{ "username": "...", "password": "..." }`.
  - Admin seeded from env keeps the env API key (hash stored in DB).
  - Non-admin logins rotate API keys on each login.
- Docs/UI at `/docs` use cookie `WAREST_DOCS_SESSION` after login. You can sync a key with `POST /api/auth/session`.
- Rate limit and anti-spam apply globally; tune via env.

Example login:

```bash
curl -X POST http://localhost:7308/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"supersecret"}'
```

---

## API Catalog (single table)

| Category           | Feature                       | Method   | URL                                             | Status |
| ------------------ | ----------------------------- | -------- | ----------------------------------------------- | ------ |
| Auth               | Login                         | POST     | /api/auth/login                                 | ✅     |
| Auth               | Logout (clear docs cookie)    | POST     | /api/auth/logout                                | ✅     |
| Auth               | Sync docs cookie with API key | POST     | /api/auth/session                               | ✅     |
| Server             | Ping                          | GET      | /api/v1/server/ping                             | ✅     |
| Server             | Info                          | GET      | /api/v1/server/info                             | ✅     |
| Server             | Health                        | GET      | /api/v1/server/healthz                          | ✅     |
| Server             | Ready                         | GET      | /api/v1/server/ready                            | ✅     |
| Server             | CPU history                   | GET      | /api/v1/server/cpu-history                      | ✅     |
| Server             | Restart now                   | POST     | /api/v1/server/restart                          | ✅     |
| Server             | Schedule restart              | POST     | /api/v1/server/restart/scheduled                | ✅     |
| Sessions           | Create session                | GET      | /api/v1/session/create                          | ✅     |
| Sessions           | Create via pair code          | GET      | /api/v1/session/create/pair-code                | ✅     |
| Sessions           | Logout session                | GET      | /api/v1/session/logout                          | ✅     |
| Sessions           | Reconnect session             | GET      | /api/v1/session/reconnect                       | ✅     |
| Sessions           | Devices                       | GET      | /api/v1/session/devices                         | ✅     |
| Sessions           | List sessions                 | GET      | /api/v1/session/list                            | ✅     |
| Sessions           | Delete session                | DELETE   | /api/v1/session/delete                          | ✅     |
| Sessions           | Configure webhook/secret      | POST     | /api/v1/session/:sessionId/config               | ✅     |
| Messages (send)    | Send text                     | POST     | /api/v1/messages/send/text                      | ✅     |
| Messages (send)    | Send files (multipart)        | POST     | /api/v1/messages/send/files                     | ✅     |
| Messages (send)    | Send media                    | POST     | /api/v1/messages/send/media                     | ✅     |
| Messages (send)    | Send audio                    | POST     | /api/v1/messages/send/audio                     | ✅     |
| Messages (send)    | Send document                 | POST     | /api/v1/messages/send/document                  | ✅     |
| Messages (send)    | Send sticker                  | POST     | /api/v1/messages/send/sticker                   | ✅     |
| Messages (send)    | Send GIF                      | POST     | /api/v1/messages/send/gif                       | ✅     |
| Messages (send)    | Send contact                  | POST     | /api/v1/messages/send/contact                   | ✅     |
| Messages (send)    | Send location                 | POST     | /api/v1/messages/send/location                  | ✅     |
| Messages (send)    | Send poll                     | POST     | /api/v1/messages/send/poll                      | ✅     |
| Messages (send)    | Send button message           | POST     | /api/v1/messages/send/button                    | ✅     |
| Messages (send)    | Send list message             | POST     | /api/v1/messages/send/list                      | ✅     |
| Messages (actions) | Star message                  | POST     | /api/v1/messages/:messageId/action/star         | ✅     |
| Messages (actions) | Unstar message                | POST     | /api/v1/messages/:messageId/action/unstar       | ✅     |
| Messages (actions) | React to message              | POST     | /api/v1/messages/:messageId/action/reaction     | ✅     |
| Messages (actions) | Remove reaction               | POST     | /api/v1/messages/:messageId/action/unreaction   | ✅     |
| Messages (actions) | Revoke message                | POST     | /api/v1/messages/:messageId/action/revoke       | ✅     |
| Messages (actions) | Edit message                  | POST     | /api/v1/messages/:messageId/action/edit         | ✅     |
| Messages (actions) | Delete message                | DELETE   | /api/v1/messages/:messageId/action/delete       | ✅     |
| Messages (actions) | Mark as read                  | POST     | /api/v1/messages/:messageId/action/mark-as-read | ✅     |
| Messages (actions) | Mute chat                     | POST     | /api/v1/messages/action/mute                    | ✅     |
| Messages (actions) | Unmute chat                   | POST     | /api/v1/messages/action/unmute                  | ✅     |
| Messages (actions) | Archive chat                  | POST     | /api/v1/messages/action/archive                 | ✅     |
| Messages (actions) | Unarchive chat                | POST     | /api/v1/messages/action/unarchive               | ✅     |
| Messages (actions) | Clear all chats               | DELETE   | /api/v1/messages/action/clear-all               | ✅     |
| Messages (actions) | Pin chat message              | POST     | /api/v1/chats/:chatId/messages/:messageId/pin   | ✅     |
| Chats              | List chats                    | GET      | /api/v1/chats                                   | ✅     |
| Chats              | List chat messages            | GET      | /api/v1/chats/:chatId/messages                  | ✅     |
| Chats              | Mark chat read                | POST     | /api/v1/chats/:chatId/read                      | ✅     |
| Chats              | Pin chat                      | POST     | /api/v1/chats/:chatId/pin                       | ✅     |
| Groups             | List groups                   | GET      | /api/v1/groups                                  | ✅     |
| Groups             | Group picture (get)           | GET      | /api/v1/group/picture                           | ✅     |
| Groups             | Group picture (update)        | POST     | /api/v1/group/picture                           | ✅     |
| Groups             | Group picture (delete)        | DELETE   | /api/v1/group/picture                           | ✅     |
| Groups             | Update group name             | POST     | /api/v1/group/name                              | ✅     |
| Groups             | Update description            | POST     | /api/v1/group/description                       | ✅     |
| Groups             | Lock/unlock                   | POST     | /api/v1/group/locked                            | ✅     |
| Groups             | Announcement toggle           | POST     | /api/v1/group/announcement                      | ✅     |
| Groups             | Invite link                   | GET      | /api/v1/group/invite                            | ✅     |
| Groups             | Revoke invite                 | POST     | /api/v1/group/invite/revoke                     | ✅     |
| Groups             | Join via link                 | GET/POST | /api/v1/group/join-via-link                     | ✅     |
| Groups             | Participant requests          | GET      | /api/v1/group/participants/requests             | ✅     |
| Groups             | Approve request               | POST     | /api/v1/group/participants/request/approve      | ✅     |
| Groups             | Reject request                | POST     | /api/v1/group/participants/request/reject       | ✅     |
| Groups             | Leave group                   | POST     | /api/v1/group/leave                             | ✅     |
| Groups             | Create group                  | POST     | /api/v1/group/create                            | ✅     |
| Groups             | Delete group                  | DELETE   | /api/v1/group/delete                            | ✅     |
| Groups             | List participants             | GET      | /api/v1/group/participants                      | ✅     |
| Groups             | Add participants              | POST     | /api/v1/group/participants/add                  | ✅     |
| Groups             | Remove participants           | DELETE   | /api/v1/group/participants/remove               | ✅     |
| Groups             | Promote participants          | POST     | /api/v1/group/participants/promote              | ✅     |
| Groups             | Demote participants           | POST     | /api/v1/group/participants/demote               | ✅     |
| Groups             | Group info                    | GET      | /api/v1/group/info                              | ✅     |
| Profiles           | Profile info                  | GET      | /api/v1/profile/info                            | ✅     |
| Profiles           | Profile picture get           | GET      | /api/v1/profile/picture                         | ✅     |
| Profiles           | Profile picture update        | POST     | /api/v1/profile/picture                         | ✅     |
| Profiles           | Profile picture delete        | DELETE   | /api/v1/profile/picture                         | ✅     |
| Profiles           | Privacy info                  | GET      | /api/v1/profile/privacy                         | ✅     |
| Profiles           | List contacts                 | GET      | /api/v1/profile/list-contacts                   | ✅     |
| Profiles           | Check on WhatsApp             | GET      | /api/v1/profile/on-whatsapp                     | ✅     |
| Profiles           | Business profile              | GET      | /api/v1/profile/business-profile                | ✅     |
| Misc               | Convert string to QR          | POST     | /api/v1/misc/convert-string-toqr/:target        | ✅     |
| Misc               | WhatsApp file decrypt         | POST     | /api/v1/misc/whatsapp/file-decrypt              | ✅     |
| Misc               | Poll vote update              | POST     | /api/v1/misc/whatsapp/poll-update-vote          | ✅     |
| Misc               | Validate phone                | POST     | /api/v1/misc/whatsapp/validate/phone            | ✅     |
| Misc               | Validate JID                  | POST     | /api/v1/misc/whatsapp/validate/jid              | ✅     |
| Misc               | Resolve JID or LID            | POST     | /api/v1/misc/whatsapp/resolve/jid-or-lid        | ✅     |
| Misc               | Media thumbnail               | POST     | /api/v1/misc/media/thumbnail                    | ✅     |
| Misc               | Media image utilities         | POST     | /api/v1/misc/media/image                        | ✅     |
| Misc               | UUID generate                 | POST     | /api/v1/misc/uuid/generate                      | ✅     |
| Misc               | UUID validate                 | POST     | /api/v1/misc/uuid/validate                      | ✅     |
| Misc               | Crypto hash                   | POST     | /api/v1/misc/crypto/hash                        | ✅     |
| Misc               | Crypto HMAC                   | POST     | /api/v1/misc/crypto/hmac                        | ✅     |
| Misc               | Base64 helper                 | POST     | /api/v1/misc/base64                             | ✅     |

---

## Webhook Delivery

- Configure per session via UI or `POST /api/v1/session/:sessionId/config` (body `{ webhookUrl?, webhookSecret?, preflightVerify? }`). Falls back to `WEBHOOK_DEFAULT_URL` and `WEBHOOK_DEFAULT_SECRET` when missing.
- Security: HMAC over raw JSON body with headers `X-WAREST-Signature: HMAC-SHAxxx=<hex>`, `X-WAREST-Signature-Alg`, `X-WAREST-Timestamp`, `X-WAREST-Event`, `X-WAREST-Event-Id`, `X-WAREST-Session`, `X-WAREST-Registry`, `X-WAREST-Username`, `X-WAREST-Version`. Key = `secret + username`.
- Reliability: `WAREST_WEBHOOK_TIMEOUT_MS`, `WAREST_WEBHOOK_RETRIES`, `WAREST_WEBHOOK_BACKOFF_MS`, `WAREST_WEBHOOK_JITTER_MS`, `WAREST_WEBHOOK_PREFLIGHT_TIMEOUT_MS`, optional parallel fan-out.
- Circuit rules: 401/403 treated as signature failure (longer pause); 404/410 clears URL (secret kept/regenerated).
- Actions-in-response: webhook receivers can return actions to execute for the session (e.g., reply messages, mark read, mute/chat actions, media sends). Include `"actions": [...]` in your webhook HTTP response to trigger follow-up operations for the same session.
- Media mirroring: with `WAREST_DOWNLOAD_MEDIA_RECEIVED=true`, inbound media is streamed to the configured storage driver; payload URLs point to storage. Set `WAREST_PUBLIC_URL` or storage public URL.
- Example receivers: see `examples/webhook-receivers/` for Node (Express), Python (Flask), Go, PHP, and Ruby Sinatra minimal handlers that verify signatures and return actions.

### Webhook Event Catalog

| Event tag                    | When it fires                                                                                                          | Key payload fields                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `session_status`             | Session lifecycle change: `create`, `delete`, `connecting`, `open`, `reconnecting`, `logged_out`, `qr`, `pairing_code` | `data.tags`, optional `qr` + `qrDuration`, `me` (self JID)                                                                     |
| `message_received`           | Incoming message (text, extended_text, etc.)                                                                           | `data.tags`, `contentType`, `sender`, `message` key, optional `media` (mirrored URL + storage metadata), normalized `mentions` |
| `message_reaction`           | Reaction added/removed                                                                                                 | `reaction` details, message key                                                                                                |
| `message_command`            | Registered command was matched                                                                                         | Command payload + sender/message context                                                                                       |
| `message_edited`             | Message edit detected                                                                                                  | Edited message payload with normalized mentions                                                                                |
| `message_revoked`            | Message revoked/deleted for everyone                                                                                   | Message key + revoke metadata                                                                                                  |
| `group_participants`         | Add/remove/promote/demote participants                                                                                 | Action type, participants, group JID                                                                                           |
| `group_join` / `group_leave` | Join/leave events (mirrors add/remove)                                                                                 | Participant JIDs, inviter (if any), group JID                                                                                  |
| `group_update`               | Group settings changed (subject, announce, restrict, description, picture)                                             | Changed fields + group JID                                                                                                     |
| `presence_update`            | Contact presence changed                                                                                               | Contact id, presence state, optional lastSeen                                                                                  |
| `creds_update`               | Credentials refreshed/updated                                                                                          | Minimal fields indicating updated auth/keys                                                                                    |
| `call`                       | Incoming/outgoing call event                                                                                           | Call id, from, isVideo, isGroup, timestamp                                                                                     |

---

## Media, Storage, Compression

- Storage drivers
- `local`: AES-256-GCM optional, signed URLs, configurable path/url. Defaults: private at `data/private/storages`, public at `data/public/storages`.
  - `s3`: S3/MinIO/R2/etc with presigned URLs, ACL, SSE/KMS, custom endpoint, path-style toggle, accelerate toggle, CDN override.
- Compression (`config.compress`): sharp for images; ffmpeg for video/GIF/audio. Adaptive thresholds for min bytes/savings, max dimension/width, quality/CRF, bitrate, WebP toggle, preserve-original options. Disable with `WAREST_COMPRESS_ENABLED=false` or override per request.
- Upload limits: high defaults; tune with `MSG_JSON_LIMIT_MB`, `MEDIA_PER_FILE_MB`, `FILE_PER_FILE_MB`, `FILE_RAW_LIMIT_MB`, `UPLOAD_FETCH_TIMEOUT_MS`.
- MIME allowlist: `WAREST_MIMETYPE_FILES_ALLOWLIST` and `WAREST_DOWNLOAD_MEDIA_ALLOW_MIMETYPES`.

---

## Caching, Queueing, Proxy

- Cache drivers (set `WAREST_CACHING_DRIVER`):
  - `local`: in-memory (no extra env).
  - `redis`: set `WAREST_CACHE_REDIS_URL` (or host/port/user/password), `WAREST_CACHE_REDIS_TLS` if needed.
  - `memcached`: set `WAREST_CACHE_MEMCACHED_SERVERS` and optional username/password.
  - `mongodb`: set `WAREST_CACHE_MONGODB_URL`, `WAREST_CACHE_MONGODB_DB`, `WAREST_CACHE_MONGODB_COLLECTION`.
- Queue: backpressure with concurrency, max queue size, timeout, retries, backoff, jitter (all via `WAREST_QUEUE_*`). Tasks run FIFO with AbortSignal on timeout and exponential backoff on retries.
- Proxy: supply endpoints in `WAREST_PROXY_URLS`; strategy `failover`/`round_robin`/`random`; sticky session optional; rotates after configured failure threshold with cooldown/backoff (`WAREST_PROXY_*`).

---

## Operational Notes and Security

- Default CORS allows localhost/host:port; set `ALLOWED_ORIGINS` or `WAREST_ALLOWED_ORIGINS` for production.
- Helmet CSP pre-configured for UI/docs assets and WhatsApp/OpenStreetMap domains.
- Graceful shutdown hooks on SIGINT/SIGTERM via `closeRegisteredServers`.
- Logging: Pino (`LOG_PRETTY`, `LOG_LEVEL`). Avoid logging secrets in production.
- Persist `data/` (covers DB, sessions, public/private storages) or use external DB/S3 in deployments.

---

## n8n Community Node

Published as: [`@triyatna/n8n-nodes-warest`](https://www.npmjs.com/package/@triyatna/n8n-nodes-warest)  
Source repo: https://github.com/triyatna/n8n-nodes-warest

Usage (n8n):

- Install the package in your n8n instance (UI: Settings -> Community Nodes -> Install, or `npm install @triyatna/n8n-nodes-warest` in the n8n directory).
- Configure credentials using your WARest API key.
- Available nodes include the API node and trigger variants wired to WARest endpoints; they use the same authentication and base URL as documented above.

---

## Changelog Snapshot (0.3.41)

- Base image upgraded to Node 22.
- OpenAPI 1.3.42 shipped to `/docs`.
- Registry sync and session bootstrap hardening.
- Local and S3 storage drivers with encryption and signed URLs; media mirroring toggle.
- Multi-backend caching (local/Redis/Memcached/MongoDB).
- Queue with retry/backoff/jitter; anti-spam and rate-limit improvements.
- Extended message actions (edit/revoke/react/pin) and group controls.
- Webhook preflight and configurable SHA-2 signature length.

---

## License

MIT - see [LICENSE](LICENSE).
