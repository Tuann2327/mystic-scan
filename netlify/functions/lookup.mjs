// POST /api/lookup  { code }  ->  { parsed, order } | { error }
import { lookupOrder, pinOk } from '../../lib/shopify.js';

export default async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  if (!pinOk(req.headers.get('x-app-pin'))) return Response.json({ error: 'Wrong or missing PIN.' }, { status: 401 });
  try {
    const { code } = await req.json().catch(() => ({}));
    const { status, body } = await lookupOrder(String(code || '').slice(0, 200));
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
};

export const config = { path: '/api/lookup' };
