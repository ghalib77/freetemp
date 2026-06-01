# 🚀 TempBox — Panduan Setup (Custom Domain)

Ikuti langkah ini satu per satu. Estimasi waktu: **15–20 menit**.

---

## Prasyarat
- Domain sudah dipindahkan ke **Cloudflare** (nameserver Cloudflare)
- Node.js terinstall di komputer kamu
- Akun Cloudflare (gratis)

---

## Langkah 1 — Install Wrangler & Login

```bash
npm install
npx wrangler login
```

Browser akan terbuka, login ke akun Cloudflare kamu.

---

## Langkah 2 — Buat KV Namespace

```bash
npx wrangler kv namespace create MAIL_KV
```

Output-nya kira-kira:
```
{ binding = "MAIL_KV", id = "abc123def456..." }
```

**Salin id tersebut**, lalu tempel ke `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "MAIL_KV"
id      = "abc123def456..."   # ← tempel di sini
```

---

## Langkah 3 — Edit wrangler.toml

Ganti semua tulisan `GANTI_DENGAN_DOMAIN_KAMU.com` dengan domain kamu yang sebenarnya.

Contoh kalau domain kamu `contoh.id`:
```toml
[vars]
MAIL_DOMAIN = "contoh.id"

[[kv_namespaces]]
binding = "MAIL_KV"
id      = "abc123..."

[[email.routes]]
pattern   = "*@contoh.id"
zone_name = "contoh.id"
```

---

## Langkah 4 — Aktifkan Email Routing di Cloudflare

1. Buka **Cloudflare Dashboard** → pilih domain kamu
2. Klik menu **Email** → **Email Routing**
3. Klik **Enable Email Routing**
4. Cloudflare akan otomatis menambahkan MX record
5. Pastikan status **Active**

> ⚠️ Jangan tambahkan "catch-all" forwarding manual — worker kita yang akan handle.

---

## Langkah 5 — Deploy Worker

```bash
npx wrangler deploy
```

Setelah berhasil, kamu dapat URL seperti:
```
https://tempmail-worker.<username>.workers.dev
```

---

## Langkah 6 — Buka index.html

Buka file `index.html` di browser.
Di kolom **Setup API Worker**, masukkan URL worker dari langkah 5, lalu klik **Simpan**.

Atau kamu bisa juga deploy `index.html` ke **Cloudflare Pages** supaya bisa diakses online:
```bash
# Di folder yang sama
npx wrangler pages deploy . --project-name tempmail-frontend
```

---

## ✅ Selesai!

Sekarang kamu bisa:
- Ketik nama email bebas (misal `pendaftaran`) → jadi `pendaftaran@contoh.id`
- Klik **Gunakan**, dan inbox langsung aktif
- Email diterima otomatis, tersimpan 24 jam di Cloudflare KV

---

## FAQ

**Q: Apakah domain saya perlu dijaga aktif?**  
A: Selama domain masih terdaftar dan MX record Cloudflare aktif, semua email masuk.

**Q: Berapa batas email yang bisa diterima?**  
A: Cloudflare Free: 100.000 request/hari di Worker, KV 100.000 read/hari. Lebih dari cukup.

**Q: Email hilang setelah berapa lama?**  
A: 24 jam (TTL di KV). Bisa diubah di `worker.js` — variabel `TTL`.

**Q: Bisa pakai subdomain?**  
A: Ya! Ubah pattern di `wrangler.toml` menjadi `*@mail.contoh.id` dan sesuaikan MX record.
