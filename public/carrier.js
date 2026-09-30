// Shared by the browser (scanner) and the server (lookup).
// Turns a raw shipping-label barcode into a carrier + tracking number.

export function normalize(value) {
  return String(value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

// Most common USPS tracking lengths, in order of preference.
const USPS_LENGTHS = [22, 26, 20, 30, 34];

function uspsScore(t) {
  const i = USPS_LENGTHS.indexOf(t.length);
  return (t.startsWith('9') ? 0 : 100) + (i === -1 ? 50 : i);
}

/**
 * Returns { carrier, tracking, raw, candidates } or null when the barcode
 * doesn't look like a UPS / USPS tracking barcode.
 *
 * - UPS: Code 128 "1Z" + 16 chars.
 * - USPS IMpb: GS1-128 "420" + ZIP (5 or 9 digits) + tracking (usually 22 digits
 *   starting with 9). Because the ZIP length is ambiguous, every plausible
 *   tracking number is kept in `candidates`.
 * Short barcodes (e.g. the "420 + ZIP" routing barcode on UPS labels) are ignored.
 */
export function parseCarrierBarcode(input) {
  const raw = normalize(input);
  if (raw.length < 18) return null;

  const ups = raw.match(/1Z[0-9A-Z]{16}/);
  if (ups) return { carrier: 'UPS', tracking: ups[0], raw, candidates: [ups[0]] };

  if (!/^\d+$/.test(raw)) return null;
  const isImpb = raw.startsWith('420') && raw.length >= 28;
  if (!isImpb && !/^9[1-5]\d{18,32}$/.test(raw)) return null;

  const candidates = isImpb ? [raw.slice(8), raw.slice(12)].filter((t) => t.length >= 20) : [raw];
  candidates.sort((a, b) => uspsScore(a) - uspsScore(b));
  return { carrier: 'USPS', tracking: candidates[0], raw, candidates };
}

/** For typed-in numbers: accept anything reasonably long even if not recognised. */
export function parseManual(input) {
  const parsed = parseCarrierBarcode(input);
  if (parsed) return parsed;
  const raw = normalize(input);
  if (raw.length < 8) return null;
  return { carrier: 'Other', tracking: raw, raw, candidates: [raw] };
}

/** Does a tracking number stored on a Shopify fulfillment match the scanned code? */
export function trackingMatches(orderTracking, parsed) {
  const t = normalize(orderTracking);
  if (t.length < 8) return false;
  return parsed.candidates.includes(t) || parsed.raw === t || parsed.raw.endsWith(t);
}
