// GET /api/config  ->  { pinRequired, configured }
import { isConfigured, pinRequired } from '../../lib/shopify.js';

export default async () =>
  Response.json({ pinRequired: pinRequired(), configured: isConfigured() }, { headers: { 'Cache-Control': 'no-store' } });

export const config = { path: '/api/config' };
