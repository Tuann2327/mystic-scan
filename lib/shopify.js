// Shopify order lookup by tracking number.
// Shared by the local server (server.js) and the Netlify Functions (netlify/functions/*).

import { timingSafeEqual } from 'node:crypto';
import { parseManual, trackingMatches } from '../public/carrier.js';

const env = (k) => (process.env[k] || '').trim();
const shopDomain = () => env('SHOPIFY_STORE_DOMAIN').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const storeHandle = () => env('SHOPIFY_STORE_HANDLE') || shopDomain().replace(/\.myshopify\.com$/, '');

export function isConfigured() {
  return Boolean(shopDomain() && (env('SHOPIFY_ADMIN_TOKEN') || (env('SHOPIFY_CLIENT_ID') && env('SHOPIFY_CLIENT_SECRET'))));
}

export function pinRequired() {
  return Boolean(env('APP_PIN'));
}

export function pinOk(given) {
  const want = env('APP_PIN');
  if (!want) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- API access ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cachedToken = null;

async function getToken() {
  if (env('SHOPIFY_ADMIN_TOKEN')) return env('SHOPIFY_ADMIN_TOKEN');
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  // Dev Dashboard apps installed on your own store: client credentials grant.
  const res = await fetch(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env('SHOPIFY_CLIENT_ID'),
      client_secret: env('SHOPIFY_CLIENT_SECRET'),
    }),
  });
  if (!res.ok) throw new Error(`Shopify token request failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 86_400) * 1000 };
  return cachedToken.value;
}

async function gql(query, variables, attempt = 0) {
  const version = env('SHOPIFY_API_VERSION') || '2026-07';
  const res = await fetch(`https://${shopDomain()}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && !env('SHOPIFY_ADMIN_TOKEN') && attempt === 0) {
    cachedToken = null;
    return gql(query, variables, attempt + 1);
  }
  if (res.status === 429 && attempt < 3) {
    await sleep(800 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  if (json.errors?.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 3) {
    await sleep(800 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

const SEARCH_QUERY = `
query OrdersByTracking($q: String!) {
  orders(first: 10, query: $q, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id
      fulfillments(first: 10) { trackingInfo(first: 5) { number } }
    }
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

// ---------- lookup ----------

/**
 * Finds the order whose fulfillment tracking number matches a scanned/typed code.
 * Shopify's order search matches tracking numbers as free text; every hit is
 * verified against the actual fulfillment tracking numbers before it's returned.
 * Returns { status, body } ready to send as JSON.
 */
export async function lookupOrder(code) {
  if (!isConfigured()) {
    return { status: 503, body: { error: 'Server is not connected to Shopify yet. Set the SHOPIFY_* environment variables.' } };
  }
  const parsed = parseManual(code);
  if (!parsed) return { status: 400, body: { error: 'That does not look like a tracking number.' } };

  // Try the likely tracking number(s) first, then the raw barcode (some labels store the "420+ZIP" prefix).
  const terms = [...new Set([...parsed.candidates, parsed.raw])];
  let id = null;
  for (const term of terms) {
    const { orders } = await gql(SEARCH_QUERY, { q: term });
    const hit = orders.nodes.find((o) =>
      o.fulfillments.some((f) => f.trackingInfo.some((t) => trackingMatches(t.number, parsed))),
    );
    if (hit) { id = hit.id; break; }
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
    adminUrl: `https://admin.shopify.com/store/${storeHandle()}/orders/${o.legacyResourceId}`,
  };
}
