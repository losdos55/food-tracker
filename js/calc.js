// Pure calculation + formatting helpers. No DOM, no storage: easy to unit-test.

export const MACROS = ['kcal', 'protein', 'carbs', 'fat'];

export const zero = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

/** Macros for `grams` of a food whose nutrients are given per 100 g. */
export function scale(per100, grams) {
  const f = grams / 100;
  const out = zero();
  for (const k of MACROS) out[k] = (per100[k] || 0) * f;
  return out;
}

export function add(a, b) {
  const out = zero();
  for (const k of MACROS) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

/** Sum a recipe's raw ingredients: [{ food: {per100}, grams }] */
export function sumIngredients(ingredients) {
  return ingredients.reduce((t, i) => add(t, scale(i.food.per100, i.grams)), zero());
}

export const totalWeight = (ingredients) =>
  ingredients.reduce((s, i) => s + (i.grams || 0), 0);

/** Macros per gram of finished dish. null when cooked weight is not usable. */
export function perGram(total, cookedWeight) {
  if (!(cookedWeight > 0)) return null;
  const out = zero();
  for (const k of MACROS) out[k] = (total[k] || 0) / cookedWeight;
  return out;
}

/** Macros for `grams` given macros-per-gram. */
export function fromPerGram(pg, grams) {
  const out = zero();
  for (const k of MACROS) out[k] = (pg[k] || 0) * grams;
  return out;
}

export const perGramOfFood = (per100) => fromPerGram(
  { kcal: per100.kcal / 100, protein: per100.protein / 100, carbs: per100.carbs / 100, fat: per100.fat / 100 }, 1);

// ---------- units ----------

export const G_PER_OZ = 28.3495;
export const G_PER_LB = 453.592;
const G_PER_CUP_WATER = 236.588;

const VOLUME_WORDS = {
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
};
const VOLUME_FRACTION_OF_CUP = { cup: 1, tbsp: 1 / 16, tsp: 1 / 48 };

const volumeKey = (label) => VOLUME_WORDS[String(label).toLowerCase().split(/[\s,(]/)[0]];

/**
 * Units a user can enter for a food. Every option has `grams` = grams in ONE unit.
 * USDA household portions are used when present (so "1 cup" of flour is real flour
 * weight). Cup/tbsp/tsp not covered by a USDA portion fall back to water density
 * (or are derived from a USDA cup portion) and are flagged `approx`.
 */
export function unitOptions(food) {
  const opts = [
    { label: 'g', grams: 1 },
    { label: 'oz', grams: G_PER_OZ },
    { label: 'lb', grams: G_PER_LB },
  ];
  const seen = new Set(opts.map((o) => o.label));
  const portions = (food.portions || []).filter((p) => p.grams > 0 && p.label);
  for (const p of portions) {
    const key = p.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    opts.push({ label: p.label, grams: p.grams, portion: true });
  }
  const haveVolume = new Set(portions.map((p) => volumeKey(p.label)).filter(Boolean));
  const cup = portions.find((p) => volumeKey(p.label) === 'cup');
  const cupGrams = cup ? cup.grams : G_PER_CUP_WATER;
  for (const k of ['cup', 'tbsp', 'tsp']) {
    if (haveVolume.has(k) || seen.has(k)) continue;
    opts.push({ label: k, grams: cupGrams * VOLUME_FRACTION_OF_CUP[k], approx: !cup });
  }
  return opts;
}

/** Parse "150", "1.5", "1,5", "1/2", "1 1/2". Returns NaN when invalid. */
export function parseQty(str) {
  const s = String(str ?? '').trim().replace(',', '.');
  if (!s) return NaN;
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + +m[2] / +m[3];
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return +m[1] / +m[2];
  return /^\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
}

// ---------- formatting / dates ----------

export const fmtKcal = (n) => String(Math.round(n || 0));
export const fmtG = (n) => String(Math.round((n || 0) * 10) / 10);

export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDate(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + days));
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
