/**
 * FreeTemp — Cloudflare Worker
 * Handles:
 *   1. Inbound email ingestion via Cloudflare Email Routing
 *   2. REST API: GET /api/inbox  and  GET /api/email/:id
 */

const KV_PREFIX  = 'email:';
const TTL_SECONDS = 7 * 24 * 60 * 60;   // 7 days
const MAX_EMAILS  = 50;

// ── CORS HEADERS ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ── ROUTER ───────────────────────────────────────────────────────────────────
export default {
  // HTTP fetch handler (REST API)
  async fetch(request, env) {
    const url = new URL(request.url);

    // Pre-flight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'GET') return err('Method Not Allowed', 405);

    // GET /api/inbox?address=...
    if (url.pathname === '/api/inbox') {
      return handleInbox(url, env);
    }

    // GET /api/email/:id?address=...
    const emailMatch = url.pathname.match(/^\/api\/email\/([^/]+)$/);
    if (emailMatch) {
      return handleEmailDetail(emailMatch[1], url, env);
    }

    return err('Not Found', 404);
  },

  // Email handler — called by Cloudflare Email Routing
  async email(message, env) {
    try {
      const raw   = await streamToArrayBuffer(message.raw);
      const bytes = new Uint8Array(raw);
      const text  = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

      const parsed = parseMime(text);

      const id          = crypto.randomUUID();
      const receivedAt  = new Date().toISOString();
      const toAddress   = (message.to || '').toLowerCase().trim();

      const emailObj = {
        id,
        from:       message.from || '',
        to:         toAddress,
        subject:    parsed.subject || '(no subject)',
        receivedAt,
        bodyHtml:   parsed.bodyHtml  || '',
        bodyText:   parsed.bodyText  || '',
      };

      // Key: email:{address}:{timestamp}:{uuid}  — sortable by time
      const kvKey = `${KV_PREFIX}${toAddress}:${Date.now()}:${id}`;
      await env.FREETEMP_EMAILS.put(kvKey, JSON.stringify(emailObj), {
        expirationTtl: TTL_SECONDS,
      });

    } catch (e) {
      // Log but don't throw — prevents bounces for storage errors
      console.error('Email ingest error:', e);
    }
  },
};

// ── HANDLERS ─────────────────────────────────────────────────────────────────
async function handleInbox(url, env) {
  const address = (url.searchParams.get('address') || '').toLowerCase().trim();
  if (!address || !address.includes('@')) return err('Missing or invalid address');

  try {
    const prefix = `${KV_PREFIX}${address}:`;
    const list   = await env.FREETEMP_EMAILS.list({ prefix, limit: MAX_EMAILS });

    const emailObjs = await Promise.all(
      list.keys.map(async ({ name }) => {
        const val = await env.FREETEMP_EMAILS.get(name);
        if (!val) return null;
        try {
          const obj = JSON.parse(val);
          // Strip body for list view — keeps payload small
          const { bodyHtml: _h, bodyText: _t, ...summary } = obj;
          return summary;
        } catch { return null; }
      })
    );

    // Filter nulls, sort newest-first
    const sorted = emailObjs
      .filter(Boolean)
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    return json(sorted);
  } catch (e) {
    console.error('Inbox error:', e);
    return err(JSON.stringify({
  error: 'Inbox error',
  message: e.message || String(e)
}), 500);
  }
}

async function handleEmailDetail(id, url, env) {
  const address = (url.searchParams.get('address') || '').toLowerCase().trim();
  if (!address || !address.includes('@')) return err('Missing or invalid address');
  if (!id) return err('Missing email id');

  try {
    const prefix  = `${KV_PREFIX}${address}:`;
    const list    = await env.FREETEMP_EMAILS.list({ prefix, limit: 200 });

    // Find the key that ends with our id
    const entry = list.keys.find(({ name }) => name.endsWith(`:${id}`));
    if (!entry) return err('Email not found', 404);

    const val = await env.FREETEMP_EMAILS.get(entry.name);
    if (!val) return err('Email not found', 404);

    return json(JSON.parse(val));
  } catch (e) {
    console.error('Email detail error:', e);
    return err('Internal Server Error', 500);
  }
}

// ── MIME PARSER ───────────────────────────────────────────────────────────────
/**
 * Minimal MIME parser — handles:
 *   - multipart/alternative  (picks text/html then text/plain)
 *   - multipart/mixed        (recurses into parts)
 *   - text/html  (top-level)
 *   - text/plain (top-level)
 *
 * We deliberately avoid external dependencies per the spec constraint.
 */
function parseMime(raw) {
  const result = { subject: '', bodyHtml: '', bodyText: '' };

  // Split headers / body
  const splitAt = raw.indexOf('\r\n\r\n') !== -1
    ? raw.indexOf('\r\n\r\n')
    : raw.indexOf('\n\n');

  const headerBlock = splitAt !== -1 ? raw.slice(0, splitAt)  : raw;
  const bodyBlock   = splitAt !== -1 ? raw.slice(splitAt + (raw[splitAt + 2] === '\n' ? 2 : 4)) : '';

  const headers   = parseHeaders(headerBlock);
  result.subject  = decodeEncodedWord(headers['subject'] || '');
  const ct        = headers['content-type'] || '';
  const encoding  = (headers['content-transfer-encoding'] || '').toLowerCase();

  if (ct.toLowerCase().includes('multipart/')) {
    const boundary = getBoundary(ct);
    if (boundary) {
      const parts = splitMultipart(bodyBlock || raw, boundary);
      for (const part of parts) {
        const sub = parseMime(part);
        if (!result.bodyHtml && sub.bodyHtml) result.bodyHtml = sub.bodyHtml;
        if (!result.bodyText && sub.bodyText) result.bodyText = sub.bodyText;
      }
    }
  } else if (ct.toLowerCase().includes('text/html')) {
    result.bodyHtml = decodeBody(bodyBlock, encoding);
  } else if (ct.toLowerCase().includes('text/plain')) {
    result.bodyText = decodeBody(bodyBlock, encoding);
  } else if (!ct || ct.toLowerCase().includes('text/')) {
    // Unknown / no content-type — treat as plain text
    result.bodyText = decodeBody(bodyBlock, encoding);
  }

  return result;
}

function parseHeaders(headerBlock) {
  const headers = {};
  // Unfold (join continuation lines)
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    headers[key] = val;
  }
  return headers;
}

function getBoundary(ct) {
  const m = ct.match(/boundary\s*=\s*"?([^";,\s]+)"?/i);
  return m ? m[1] : null;
}

function splitMultipart(body, boundary) {
  const delim   = '--' + boundary;
  const parts   = [];
  const segments = body.split(delim);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed || trimmed === '--') continue;
    // Remove trailing --
    parts.push(trimmed.replace(/^--\s*$/, '').trim());
  }
  return parts;
}

function decodeBody(body, encoding) {
  if (!body) return '';
  if (encoding === 'base64') {
    try {
      return atob(body.replace(/\s/g, ''));
    } catch { return body; }
  }
  if (encoding === 'quoted-printable') {
    return decodeQP(body);
  }
  return body;
}

function decodeQP(str) {
  return str
    .replace(/=\r?\n/g, '')                          // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)));
}

// Decode RFC 2047 encoded-words: =?charset?encoding?text?=
function decodeEncodedWord(str) {
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
      } else {
        const decoded = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
          (__, hex) => String.fromCharCode(parseInt(hex, 16)));
        bytes = new TextEncoder().encode(decoded);
      }
      return new TextDecoder(charset).decode(bytes);
    } catch { return text; }
  });
}

// ── UTIL ──────────────────────────────────────────────────────────────────────
async function streamToArrayBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let totalLen = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }

  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

