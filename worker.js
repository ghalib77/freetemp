/**
 * TempBox Worker — Tanpa Dependency
 * Bisa langsung paste di Cloudflare Workers online editor
 *
 * Bindings yang dibutuhkan:
 *   KV Namespace  → MAIL_KV
 *   Variable      → MAIL_DOMAIN = "namadomain.com"
 */

const TTL = 86400; // Email disimpan 24 jam

// ═══════════════════════════════════════════════════════════
// MIME PARSER — tanpa library external
// ═══════════════════════════════════════════════════════════

function parseHeaders(text) {
  // Unfold header yang terlipat (RFC 2822)
  const unfolded = text.replace(/\r\n([ \t])/g, ' $1').replace(/\n([ \t])/g, ' $1');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).toLowerCase().trim();
      const val = line.slice(idx + 1).trim();
      if (!headers[key]) headers[key] = val; // ambil header pertama
    }
  }
  return headers;
}

function getBoundary(contentType) {
  const m = contentType.match(/boundary=["']?([^"';\r\n]+)["']?/i);
  return m ? m[1].trim() : null;
}

function decodeQP(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeB64(str) {
  try { return atob(str.replace(/\s/g, '')); } catch { return str; }
}

function decodeEncodedWords(str) {
  if (!str) return '';
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      const decoded = enc.toUpperCase() === 'B'
        ? decodeB64(text)
        : decodeQP(text.replace(/_/g, ' '));
      // Coba decode UTF-8
      try { return decodeURIComponent(escape(decoded)); } catch { return decoded; }
    } catch { return text; }
  });
}

function extractEmail(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

function extractName(from) {
  const m = from.match(/^([^<]+)</);
  if (!m) return '';
  return decodeEncodedWords(m[1].trim().replace(/^["']|["']$/g, ''));
}

function applyEncoding(body, encoding) {
  const enc = (encoding || '').toLowerCase().trim();
  if (enc === 'base64')            return decodeB64(body);
  if (enc === 'quoted-printable')  return decodeQP(body);
  return body;
}

function splitHeaderBody(raw) {
  const i4 = raw.indexOf('\r\n\r\n');
  const i2 = raw.indexOf('\n\n');
  const idx = i4 !== -1 ? i4 : i2;
  if (idx === -1) return { headerText: raw, body: '' };
  return {
    headerText: raw.slice(0, idx),
    body: raw.slice(idx + (i4 !== -1 ? 4 : 2)),
  };
}

function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseMultipart(body, boundary) {
  const parts = [];
  const rx = new RegExp('--' + escRx(boundary) + '(?:--)?(?:\r\n|\n)?', 'g');
  const segments = body.split(rx).slice(1); // buang bagian sebelum boundary pertama
  for (const seg of segments) {
    if (!seg || /^--/.test(seg.trim())) continue;
    const { headerText, body: partBody } = splitHeaderBody(seg);
    if (headerText) {
      parts.push({ headers: parseHeaders(headerText), body: partBody });
    }
  }
  return parts;
}

function extractBodies(headers, body) {
  let text = '', html = '';
  const ct  = (headers['content-type'] || 'text/plain').toLowerCase();
  const enc = headers['content-transfer-encoding'] || '';

  if (ct.includes('multipart/')) {
    const boundary = getBoundary(ct);
    if (boundary) {
      for (const part of parseMultipart(body, boundary)) {
        const pct  = (part.headers['content-type'] || 'text/plain').toLowerCase();
        const penc = part.headers['content-transfer-encoding'] || '';
        if (pct.includes('multipart/')) {
          // nested multipart (misal multipart/alternative dalam multipart/mixed)
          const { text: t, html: h } = extractBodies(part.headers, part.body);
          if (!text && t) text = t;
          if (!html && h) html = h;
        } else if (pct.includes('text/html')) {
          html = applyEncoding(part.body, penc);
        } else if (pct.includes('text/plain')) {
          text = applyEncoding(part.body, penc);
        }
      }
    }
  } else if (ct.includes('text/html')) {
    html = applyEncoding(body, enc);
  } else {
    text = applyEncoding(body, enc);
  }

  return { text, html };
}

function parseRawEmail(rawText) {
  const { headerText, body } = splitHeaderBody(rawText);
  const headers  = parseHeaders(headerText);
  const fromRaw  = headers['from'] || '';
  const subject  = decodeEncodedWords(headers['subject'] || '(Tanpa Judul)');

  let { text, html } = extractBodies(headers, body);

  // Fallback 1 — kalau parsing multipart gagal, pakai raw body langsung
  if (!text && !html) {
    const ct = (headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) {
      html = body;
    } else {
      text = body;
    }
  }

  // Fallback 2 — kalau masih kosong juga, simpan seluruh raw email
  if (!text && !html) {
    text = rawText;
  }

  return {
    from:     extractEmail(fromRaw),
    fromName: extractName(fromRaw),
    subject,
    textBody: text,
    htmlBody: html,
  };
}

// ═══════════════════════════════════════════════════════════
// EMAIL HANDLER — dipanggil setiap ada email masuk
// ═══════════════════════════════════════════════════════════

async function handleEmail(message, env) {
  try {
    // Baca raw stream jadi teks
    const raw = await new Response(message.raw).text();
    const parsed = parseRawEmail(raw);

    const id  = crypto.randomUUID();
    const ts  = Date.now();
    const to  = message.to.toLowerCase().trim();

    const emailData = {
      id,
      from:     parsed.from     || message.from || '',
      fromName: parsed.fromName || '',
      to,
      subject:  parsed.subject  || '(Tanpa Judul)',
      textBody: parsed.textBody || '',
      htmlBody: parsed.htmlBody || '',
      date:     new Date().toISOString(),
      seen:     false,
    };

    await env.MAIL_KV.put(
      `msg:${to}:${ts}:${id}`,
      JSON.stringify(emailData),
      { expirationTtl: TTL }
    );

    console.log(`✉️  ${message.from} → ${to} | "${emailData.subject}"`);
  } catch (err) {
    console.error('Gagal menyimpan email:', err);
  }
}

// ═══════════════════════════════════════════════════════════
// HTTP / API HANDLER
// ═══════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Content-Type':                 'application/json',
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function res(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

async function handleFetch(request, env) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  // GET /api/domain
  if (path === '/api/domain' && method === 'GET') {
    return res({ domain: env.MAIL_DOMAIN || 'yourdomain.com' });
  }

  // GET /api/messages?email=...
  if (path === '/api/messages' && method === 'GET') {
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();
    if (!email) return res([]);

    const list = await env.MAIL_KV.list({ prefix: `msg:${email}:` });
    const msgs = [];
    for (const key of list.keys) {
      const val = await env.MAIL_KV.get(key.name);
      if (!val) continue;
      const m = JSON.parse(val);
      msgs.push({ id: m.id, from: m.from, fromName: m.fromName, subject: m.subject, date: m.date, seen: m.seen });
    }
    msgs.sort((a, b) => new Date(b.date) - new Date(a.date));
    return res(msgs);
  }

  // GET /api/messages/:id?email=...
  if (/^\/api\/messages\/[^/]+$/.test(path) && method === 'GET') {
    const msgId = path.split('/')[3];
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();
    const list  = await env.MAIL_KV.list({ prefix: `msg:${email}:` });
    for (const key of list.keys) {
      const val = await env.MAIL_KV.get(key.name);
      if (!val) continue;
      const m = JSON.parse(val);
      if (m.id === msgId) {
        if (!m.seen) {
          m.seen = true;
          await env.MAIL_KV.put(key.name, JSON.stringify(m), { expirationTtl: TTL });
        }
        return res(m);
      }
    }
    return res({ error: 'Tidak ditemukan' }, 404);
  }

  // DELETE /api/messages/:id?email=...
  if (/^\/api\/messages\/[^/]+$/.test(path) && method === 'DELETE') {
    const msgId = path.split('/')[3];
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();
    const list  = await env.MAIL_KV.list({ prefix: `msg:${email}:` });
    for (const key of list.keys) {
      const val = await env.MAIL_KV.get(key.name);
      if (!val) continue;
      const m = JSON.parse(val);
      if (m.id === msgId) {
        await env.MAIL_KV.delete(key.name);
        return res({ success: true });
      }
    }
    return res({ error: 'Tidak ditemukan' }, 404);
  }

  // DELETE /api/inbox?email=... (hapus semua)
  if (path === '/api/inbox' && method === 'DELETE') {
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();
    if (!email) return res({ error: 'Email diperlukan' }, 400);
    const list = await env.MAIL_KV.list({ prefix: `msg:${email}:` });
    await Promise.all(list.keys.map(k => env.MAIL_KV.delete(k.name)));
    return res({ success: true, deleted: list.keys.length });
  }

  return res({ error: 'Endpoint tidak ditemukan' }, 404);
}

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════

export default {
  email: handleEmail,
  fetch: handleFetch,
};
