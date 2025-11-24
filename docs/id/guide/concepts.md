---
outline: deep
---

# Konsep & Terminologi Kunci

Bagian ini menginventarisasi seluruh istilah inti yang muncul di WAREST: sesi, pengguna & API key, perangkat, registri, chat, pesan, objek media, webhook, storage/cache/queue/proxy, format identifier (nomor telepon, JID/LID, ID pesan, API key), katalog event & aksi webhook, sampai pemetaan istilah terhadap konsep WhatsApp asli. Jadikan ini referensi kosakata resmi agar integrasi, UI, dan otomasi berbicara dalam bahasa yang sama dengan platform. Semua definisi mengikuti implementasi di [README](../../../README.md) dan skema OpenAPI yang merender `/docs`.

## Definisi

### Sesi

Satu sesi mewakili akun WhatsApp terautentikasi yang dikendalikan WAREST. Di dalamnya tersimpan kredensial Baileys, konfigurasi webhook, preferensi storage, assignment proxy, serta flag runtime seperti override antrean atau toggle auto-reply. Sesi dapat dibuat lewat `/api/v1/session/create` (QR) atau `/api/v1/session/create/pair-code`, muncul di registri, dan mengirim webhook `session_status` kapan pun siklus hidupnya berubah (connecting, open, reconnecting, logged_out, delete, dsb.).

### Pengguna & API Key

WAREST membawa user admin bawaan dari `WAREST_AUTHADMIN_USERNAME`/`WAREST_AUTHADMIN_PASSWORD` dan API key admin (`WAREST_ADMIN_APIKEY`). Anda bisa menambah pengguna lewat UI atau seed database. API key wajib untuk akses REST, lihat dokumentasi (cookie `WAREST_DOCS_SESSION`), dan otomasi CLI. Setiap pengguna dapat memiliki namespace registri sendiri sehingga sesi dapat di-scope per tenant.

### Perangkat

Dalam konteks multi-device WhatsApp, perangkat adalah companion (telepon, browser, atau klien tertanam) yang terikat pada sesi. WAREST menampilkan perangkat berpasangan melalui `/api/v1/session/devices` dan dapat menyambung ulang atau logout perangkat tertentu. Metadata perangkat mencakup platform, waktu terakhir terlihat, dan proxy yang diterapkan untuk sesi tersebut.

### Registri

Registri sesi adalah penyimpanan otoritatif yang menjaga kredensial terserialisasi dan metadata tiap sesi dalam SQLite/MySQL/PostgreSQL. Di sana tersimpan `ownerId` (user/tenant), `label`, URL/secret webhook, preferensi storage, dan flag lainnya. Saat WAREST menyala, ia memuat registri, melakukan bootstrap sesi aktif, dan menjaga sinkronisasi agar worker atau replika Docker tidak bertabrakan. Setiap operasi CRUD sesi akan memutakhirkan registri melalui `sessionRegistry.js`.

### Chat

Chat menggambarkan percakapan WhatsApp (1:1, grup, atau komunitas) yang diekspos lewat `/api/v1/chats` dan `/api/v1/chats/:chatId/messages`. ID chat selalu mengikuti JID WhatsApp (`<nomor>@s.whatsapp.net` atau `<group>@g.us`). Operasi chat (pin, tandai baca, arsip, mute) dipetakan langsung ke state chat WhatsApp.

### Pesan

Pesan adalah payload WhatsApp yang berisi konten, media, metadata (ID pesan, timestamp, mention, context info). Endpoint kirim berada di `/api/v1/messages/send/*`, sedangkan aksi pesan (star, unstar, react, revoke, edit, delete) berada di `/api/v1/messages/:messageId/action/*`. Pesan masuk menghasilkan event webhook `message_received`, `message_reaction`, `message_command`, `message_edited`, atau `message_revoked`.

### Objek Media

Objek media adalah lampiran (gambar, video, audio, dokumen, stiker, GIF, kontak, file lokasi) yang diproses melalui WAREST. Media dikompresi memakai sharp/FFmpeg dan dipersistenkan menggunakan driver storage yang dipilih. Metadata mencakup tipe MIME, ukuran file, signed URL (untuk storage lokal), dan URL pra-tanda tangan S3 saat memakai bucket eksternal.

### Webhook

Webhook adalah callback HTTP bertanda tangan yang memberi tahu sistem downstream mengenai status sesi, pesan, event grup, presence, atau pembaruan panggilan. Setiap sesi dapat menimpa URL/secret webhook atau kembali ke `WEBHOOK_DEFAULT_URL`/`WEBHOOK_DEFAULT_SECRET`. WAREST menandatangani body menggunakan HMAC SHA-2 dan mengirim header `X-WAREST-*` agar penerima dapat memverifikasi autentikasi.

### Webhook Preflight

Endpoint preflight (`POST /api/v1/webhook/preflight`) menjalankan uji kirim ringan menggunakan URL/secret yang dikonfigurasi. Server mengirim payload minimal dengan header `X-WAREST-Preflight: 1` agar penerima bisa memastikan verifikasi signature sebelum event produksi mengalir. Jika preflight gagal, URL tidak akan disimpan sampai perbaikan dilakukan.

### Action Runner

Saat penerima webhook mengembalikan `actions`, WAREST mengeksekusinya lewat action runner di `src/services/webhook.js`. Runner ini mendukung aksi kirim (`text`, `media`, `document`, `location`, `sticker`, `vcard`, `button`, `list`, `poll`, `forward`, `raw`, `noop`) dan aksi kontrol/flow (`delay`, `typing`, `presence`, `react`, `star`, `unstar`, `delete`, `revoke`, `edit`, `read`, `queue`, `parallel`, `when`, `retry`). Tiap aksi pada akhirnya memanggil helper socket Baileys, jadi payload harus menyertakan kunci yang sama seperti permintaan REST (mis. `to`, `jid`, `key`, `message`).

### Driver Storage

Driver storage menangani persistensi biner untuk media dan aset statis. Dua driver berikut tersedia:

- `local` -- menyimpan blob terenkripsi di bawah `data/private/storages` (serta file publik di `data/public/storages`). Mendukung AES-256-GCM, signed URL, dan konfigurasi TTL.
- `s3` -- terintegrasi dengan layanan kompatibel S3 (AWS S3, MinIO, R2) dan menghasilkan URL pra-tanda tangan, SSE/KMS opsional, toggle path-style, dan override CDN.

### Cache

Caching mempercepat deduplikasi dan lookup metadata. Driver yang tersedia: `local` (in-memory), `redis`, `memcached`, dan `mongodb`. Setiap driver dikonfigurasi melalui variabel `WAREST_CACHE_*`. Entri cache mendukung fitur seperti negosiasi versi, throttle tanda tangan, dan metadata sesi.

### Antrean

WAREST menyertakan antrean tugas terjaga yang membungkus rate limiting, retry dengan backoff, cooldown anti-spam, serta kendali concurrency untuk pengiriman keluar. Parameter antrean mencakup `WAREST_QUEUE_CONCURRENCY`, `WAREST_QUEUE_MAX_SIZE`, `WAREST_QUEUE_TIMEOUT_MS`, serta pengaturan retry/backoff/jitter. Setiap panggilan send melewati antrean sebelum mencapai transport Baileys.

### Guard & Middleware

Rate limiting dinamis (`RATE_LIMIT_*`), cooldown anti-spam (`SPAM_COOLDOWN_MS`, `QUOTA_*`), pengecekan auth, dan kuota per sesi memastikan setiap permintaan adil sebelum masuk ke logika bisnis. Guard ini dievaluasi per pengguna/API key dan terintegrasi dengan antrean untuk menolak atau menunda trafik yang dianggap abusive.

### Pool Proxy

Pool proxy membantu mengarahkan trafik keluar melalui proxy HTTP/SOCKS untuk menghindari throttling IP atau memenuhi kebijakan jaringan perusahaan. Konfigurasi proxy melalui `WAREST_PROXY_URLS` dan atur strateginya (`failover`, `round_robin`, atau `random`). Parameter tambahan mengatur sticky session, ambang kegagalan, cooldown, dan multiplier backoff.

### Endpoint Observabilitas

`/api/v1/server/*` mengekspos readiness/health, riwayat CPU, kontrol restart, serta metrik antrean sehingga Anda dapat mengukur kesehatan node. Endpoint ini memasok data untuk dasbor atau aturan alerting.

## Identifier

| Identifier | Deskripsi | Contoh |
| ---------- | --------- | ------ |
| **Session ID** | String mirip UUID yang ditetapkan WAREST saat sesi dibuat (juga digunakan sebagai `:sessionId` di route REST). | `b1a6191b-bc1d-4a08-9097-46b392e77bd0` |
| **Device ID** | Identifier unik WhatsApp/MD untuk perangkat pasangan (muncul melalui `/session/devices`). | `4C6E21F0B3EB4F0D8B` |
| **Phone Number** | Masukan dari klien untuk mengidentifikasi tujuan (angka saja). Dinormalisasi WAREST memakai `WAREST_DEFAULT_COUNTRY_CODE` sebelum dikonversi ke JID/LID. | `6281234567890` |
| **JID (Jabber/WhatsApp ID)** | Identifier kanonik WhatsApp untuk kontak/chat (`<digit>@s.whatsapp.net`, `<group>@g.us`, `<business>@c.us`). Wajib pada Baileys untuk target kirim dan payload webhook. Validasi lewat `/api/v1/misc/whatsapp/validate/jid`. | `6281234567890@s.whatsapp.net` |
| **LID (Long ID)** | Namespace angka khusus WhatsApp untuk beban kerja bisnis/marketing. Konversikan ke JID via `/api/v1/misc/whatsapp/resolve/jid-or-lid`. | `16501234567890123` |
| **Chat ID** | Alias untuk JID saat merujuk route chat; mencakup grup dan sub-chat komunitas. | `120363025386030504@g.us` |
| **Message ID** | Key pesan WhatsApp unik (status: `fromMe`, `id`, `remoteJid`). Dikirim ke endpoint aksi dan disertakan di payload webhook. | `3EB0EC4ED6916F3F123` |
| **Webhook Event ID** | UUID per event untuk mendukung idempoten dan deduplikasi di sisi penerima (`X-WAREST-Event-Id`). | `evt_01HF5QZVQSK3T1SH4Z2RCB2DQB` |
| **Delivery Attempt** | Penghitung retry webhook (`X-WAREST-Delivery-Attempt`). | `3` |
| **Admin API Key** | Nilai `WAREST_ADMIN_APIKEY` atau key pengguna yang tersimpan di DB, dipakai pada `Authorization: Bearer` atau `X-WAREST-API-Key`. | `warest-admin-key` |
| **Registry ID** | Identifier user/tenant yang dilekatkan ke setiap sesi (`ownerId`). Muncul di header `X-WAREST-Registry`. | `usr_01HF5R3Y34W8Y3S6J1X` |
| **Session Label** | Label ramah manusia yang disimpan bersama sesi. Ikut dikirim lewat `X-WAREST-Label`. | `support-bot` |
| **Webhook Secret** | Secret HMAC per sesi yang disimpan di registri. Digabung dengan username saat hashing payload. | `rQYrmT5h3vP2` |
| **Storage Object Key** | Path yang dihasilkan driver storage (path lokal atau key S3). Signed URL menyematkan key ini. | `sessions/WAREST-01/media/2024/11/24/abc12345.webp` |

## Event Webhook, Aksi, dan Payload

WAREST memancarkan event webhook tiap kali ada aktivitas penting. Properti utama:

- **Header**: `X-WAREST-Signature`, `X-WAREST-Signature-Alg`, `X-WAREST-Timestamp`, `X-WAREST-Event`, `X-WAREST-Event-Id`, `X-WAREST-Session`, `X-WAREST-Registry`, `X-WAREST-Label`, `X-WAREST-Username`, `X-WAREST-Version`, `X-WAREST-Delivery-Attempt`.
- **Body**: `event` (string), `data` (payload event), `ts` (epoch millis), `session` (objek berisi `id`, `label`, `registry`, `username`), serta bidang spesifik event seperti `messageId`, `chatId`, `tags`.
- **Penandatanganan**: `HMAC-SHAxxx` (panjang dapat diatur) dihitung atas body JSON mentah dengan key = `secret + username`.
- **Retry**: Diatur oleh `WAREST_WEBHOOK_RETRIES`, `WAREST_WEBHOOK_BACKOFF_MS`, `WAREST_WEBHOOK_JITTER_MS`. Respons 401/403 menunda lebih lama; 404/410 akan mengosongkan URL.
- **Aksi di Respons**: Penerima dapat merespons `{ "actions": [...] }` untuk menginstruksikan WAREST mengirim balasan, menandai baca, mute chat, dan sebagainya.

### Katalog Event

| Event | Tujuan | Sorotan Payload |
| ----- | ------ | ---------------- |
| `session_status` | Perubahan lifecycle sesi (create/open/reconnecting/logged_out/qr/pairing_code/delete). | `data.tags`, `qr`, `qrDuration`, `me` (self JID). |
| `message_received` | Pesan masuk tipe apa pun. | `contentType`, `message`, `media` (signed URL + metadata), `sender`, mention ter-normalisasi. |
| `message_reaction` | Reaksi ditambahkan/dihapus. | `reaction`, `message key`. |
| `message_command` | Command terdaftar dipicu. | Payload command + konteks chat. |
| `message_edited` / `message_revoked` | Edit atau revoke terdeteksi. | Metadata pesan sebelumnya dan delta. |
| `group_participants`, `group_join`, `group_leave`, `group_update` | Event lifecycle grup (add/remove/promote/demote, join/leave, perubahan subjek/pengumuman). | Participant JID, admin, group JID, pengaturan baru. |
| `presence_update` | Perubahan presence kontak. | Contact JID, state presence, opsional `lastSeen`. |
| `creds_update` | Pembaruan kredensial (Baileys). | Field minimal untuk dipersistenkan atau diaudit. |
| `call` | Panggilan masuk/keluar. | Call ID, from, `isVideo`, `isGroup`, timestamp. |

### Jenis Aksi

**Aksi kirim (`type`) yang diterima `runAction`:**

- `text` - mengirim teks polos dengan opsi `mentions`, `quoted`, dan `options` seperti di Baileys.
- `media` - `mediaType` (`image`, `video`, `gif`, `audio`) plus sumber `url`. Dukung `transform.sharp` untuk resize/WebP/JPEG/PNG dan `transcode` (FFmpeg), serta `caption`.
- `document` - mengirim dokumen dari `url` dengan `filename`/`caption` opsional. MIME diambil dari respon HTTP atau ekstensi file.
- `location` - memerlukan `lat`, `lng`, opsional `name` dan `address`.
- `sticker` - `webpUrl` atau `imageUrl`; non-WebP otomatis diubah ke WebP 512x512.
- `vcard` - membentuk VCARD dari payload `contact` (`fullName`, `org`, `phone`, `email`).
- `button` - pesan tombol interaktif; bisa kirim `message` siap pakai atau definisikan `buttons`, `text`, `footer`, `image`, `quoted`.
- `list` - pesan daftar interaktif memakai `list`/`lists` atau `sections` + `buttonText`.
- `poll` - kirim objek hasil `/api/v1/messages/send/poll`.
- `forward` - meneruskan pesan yang ada dengan menyertakan `message`.
- `raw` - payload Baileys mentah untuk kasus lanjut.
- `noop` - tidak melakukan apa pun (berguna untuk percabangan).

**Aksi kontrol/flow di `runControlAction`:**

- `delay` - tidur selama `ms`/`seconds`; bisa menambah `state` (`composing`, `recording`) + `to` untuk emisi presence sebelum/sesudah.
- `typing` - shortcut untuk presence `composing` selama `ms`.
- `presence` - set status presence (`available`, `unavailable`, dst.) global atau per chat.
- `react` - kirim reaksi emoji; membutuhkan `key` dan opsional `to`.
- `star` / `unstar` - toggle bintang pada `key` (memperhatikan `fromMe`).
- `delete` - hapus pesan di perangkat saat ini, opsi `deleteMedia`.
- `revoke` - hapus untuk semua orang (`delete`) plus opsi hapus lokal via `deleteForMe`.
- `edit` - ganti isi pesan; perlu `key` dan `text`/`message` baru.
- `read` - tandai pesan terbaca; terima satu `key` atau array `keys`.
- `queue` - jalankan `items` berurutan dengan `delayMs` per langkah.
- `parallel` - jalankan `items` secara paralel.
- `when` - percabangan berbasis `cond`; nilai truthy menjalankan `then`, sisanya `else`.
- `retry` - ulangi `item` sampai `attempts` dengan `delayMs`/`backoffMs`, lalu bisa menjalankan `onFail`.

Semua aksi ini memanggil helper Baileys yang sama dengan endpoint REST sehingga struktur payload harus serupa (mis. `chatModify`, `sendPresenceUpdate`, `sendMessage` dengan `react`).

### Contoh Struktur Payload

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
      "text": "Halo dari WAREST!"
    },
    "media": null,
    "tags": ["inbound"]
  }
}
```

Untuk merespons dengan aksi:

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
      "text": "Balasan otomatis dari webhook."
    }
  ]
}
```

## Storage, Cache, Antrean, dan Proxy di WAREST

- **Storage**: Pilih `WAREST_STORAGE_DRIVER=local` untuk storage terenkripsi di disk (signed URL disajikan dari `/storages`), atau `s3` untuk bucket eksternal. Konfigurasikan TTL, key enkripsi, dan URL publik melalui `WAREST_STORAGE_*`.
- **Cache**: Alihkan lookup berulang dan metadata ke Redis/Memcached/Mongo (atau memori lokal). Cache menyimpan negosiasi versi Baileys, rate limit webhook, dan token deduplikasi.
- **Antrean**: Request keluar melewati antrean yang menegakkan concurrency dan guardrail. Dipasangkan dengan pengaturan anti-spam (`SPAM_COOLDOWN_MS`, `QUOTA_WINDOW_MS`) dan rate limit (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`).
- **Proxy**: Proxy HTTP/SOCKS opsional menjaga trafik WhatsApp tetap tangguh. Sediakan beberapa endpoint dan pilih strategi, tingkatkan stickiness, rotasi setelah gagal, cooloff, dan jitter menggunakan `WAREST_PROXY_*`.

Setiap subsistem berkontribusi pada reliabilitas: Storage menjamin ketersediaan media, Cache mengurangi beban DB, Antrean meratakan lonjakan kiriman, dan Proxy mengatur ketahanan jaringan.

## Memetakan Terminologi WAREST ke Konsep WhatsApp

| Istilah WAREST | Konsep WhatsApp | Catatan |
| -------------- | --------------- | ------- |
| Sesi | Akun/perangkat WhatsApp yang login dan ditangani Baileys | Mencerminkan sesi multi-device WA; mencakup kredensial dan metadata perangkat. |
| Perangkat | Device pendamping (telepon/browser) | Berasal dari WA MD; WAREST mengekspos melalui `/session/devices`. |
| Registri | Penyimpanan sesi WhatsApp | Setara dengan store autentikasi persistent WhatsApp; WAREST menjaga di database relasional. |
| Chat | Percakapan (1:1, grup, komunitas) | Ditenagai JID; operasi dipetakan ke aksi chat WhatsApp. |
| Pesan | Payload pesan WhatsApp | Berisi key pesan, konten, dan konteks; aksi mengikuti fitur WA. |
| Objek Media | Stream media WhatsApp | Media unggahan memakai enkripsi WA; WAREST menangani kompresi + storage sebelum dikirim. |
| Event Webhook | Feed event WhatsApp | Baileys memunculkan pembaruan; WAREST menormalkan dan mengirim ke layanan Anda. |
| Action Runner | Perilaku klien WhatsApp (kirim/edit/baca/dll.) | Menjalankan helper socket Baileys yang sama dengan aksi klien WA. |
| Nomor Telepon | MSISDN WhatsApp | Digit yang telah dinormalisasi untuk membentuk JID `@s.whatsapp.net`. |
| JID | ID WhatsApp | Standar addressing WA; format sama di API + webhook WAREST. |
| LID | ID panjang WhatsApp | ID numerik khusus WA; dapat di-resolve ke JID via endpoint misc. |
| Driver Storage | Media store WhatsApp | Setara dengan CDN media WA tetapi dikelola sendiri (lokal atau S3). |
| Antrean/Proxy | Manajemen koneksi WhatsApp | Menyediakan ketahanan layaknya klien WA yang menyesuaikan throughput atau jalur jaringan. |

Dengan menyelaraskan terminologi di seluruh dokumentasi, OpenAPI, dan log runtime, implementasi encoder/decoder tetap konsisten dengan ekspektasi WhatsApp sembari memanfaatkan infrastruktur khusus WAREST.
