/**
 * TempBox Worker — Tanpa Dependency
 * Cloudflare Workers online editor compatible
 *
 * Bindings:
 * KV Namespace → MAIL_KV
 * Variable     → MAIL_DOMAIN
 */

const TTL = 86400;

// ═══════════════════════════════════════════════════════════
// MIME PARSER
// ═══════════════════════════════════════════════════════════

function parseHeaders(text) {
  const unfolded = text.replace(/\r\n([ \t])/g, ' ').replace(/\n([ \t])/g, ' ');
  const headers = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');

    if (idx > 0) {
      const key = line.slice(0, idx).toLowerCase().trim();
      const val = line.slice(idx + 1).trim();

      if (!headers[key]) headers[key] = val;
    }
  }

  return headers;
}

function getBoundary(contentType) {
  const m = contentType.match(/boundary=["']?([^"';\r\n\s]+)["']?/i);
  return m ? m[1].trim() : null;
}

function decodeQP(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeB64(str) {
  try {
    return atob(str.replace(/\s/g, ''));
  } catch {
    return str;
  }
}

function decodeEncodedWords(str) {
  if (!str) return '';

  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      const decoded = enc.toUpperCase() === 'B'
        ? decodeB64(text)
        : decodeQP(text.replace(/_/g, ' '));

      try {
        return decodeURIComponent(escape(decoded));
      } catch {
        return decoded;
      }
    } catch {
      return text;
    }
  });
}

function extractEmail(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

function extractName(from) {
  const m = from.match(/^([^<]+)</);

  if (!m) return '';

  return decodeEncodedWords(
    m[1].trim().replace(/^["']|["']$/g, '')
  );
}

function applyEncoding(body, encoding) {
  const enc = (encoding || '').toLowerCase().trim();

  if (enc === 'base64') return decodeB64(body);
  if (enc === 'quoted-printable') return decodeQP(body);

  return body;
}

function splitHeaderBody(raw) {
  const i4 = raw.indexOf('\r\n\r\n');
  const i2 = raw.indexOf('\n\n');

  let idx = -1;
  let skip = 2;

  if (i4 !== -1 && (i2 === -1 || i4 <= i2)) {
    idx = i4;
    skip = 4;
  } else if (i2 !== -1) {
    idx = i2;
    skip = 2;
  }

  if (idx === -1) {
    return {
      headerText: raw,
      body: ''
    };
  }

  return {
    headerText: raw.slice(0, idx),
    body: raw.slice(idx + skip)
  };
}

function parseMultipart(body, boundary) {
  const parts = [];
  const delim = '--' + boundary;
  const lines = body.split(/\r?\n/);

  let currentPart = [];
  let inPart = false;

  for (const line of lines) {
    if (line.startsWith(delim + '--')) {
      if (inPart && currentPart.length) {
        const { headerText, body: pb } = splitHeaderBody(currentPart.join('\n'));

        if (headerText) {
          parts.push({
            headers: parseHeaders(headerText),
            body: pb
          });
        }
      }

      break;
    } else if (line.startsWith(delim)) {
      if (inPart && currentPart.length) {
        const { headerText, body: pb } = splitHeaderBody(currentPart.join('\n'));

        if (headerText) {
          parts.push({
            headers: parseHeaders(headerText),
            body: pb
          });
        }
      }

      currentPart = [];
      inPart = true;
    } else if (inPart) {
      currentPart.push(line);
    }
  }

  return parts;
}

function extractBodies(headers, body) {
  let text = '';
  let html = '';

  const ct  = (headers['content-type'] || 'text/plain').toLowerCase();
  const enc = headers['content-transfer-encoding'] || '';

  if (ct.includes('multipart/')) {
    const boundary = getBoundary(ct);

    if (boundary) {
      for (const part of parseMultipart(body, boundary)) {
        const pct  = (part.headers['content-type'] || '').toLowerCase();
        const penc = part.headers['content-transfer-encoding'] || '';

        if (pct.includes('multipart/')) {
          const { text: t, html: h } = extractBodies(part.headers, part.body);

          if (!text && t) text = t;
          if (!html && h) html = h;
        } else if (pct.includes('text/html')) {
          if (!html) html = applyEncoding(part.body, penc);
        } else if (pct.includes('text/plain')) {
          if (!text) text = applyEncoding(part.body, penc);
        }
      }
    }
  } else if (ct.includes('text/html')) {
    html = applyEncoding(body, enc);
  } else if (ct.includes('text/plain')) {
    text = applyEncoding(body, enc);
  }

  return { text, html };
}

function scanParts(rawText) {
  let html = '';
  let text = '';

  const chunks = rawText.split(/(?:\r?\n)(?=Content-Type:\s*text\/)/i);

  for (const chunk of chunks) {
    const ctMatch = chunk.match(/^Content-Type:\s*(text\/\w+)/i);

    if (!ctMatch) continue;

    const isHtml  = /text\/html/i.test(ctMatch[1]);
    const isPlain = /text\/plain/i.test(ctMatch[1]);

    if (!isHtml && !isPlain) continue;

    const encMatch = chunk.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    const enc = encMatch ? encMatch[1].trim() : '';

    const blankIdx = chunk.search(/\r?\n\r?\n/);

    if (blankIdx === -1) continue;

    let partBody = chunk.slice(blankIdx).replace(/^\r?\n\r?\n?/, '');
    partBody = partBody.replace(/\r?\n--[^\r\n]*(--)?\s*$/, '').trim();

    if (!partBody) continue;

    const decoded = applyEncoding(partBody, enc);

    if (isHtml && !html) html = decoded;
    if (isPlain && !text) text = decoded;
  }

  return { html, text };
}

function parseRawEmail(rawText) {
  const { headerText, body } = splitHeaderBody(rawText);
  const headers = parseHeaders(headerText);

  const fromRaw = headers['from'] || '';
  const subject = decodeEncodedWords(headers['subject'] || '(Tanpa Judul)');

  let { text, html } = extractBodies(headers, body);

  if (!html || !text) {
    const found = scanParts(rawText);

    if (!html && found.html) html = found.html;
    if (!text && found.text) text = found.text;
  }

  if (!html && !text) {
    const ct = (headers['content-type'] || '').toLowerCase();

    if (ct.includes('text/html')) {
      html = body;
    } else {
      text = body;
    }
  }

  return {
    from: extractEmail(fromRaw),
    fromName: extractName(fromRaw),
    subject,
    textBody: text,
    htmlBody: html
  };
}

// ═══════════════════════════════════════════════════════════
// KV HELPER
// ═══════════════════════════════════════════════════════════

async function kvGetJson(env, key, fallback = null) {
  const val = await env.MAIL_KV.get(key);

  if (!val) return fallback;

  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════
// EMAIL HANDLER
// ═══════════════════════════════════════════════════════════

async function handleEmail(message, env) {
  try {
    const raw    = await new Response(message.raw).text();
    const parsed = parseRawEmail(raw);
    const id     = crypto.randomUUID();
    const to     = message.to.toLowerCase().trim();

    const emailData = {
      id,
      from:     parsed.from     || message.from || '',
      fromName: parsed.fromName || '',
      to,
      subject:  parsed.subject  || '(Tanpa Judul)',
      textBody: parsed.textBody || '',
      htmlBody: parsed.htmlBody || '',
      date:     new Date().toISOString(),
      seen:     false
    };

    const summaryData = {
      id,
      from:     emailData.from,
      fromName: emailData.fromName,
      subject:  emailData.subject,
      date:     emailData.date,
      seen:     false
    };

    // Simpan isi email lengkap.
    await env.MAIL_KV.put(
      `msg:${id}`,
      JSON.stringify(emailData),
      { expirationTtl: TTL }
    );

    // Simpan index inbox per alamat email.
    // Ini pengganti KV.list(), jadi inbox bisa dibaca pakai KV.get().
    const inboxKey = `inbox:${to}`;
    const inbox = await kvGetJson(env, inboxKey, []);

    inbox.unshift(summaryData);

    // Batasi 50 email terbaru supaya ringan.
    await env.MAIL_KV.put(
      inboxKey,
      JSON.stringify(inbox.slice(0, 50)),
      { expirationTtl: TTL }
    );

    console.log(
      `✉️ ${message.from} → ${to} | "${emailData.subject}" | html:${emailData.htmlBody.length} text:${emailData.textBody.length}`
    );
  } catch (err) {
    console.error('Gagal menyimpan email:', err);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// HTTP / API HANDLER
// ═══════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function res(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

async function handleFetch(request, env) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }

  // Health check sederhana.
  if (path === '/' && method === 'GET') {
    return res({
      ok: true,
      name: 'TempBox Worker',
      message: 'Worker aktif'
    });
  }

  // Ambil domain email.
  if (path === '/api/domain' && method === 'GET') {
    return res({
      domain: env.MAIL_DOMAIN || 'yourdomain.com'
    });
  }

  // Ambil daftar inbox.
  // PENTING: Tidak pakai KV.list().
  if (path === '/api/messages' && method === 'GET') {
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();

    if (!email) return res([]);

    const inbox = await kvGetJson(env, `inbox:${email}`, []);

    return res(inbox);
  }

  // Buka detail email.
  if (/^\/api\/messages\/[^/]+$/.test(path) && method === 'GET') {
    const msgId = path.split('/')[3];
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();

    const msgKey = `msg:${msgId}`;
    const m = await kvGetJson(env, msgKey, null);

    if (!m) {
      return res({
        error: 'Tidak ditemukan'
      }, 404);
    }

    if (!m.seen) {
      m.seen = true;

      await env.MAIL_KV.put(
        msgKey,
        JSON.stringify(m),
        { expirationTtl: TTL }
      );

      if (email) {
        const inboxKey = `inbox:${email}`;
        const inbox = await kvGetJson(env, inboxKey, []);

        const updatedInbox = inbox.map(item =>
          item.id === msgId
            ? { ...item, seen: true }
            : item
        );

        await env.MAIL_KV.put(
          inboxKey,
          JSON.stringify(updatedInbox),
          { expirationTtl: TTL }
        );
      }
    }

    return res(m);
  }

  // Hapus satu email.
  if (/^\/api\/messages\/[^/]+$/.test(path) && method === 'DELETE') {
    const msgId = path.split('/')[3];
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();

    await env.MAIL_KV.delete(`msg:${msgId}`);

    if (email) {
      const inboxKey = `inbox:${email}`;
      const inbox = await kvGetJson(env, inboxKey, []);

      const updatedInbox = inbox.filter(item => item.id !== msgId);

      if (updatedInbox.length) {
        await env.MAIL_KV.put(
          inboxKey,
          JSON.stringify(updatedInbox),
          { expirationTtl: TTL }
        );
      } else {
        await env.MAIL_KV.delete(inboxKey);
      }
    }

    return res({
      success: true
    });
  }

  // Hapus semua email di inbox tertentu.
  if (path === '/api/inbox' && method === 'DELETE') {
    const email = (url.searchParams.get('email') || '').toLowerCase().trim();

    if (!email) {
      return res({
        error: 'Email diperlukan'
      }, 400);
    }

    const inboxKey = `inbox:${email}`;
    const inbox = await kvGetJson(env, inboxKey, []);

    await Promise.all(
      inbox.map(item => env.MAIL_KV.delete(`msg:${item.id}`))
    );

    await env.MAIL_KV.delete(inboxKey);

    return res({
      success: true,
      deleted: inbox.length
    });
  }

  return res({
    error: 'Endpoint tidak ditemukan'
  }, 404);
}

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════

export default {
  async email(message, env, ctx) {
    try {
      await handleEmail(message, env);
    } catch (err) {
      console.error('EMAIL WORKER ERROR:', err);
      throw err;
    }
  },

  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      console.error('WORKER FETCH ERROR:', err);

      return res({
        error: true,
        message: err?.message || String(err),
        stack: err?.stack || null
      }, 500);
    }
  }
};
