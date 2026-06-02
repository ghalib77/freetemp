# FreeTemp — Deployment Guide

Disposable email inbox on `mediasaya.web.id` powered by Cloudflare Workers + KV + Email Routing + Pages.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Cloudflare account | Free tier is sufficient |
| Domain on Cloudflare | `mediasaya.web.id` must use Cloudflare nameservers |
| Node.js ≥ 18 | Required by Wrangler CLI |
| Wrangler CLI | `npm install -g wrangler` |

---

## Step 1 — Authenticate Wrangler

```bash
wrangler login
```

A browser window opens for OAuth. Complete sign-in, then return to the terminal.

---

## Step 2 — Create the KV Namespace

```bash
wrangler kv:namespace create FREETEMP_EMAILS
```

Output example:
```
{ binding = "FREETEMP_EMAILS", id = "abc123def456..." }
```

Copy the `id` value and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "FREETEMP_EMAILS"
id      = "abc123def456..."   # ← your real id here
```

> **Optional**: create a preview namespace for local dev:
> ```bash
> wrangler kv:namespace create FREETEMP_EMAILS --preview
> ```
> Then add `preview_id = "..."` to the same `[[kv_namespaces]]` block.

---

## Step 3 — Deploy the Worker

From the project root:

```bash
wrangler deploy
```

Note the deployed Worker URL (e.g. `https://freetemp-worker.<your-subdomain>.workers.dev`).

### Use a custom domain for the Worker (recommended)

1. Go to **Cloudflare Dashboard → Workers & Pages → freetemp-worker → Triggers → Custom Domains**
2. Add `freetemp-worker.mediasaya.web.id`
3. Cloudflare provisions a certificate automatically.

Update `API_BASE` in `frontend/index.html`:
```js
const API_BASE = 'https://freetemp-worker.mediasaya.web.id';
```

---

## Step 4 — Configure Email Routing (catch-all → Worker)

1. **Dashboard → Email → Email Routing → mediasaya.web.id**
2. Enable Email Routing if not already active.
3. Under **Catch-all address**, click **Edit**.
4. Set **Action** → **Send to a Worker**.
5. Select **freetemp-worker** from the dropdown.
6. Click **Save**.

> Every email sent to `*@mediasaya.web.id` now flows into your Worker's `email()` handler.

---

## Step 5 — Deploy the Frontend to Cloudflare Pages

### Option A — Direct upload (quickest)

```bash
wrangler pages deploy frontend/ --project-name freetemp
```

Follow the prompts; Wrangler creates the Pages project on first run.

### Option B — GitHub integration

1. Push this repo to GitHub.
2. **Dashboard → Workers & Pages → Create → Pages → Connect to Git**
3. Select your repo.
4. Set **Build output directory** to `frontend`.
5. Leave build command blank (no build step needed).
6. Click **Save and Deploy**.

---

## Step 6 — Attach Custom Domain to Pages

1. **Dashboard → Workers & Pages → freetemp → Custom Domains**
2. Click **Set up a custom domain**.
3. Enter `freetemp.mediasaya.web.id` (or `mediasaya.web.id` if using the apex).
4. Cloudflare adds a CNAME automatically; wait ~60 seconds for propagation.

---

## Step 7 — End-to-End Test

1. Open `https://freetemp.mediasaya.web.id` (or your Pages URL).
2. The app generates a random address, e.g. `quickfox2847@mediasaya.web.id`.
3. Click **Copy**, then send an email to that address from any account.
4. Wait up to 10 seconds; the inbox auto-refreshes every 5 seconds.
5. Click the email row to open the detail modal with the rendered HTML body.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Inbox always empty | Email Routing not enabled | Check Step 4; verify catch-all is set to the Worker |
| `500` from `/api/inbox` | Wrong KV namespace ID | Re-check `wrangler.toml` id and redeploy |
| CORS errors in browser | `API_BASE` mismatch | Ensure `API_BASE` in `index.html` matches the deployed Worker URL |
| Email body blank | Worker MIME parser edge case | Check Worker logs in Dashboard → Workers → freetemp-worker → Logs |
| Custom domain not resolving | DNS not propagated | Wait 5–10 min; check via `dig freetemp.mediasaya.web.id` |

---

## Architecture Overview

```
User's browser
    │  HTTP GET /api/inbox
    ▼
Cloudflare Pages (index.html)
    │  fetch API_BASE/api/...
    ▼
Cloudflare Worker (freetemp-worker)
    ├── GET /api/inbox       → KV list prefix lookup → JSON
    └── GET /api/email/:id   → KV get by key         → JSON

Sender's mail server
    │  SMTP → mediasaya.web.id
    ▼
Cloudflare Email Routing (catch-all)
    │  email() handler
    ▼
Cloudflare Worker
    └── MIME parse → KV.put(key, json, { expirationTtl: 604800 })
```

---

## KV Data Model

```
Key:   email:{to_address}:{unix_ms}:{uuid}
Value: {
  "id":         "uuid-v4",
  "from":       "sender@example.com",
  "to":         "quickfox2847@mediasaya.web.id",
  "subject":    "Hello",
  "receivedAt": "2025-01-15T10:30:00Z",
  "bodyHtml":   "<html>…</html>",
  "bodyText":   "plain text fallback"
}
TTL: 7 days (604 800 s)
```

The time-sortable key prefix allows `KV.list({ prefix: "email:{address}:" })` to retrieve all messages for a given inbox efficiently.

---

## Security Notes

- The email body is rendered in a **sandboxed `<iframe srcdoc="...">`** with no `allow-scripts` — JavaScript in HTML emails cannot execute.
- CORS is open (`*`) by default. Restrict to your domain in production by changing the `CORS` constant in `worker/index.js`.
- KV keys include the recipient address, so a user can only query their own inbox — there is no auth, but guessing a random address (`adjective + noun + 4 digits`) is computationally impractical.
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
