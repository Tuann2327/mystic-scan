// Mystic Scan — local server (zero dependencies).
// Serves the mobile web app from /public and runs the same Shopify lookup the
// Netlify Functions use (lib/shopify.js), so the access token never reaches the phone.
// On Netlify this file isn't used — see netlify.toml.

import http from 'node:http';
import https from 'node:https';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch { /* no .env file — use real env vars */ }

const { isConfigured, lookupOrder, pinOk, pinRequired } = await import('./lib/shopify.js');

const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public', import.meta.url)));

if (!isConfigured()) console.warn('⚠  Shopify is not configured. Copy .env.example to .env and fill it in.');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error('Body too large');
  }
  return JSON.parse(data || '{}');
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, { pinRequired: pinRequired(), configured: isConfigured() });
    }
    if (url.pathname === '/api/lookup' && req.method === 'POST') {
      if (!pinOk(req.headers['x-app-pin'])) return sendJson(res, 401, { error: 'Wrong or missing PIN.' });
      const { code } = await readJson(req);
      const { status, body } = await lookupOrder(String(code || '').slice(0, 200));
      return sendJson(res, status, body);
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

    // Static files
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = resolve(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 403, { error: 'Forbidden' });
    const data = await readFile(file).catch(() => null);
    if (!data) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Server error' });
  }
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => {
  console.log(`Mystic Scan running on http://localhost:${PORT}`);
});

// Local HTTPS (phones only allow the camera on https). Uses certs/*.pem if present.
const [key, cert] = await Promise.all([
  readFile(new URL('./certs/key.pem', import.meta.url)).catch(() => null),
  readFile(new URL('./certs/cert.pem', import.meta.url)).catch(() => null),
]);
if (key && cert) {
  https.createServer({ key, cert }, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    const lan = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `https://${i.address}:${HTTPS_PORT}`);
    console.log(`HTTPS (for phones on your Wi-Fi): ${lan.join('  ')}`);
  });
}
