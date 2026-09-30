// Mystic Scan — tiny zero-dependency server.
// Serves the mobile web app from /public and proxies order lookups to the
// Shopify Admin GraphQL API so the access token never reaches the phone.

import http from 'node:http';
import https from 'node:https';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { normalize, parseManual, trackingMatches } from './public/carrier.js';

try { process.loadEnvFile(); } catch { /* no .env file — use real env vars */ }

const env = process.env;
const SHOP = (env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const STORE_HANDLE = env.SHOPIFY_STORE_HANDLE || SHOP.replace(/\.myshopify\.com$/, '');
const API_VERSION = env.SHOPIFY_API_VERSION || '2026-07';
const APP_PIN = env.APP_PIN || '';
const PORT = Number(env.PORT || 3000);
const LOOKBACK_DAYS = Number(env.LOOKBACK_DAYS || 45);
const MAX_PAGES = Number(env.MAX_INDEX_PAGES || 40); // 100 orders per page

const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public', import.meta.url)));

if (!SHOP || !(env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET))) {
  console.warn('⚠  Shopify is not configured. Copy .env.example to .env and fill it in.');
}

// ---------- Shopify API ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cachedToken = null;

async function getToken() {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  // Dev Dashboard apps installed on your own store: client credentials grant.
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token request failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 86_400) * 1000 };
  return cachedToken.value;
}

async function gql(query, variables, attempt = 0) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && !env.SHOPIFY_ADMIN_TOKEN && attempt === 0) {
    cachedToken = null;
    return gql(query, variables, attempt + 1);
  }
  if (res.status === 429 && attempt < 4) {
    await sleep(1000 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  if (json.errors?.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 4) {
    await sleep(1000 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

const ORDERS_QUERY = `
query OrdersByTracking($first: Int!, $q: String!, $after: String) {
  orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id
      fulfillments(first: 10) { trackingInfo(first: 5) { number } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ORDER_QUERY = `
query OrderDetail($id: ID!) {
  order(id: $id) {
    id
    legacyResourceId
    name
    createdAt
    displayFinancialStatus
    displayFulfillmentStatus
    email
    phone
    note
    customer { displayName }
    shippingAddress { name company address1 address2 city province provinceCode zip country countryCodeV2 phone }
    shippingLine { title }
    lineItems(first: 100) {
      nodes {
        id
        title
        variantTitle
        quantity
        sku
        image { url(transform: { maxWidth: 160, maxHeight: 160 }) altText }
      }
    }
    fulfillments(first: 10) {
      status
      createdAt
      trackingInfo(first: 5) { number company url }
    }
  }
}`;

// ---------- Tracking number -> order index ----------
// Shopify can't reliably filter orders by tracking number, so we keep an
// in-memory index of recent orders' tracking numbers and refresh it
// incrementally (only orders updated since the last scan).

const index = new Map(); // normalized tracking number -> order GID
let indexedThrough = null; // Date the last completed scan started
let scanning = null;

function addToIndex(nodes) {
  for (const o of nodes) {
    for (const f of o.fulfillments ?? []) {
      for (const t of f.trackingInfo ?? []) {
        const n = normalize(t.number);
        if (n) index.set(n, o.id);
      }
    }
  }
}

function findInIndex(parsed) {
  for (const c of parsed.candidates) if (index.has(c)) return index.get(c);
  for (const [t, id] of index) if (trackingMatches(t, parsed)) return id;
  return null;
}

function refreshIndex() {
  if (scanning) return scanning;
  scanning = (async () => {
    const started = new Date();
    const since = indexedThrough
      ? new Date(indexedThrough.getTime() - 10 * 60_000)
      : new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
    const q = `updated_at:>='${since.toISOString()}'`;
    let after = null;
    let pages = 0;
    do {
      const d = await gql(ORDERS_QUERY, { first: 100, q, after });
      addToIndex(d.orders.nodes);
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after && ++pages < MAX_PAGES);
    indexedThrough = started;
    console.log(`Indexed tracking numbers: ${index.size} (orders updated since ${since.toISOString()})`);
  })().finally(() => { scanning = null; });
  return scanning;
}

async function lookup(code) {
  if (!SHOP || !(env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET))) {
    return { status: 503, body: { error: 'Server is not connected to Shopify yet. Fill in .env on the PC and restart the server.' } };
  }
  const parsed = parseManual(code);
  if (!parsed) return { status: 400, body: { error: 'That does not look like a tracking number.' } };

  let id = findInIndex(parsed);
  if (!id) {
    // Quick path: Shopify's order search often matches tracking numbers as free text.
    for (const candidate of parsed.candidates) {
      const d = await gql(ORDERS_QUERY, { first: 10, q: candidate, after: null });
      addToIndex(d.orders.nodes);
      if ((id = findInIndex(parsed))) break;
    }
  }
  if (!id) {
    await refreshIndex();
    id = findInIndex(parsed);
  }
  if (!id) return { status: 404, body: { parsed, error: 'No order found for this tracking number.' } };

  const { order } = await gql(ORDER_QUERY, { id });
  return { status: 200, body: { parsed, order: shapeOrder(order) } };
}

function shapeOrder(o) {
  const a = o.shippingAddress;
  return {
    id: o.id,
    legacyId: o.legacyResourceId,
    name: o.name,
    createdAt: o.createdAt,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    customerName: o.customer?.displayName || a?.name || '',
    email: o.email,
    phone: o.phone || a?.phone || '',
    note: o.note,
    shippingMethod: o.shippingLine?.title || '',
    shippingAddress: a && {
      name: a.name,
      company: a.company,
      lines: [
        a.address1,
        a.address2,
        [a.city, [a.provinceCode || a.province, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        a.countryCodeV2 !== 'US' ? a.country : null,
      ].filter(Boolean),
    },
    items: o.lineItems.nodes.map((li) => ({
      title: li.title,
      variant: li.variantTitle,
      quantity: li.quantity,
      sku: li.sku,
      image: li.image?.url || null,
    })),
    tracking: o.fulfillments.flatMap((f) =>
      f.trackingInfo.map((t) => ({ number: t.number, company: t.company, url: t.url, status: f.status })),
    ),
    adminUrl: `https://admin.shopify.com/store/${STORE_HANDLE}/orders/${o.legacyResourceId}`,
  };
}

// ---------- HTTP ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function pinOk(req) {
  if (!APP_PIN) return true;
  const given = Buffer.from(String(req.headers['x-app-pin'] || ''));
  const want = Buffer.from(APP_PIN);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error('Body too large');
  }
  return JSON.parse(data || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/config') {
      return send(res, 200, { pinRequired: Boolean(APP_PIN), configured: Boolean(SHOP) });
    }
    if (url.pathname === '/api/lookup' && req.method === 'POST') {
      if (!pinOk(req)) return send(res, 401, { error: 'Wrong or missing PIN.' });
      const { code } = await readJson(req);
      const { status, body } = await lookup(String(code || ''));
      return send(res, status, body);
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    // Static files
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = resolve(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, 'Forbidden');
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mystic Scan running on http://localhost:${PORT}`);
  if (SHOP) refreshIndex().catch((e) => console.error('Initial index failed:', e.message));
});

// Local HTTPS (phones only allow the camera on https). Uses certs/*.pem if present.
const HTTPS_PORT = Number(env.HTTPS_PORT || 3443);
const [key, cert] = await Promise.all([
  readFile(new URL('./certs/key.pem', import.meta.url)).catch(() => null),
  readFile(new URL('./certs/cert.pem', import.meta.url)).catch(() => null),
]);
if (key && cert) {
  https.createServer({ key, cert }, server.listeners('request')[0]).listen(HTTPS_PORT, '0.0.0.0', () => {
    const lan = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `https://${i.address}:${HTTPS_PORT}`);
    console.log(`HTTPS (for phones on your Wi-Fi): ${lan.join('  ')}`);
  });
}
