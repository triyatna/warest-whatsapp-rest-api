---
title: Dokumentasi WAREST
description: WhatsApp REST API tidak resmi
layout: home

hero:
  name: WAREST
  text: "WhatsApp REST API Tidak Resmi - Dibangun di atas Node.js"
  tagline: "Otomasi WhatsApp multi-perangkat dan multi-sesi"
  image:
    src: /assets/warest-logo.png
    alt: Logo WAREST
  actions:
    - theme: brand
      text: Mulai
      link: /id/guide/overview
    - theme: alt
      text: Jelajahi API
      link: /reference/api

features:
  - title: Registri multi-sesi
    details: Inisialisasi, sambung ulang, dan pantau sesi serta perangkat tanpa batas dengan QR atau pair-code dan konfigurasi webhook per sesi.
  - title: Permukaan pesan lengkap
    details: Satu kontrak REST untuk teks, media/file/audio/dokumen/stiker/GIF, lokasi, tombol/daftar interaktif, polling, reaksi, edit, revoke, mute, pin, dan lainnya.
  - title: Webhook dan otomasi
    details: Tanda tangan HMAC-SHA2, retry dengan backoff dan jitter, verifikasi preflight, aksi di dalam respons, serta mirroring media agar alur tetap reaktif.
  - title: Storage dan pipeline media
    details: Driver lokal AES-256-GCM atau layanan kompatibel S3 dengan signed URL, presign, kompresi opsional, dan penanganan payload besar.
  - title: Guardrail internal
    details: Rate limiter, jendela anti-spam, kontrol antrean terhadap concurrency dan retry, pool proxy, serta endpoint kesehatan dan kesiapan untuk operasi aman.
  - title: Siap integrasi
    details: Dasbor UI dan OpenAPI docs, migrasi CLI, image Docker, serta node n8n resmi yang mempercepat pengembangan dan deployment.
---

::: warning
WAREST tidak berafiliasi dengan WhatsApp/Facebook/Meta. Gunakan secara bertanggung jawab agar akun tidak terkena suspensi.
:::
