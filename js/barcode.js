// Barcode normalization + lookup: USDA FoodData Central (Branded, matched on gtinUpc),
// then Open Food Facts as a fallback. The pure helpers at the top are unit-tested.

import { searchRaw, normalizeFood, fetchWithTimeout, titleCase } from './fdc.js';

export const digits = (s) => String(s ?? '').replace(/\D/g, '');

/** Comparison key: FDC stores gtinUpc with inconsistent leading zeros (UPC-A 12 vs EAN-13/GTIN-14). */
export const gtinKey = (s) => digits(s).replace(/^0+/, '');

export const gtinMatches = (a, b) => {
  const ka = gtinKey(a);
  return ka !== '' && ka === gtinKey(b);
};

/** Standard GS1 mod-10 check digit, for 8, 12, 13 and 14 digit codes. */
export function checkDigitOk(code) {
  const d = digits(code);
  if (d !== String(code) || ![8, 12, 13, 14].includes(d.length)) return false;
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += +d[i] * w;
  return (10 - (sum % 10)) % 10 === +d[d.length - 1];
}

/** UPC-E (8 digits: number system + 6 + check) -> UPC-A (12 digits). null if not UPC-E shaped. */
export function expandUpcE(code) {
  const d = digits(code);
  if (d.length !== 8 || !/^[01]/.test(d)) return null;
  const [ns, x1, x2, x3, x4, x5, x6, chk] = d;
  let body;
  if (x6 <= '2') body = `${x1}${x2}${x6}0000${x3}${x4}${x5}`;
  else if (x6 === '3') body = `${x1}${x2}${x3}00000${x4}${x5}`;
  else if (x6 === '4') body = `${x1}${x2}${x3}${x4}00000${x5}`;
  else body = `${x1}${x2}${x3}${x4}${x5}0000${x6}`;
  return ns + body + chk;
}

/**
 * Valid full-length codes to look up for a scanned/typed barcode.
 * `format` comes from ZXing ('UPC_A' | 'UPC_E' | 'EAN_13' | 'EAN_8'); omitted for typed codes,
 * where an 8-digit code may be either EAN-8 or UPC-E, so both readings are kept.
 */
export function barcodeCandidates(code, format) {
  const d = digits(code);
  const out = [];
  if (format === 'UPC_E') out.push(expandUpcE(d));
  else {
    out.push(d);
    if (!format && d.length === 8) out.push(expandUpcE(d));
  }
  return [...new Set(out.filter((c) => c && checkDigitOk(c)))];
}

/** FDC search queries to try, most likely first (US UPC-A 12 digits, then EAN-13, then as scanned). */
export function fdcQueries(candidates) {
  const qs = [];
  for (const c of candidates) {
    const k = gtinKey(c);
    if (k.length <= 12) qs.push(k.padStart(12, '0'));
    if (k.length <= 13) qs.push(k.padStart(13, '0'));
    qs.push(c);
  }
  return [...new Set(qs)].slice(0, 3);
}

/** First raw FDC food whose gtinUpc equals any candidate, ignoring leading zeros. */
export function findGtinMatch(rawFoods, candidates) {
  const keys = new Set(candidates.map(gtinKey));
  return (rawFoods || []).find((f) => f.gtinUpc && keys.has(gtinKey(f.gtinUpc))) || null;
}

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Map an Open Food Facts v2 product response to the same food shape normalizeFood() returns. */
export function normalizeOffProduct(json, code) {
  const p = json?.product;
  if (!p || json.status === 0) return null;
  const n = p.nutriments || {};
  let kcal = num(n['energy-kcal_100g']);
  if (kcal == null) {
    const kj = num(n['energy-kj_100g']) ?? num(n.energy_100g); // energy_100g is kJ in OFF
    if (kj != null) kcal = kj / 4.184;
  }
  const protein = num(n.proteins_100g);
  const serving = num(p.serving_quantity);
  return {
    fdcId: null,
    gtin: p.code || code,
    name: titleCase(p.product_name_en || p.product_name || p.generic_name || '') || 'Unnamed product',
    brand: titleCase(String(p.brands || '').split(',')[0].trim()),
    dataType: 'Open Food Facts',
    source: 'Open Food Facts',
    per100: { kcal: kcal ?? 0, protein: protein ?? 0, carbs: num(n.carbohydrates_100g) ?? 0, fat: num(n.fat_100g) ?? 0 },
    portions: serving > 0 ? [{ label: p.serving_size ? `serving (${p.serving_size})` : 'serving', grams: serving }] : [],
    hasNutrition: kcal != null || protein != null,
  };
}

const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity';

async function fetchOff(code) {
  const res = await fetchWithTimeout(
    `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, 'Open Food Facts');
  if (res.status === 404) return null; // OFF answers "product not found" with a 404
  if (res.status === 429) throw new Error('Open Food Facts rate limit reached. Wait a minute and try again.');
  if (!res.ok) throw new Error(`Open Food Facts error (${res.status}).`);
  return normalizeOffProduct(await res.json(), code);
}

/**
 * Look a barcode up. Resolves to { food } when found, or { food: null, note } when neither source has
 * usable data. Throws only when a source errored AND nothing was found (so the user can retry).
 */
export async function lookupBarcode(code, format) {
  const candidates = barcodeCandidates(code, format);
  if (!candidates.length) throw new Error(`"${code}" isn't a valid UPC/EAN barcode. Check the digits.`);

  let error = null;
  for (const q of fdcQueries(candidates)) {
    try {
      const match = findGtinMatch(await searchRaw(q, { type: 'branded', pageSize: 10 }), candidates);
      if (match) return { food: normalizeFood(match) };
    } catch (e) { error = e; break; } // key/rate-limit/network problems won't fix themselves: go to OFF
  }

  let note = '';
  // OFF stores most products as EAN-13, and also resolves UPC-A, so the 13-digit form goes first
  const offCodes = [...new Set(candidates.flatMap((c) => {
    const k = gtinKey(c);
    return k.length <= 13 ? [k.padStart(13, '0'), c] : [c];
  }))].slice(0, 2);
  for (const c of offCodes) {
    try {
      const food = await fetchOff(c);
      if (food?.hasNutrition) return { food };
      if (food) note = `Open Food Facts lists "${food.name}" but has no calorie or protein data for it.`;
    } catch (e) { error ||= e; break; }
  }
  if (error && !note) throw error;
  return { food: null, note };
}
