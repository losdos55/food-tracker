// USDA FoodData Central client. https://fdc.nal.usda.gov/api-guide.html
// FDC returns nutrients per 100 g for Foundation / SR Legacy / Survey / Branded foods.

const BASE = 'https://api.nal.usda.gov/fdc/v1';

let keyProvider = () => 'DEMO_KEY';
export const setKeyProvider = (fn) => { keyProvider = fn; };
export const usingDemoKey = () => keyProvider() === 'DEMO_KEY';

export const TYPE_FILTERS = {
  generic: 'Foundation,SR Legacy,Survey (FNDDS)',
  branded: 'Branded',
  all: 'Foundation,SR Legacy,Survey (FNDDS),Branded',
};

// nutrient ids (and legacy "number"s) used by FDC
const IDS = { kcal: [1008], kcalAtwater: [2047, 2048], kj: [1062], protein: [1003], fat: [1004], carbs: [1005] };

/** Works for both shapes: search `{nutrientId, value}` and detail `{nutrient:{id}, amount}`. */
export function extractPer100(list = []) {
  const byId = new Map();
  for (const n of list) {
    const id = n.nutrientId ?? n.nutrient?.id;
    const val = n.value ?? n.amount;
    if (id != null && typeof val === 'number' && !byId.has(id)) byId.set(id, val);
  }
  const first = (ids) => { for (const i of ids) if (byId.has(i)) return byId.get(i); return null; };
  let kcal = first(IDS.kcal) ?? first(IDS.kcalAtwater);
  if (kcal == null) { const kj = first(IDS.kj); kcal = kj != null ? kj / 4.184 : 0; }
  return {
    kcal,
    protein: first(IDS.protein) ?? 0,
    carbs: first(IDS.carbs) ?? 0,
    fat: first(IDS.fat) ?? 0,
  };
}

const titleCase = (s) => (s && s === s.toUpperCase()
  ? s.toLowerCase().replace(/(^|[\s(,/-])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : s);

function portionsFrom(raw) {
  const out = [];
  for (const p of raw.foodPortions || []) {
    if (!(p.gramWeight > 0)) continue;
    const amount = p.amount > 0 ? p.amount : 1;
    const unit = p.measureUnit?.name && p.measureUnit.name !== 'undetermined' ? p.measureUnit.name : '';
    let label = [unit, p.modifier].filter(Boolean).join(', ');
    if (!label && p.portionDescription && !/not specified/i.test(p.portionDescription)) {
      label = p.portionDescription.replace(/^\d+(\.\d+)?\s*/, '');
    }
    if (!label) continue;
    out.push({ label, grams: p.gramWeight / amount });
  }
  if (raw.servingSize > 0 && /^(g|gm|gram|grm|ml|mlt)/i.test(raw.servingSizeUnit || 'g')) {
    const hh = raw.householdServingFullText ? ` (${raw.householdServingFullText})` : '';
    out.push({ label: `serving${hh}`, grams: raw.servingSize });
  }
  return out;
}

export function normalizeFood(raw) {
  return {
    fdcId: raw.fdcId,
    name: titleCase(raw.description || 'Unknown food'),
    brand: titleCase(raw.brandName || raw.brandOwner || ''),
    dataType: raw.dataType || '',
    per100: extractPer100(raw.foodNutrients),
    portions: portionsFrom(raw),
  };
}

async function request(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries({ ...params, api_key: keyProvider() })) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal });
  } catch (e) {
    throw new Error(navigator.onLine === false
      ? "You're offline. Food search needs a connection."
      : 'Could not reach FoodData Central. Check your connection and try again.');
  } finally { clearTimeout(timer); }
  if (res.status === 429) throw new Error('USDA rate limit reached. Add your own API key in Settings (DEMO_KEY is very limited) or wait a bit.');
  if (res.status === 403 || res.status === 401) throw new Error('USDA rejected the API key. Check it in Settings.');
  if (!res.ok) throw new Error(`USDA API error (${res.status}).`);
  return res.json();
}

export async function searchFoods(query, { type = 'generic', pageSize = 25 } = {}) {
  const data = await request('/foods/search', { query, dataType: TYPE_FILTERS[type] || TYPE_FILTERS.generic, pageSize });
  return (data.foods || []).map(normalizeFood);
}

const detailCache = new Map();

/** Fetch full detail (adds household portions). Falls back to the given summary on failure. */
export async function withDetail(food) {
  if (detailCache.has(food.fdcId)) return detailCache.get(food.fdcId);
  try {
    const raw = await request(`/food/${food.fdcId}`, {});
    const full = normalizeFood(raw);
    // keep search-result macros if detail somehow lacks them
    if (!full.per100.kcal && food.per100.kcal) full.per100 = food.per100;
    detailCache.set(food.fdcId, full);
    return full;
  } catch { return food; }
}
