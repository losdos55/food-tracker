import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  gtinKey, gtinMatches, checkDigitOk, expandUpcE, barcodeCandidates, fdcQueries, findGtinMatch,
  normalizeOffProduct, lookupBarcode,
} from '../js/barcode.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test('gtinKey / gtinMatches ignore leading-zero differences (UPC-A vs EAN-13 vs GTIN-14)', () => {
  assert.equal(gtinKey('012345678905'), '12345678905');
  assert.ok(gtinMatches('012345678905', '0012345678905'));
  assert.ok(gtinMatches('00012345678905', '12345678905'));
  assert.ok(!gtinMatches('012345678905', '012345678912'));
  assert.ok(!gtinMatches('', '0000'));
  assert.ok(!gtinMatches(undefined, undefined));
});

test('check digits', () => {
  assert.ok(checkDigitOk('012345678905'));   // UPC-A
  assert.ok(checkDigitOk('3017620422003'));  // EAN-13
  assert.ok(checkDigitOk('96385074'));       // EAN-8
  assert.ok(!checkDigitOk('012345678906'));
  assert.ok(!checkDigitOk('12345'));
  assert.ok(!checkDigitOk('01234567890a'));
});

test('UPC-E expands to UPC-A for every compression rule', () => {
  assert.equal(expandUpcE('04252614'), '042100005264'); // last digit 0-2
  assert.equal(expandUpcE('01234531'), '012300000451'); // 3
  assert.equal(expandUpcE('01234548'), '012340000058'); // 4
  assert.equal(expandUpcE('01234565'), '012345000065'); // 5-9
  assert.equal(expandUpcE('92345678'), null);           // number system must be 0 or 1
  assert.ok(checkDigitOk(expandUpcE('04252614')));
});

test('barcodeCandidates', () => {
  assert.deepEqual(barcodeCandidates('012345678905', 'UPC_A'), ['012345678905']);
  assert.deepEqual(barcodeCandidates('04252614', 'UPC_E'), ['042100005264']);
  assert.deepEqual(barcodeCandidates('96385074', 'EAN_8'), ['96385074']);
  // typed 8 digits: EAN-8 and UPC-E readings both kept when valid
  assert.deepEqual(barcodeCandidates('04252614'), ['042100005264']); // not a valid EAN-8, valid UPC-E
  assert.deepEqual(barcodeCandidates(' 0123-4567-8905 '), ['012345678905']);
  assert.deepEqual(barcodeCandidates('012345678906'), []); // bad check digit
});

test('fdcQueries try UPC-A, EAN-13, then the scanned form', () => {
  assert.deepEqual(fdcQueries(['012345678905']), ['012345678905', '0012345678905']);
  assert.deepEqual(fdcQueries(['3017620422003']), ['3017620422003']);
  assert.deepEqual(fdcQueries(['96385074']), ['000096385074', '0000096385074', '96385074']);
});

test('findGtinMatch picks the result whose gtinUpc matches, not the first result', () => {
  const { foods } = fx('fdc-branded-search.json');
  assert.equal(findGtinMatch(foods, ['012345678905']).fdcId, 2002);
  assert.equal(findGtinMatch(foods, ['0012345678912']).fdcId, 2001);
  assert.equal(findGtinMatch(foods, ['3017620422003']), null);
});

test('Open Food Facts product -> normalized food shape', () => {
  const f = normalizeOffProduct(fx('off-product.json'), '3017620422003');
  assert.deepEqual(f, {
    fdcId: null, gtin: '3017620422003', name: 'Nutella', brand: 'Nutella',
    dataType: 'Open Food Facts', source: 'Open Food Facts',
    per100: { kcal: 539, protein: 6.3, carbs: 57.5, fat: 30.9 },
    portions: [{ label: 'serving (15 g)', grams: 15 }],
    hasNutrition: true,
  });
});

test('Open Food Facts: kJ-only energy, string values, missing fields, not found', () => {
  const f = normalizeOffProduct(fx('off-kj-only.json'), '4006381333931');
  assert.equal(f.name, 'Oat Drink');               // English name preferred, ALL CAPS title-cased
  assert.ok(Math.abs(f.per100.kcal - 50) < 1e-9);  // 209.2 kJ / 4.184
  assert.equal(f.per100.protein, 1);
  assert.equal(f.per100.fat, 0);
  assert.equal(f.brand, '');
  assert.deepEqual(f.portions, []);
  assert.equal(normalizeOffProduct(fx('off-not-found.json'), '0'), null);
  assert.equal(normalizeOffProduct({ status: 1, product: { product_name: 'X', nutriments: {} } }).hasNutrition, false);
});

// ---- lookupBarcode end-to-end with a stubbed fetch

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [re, reply] of routes) if (re.test(u)) return reply(u);
    throw new Error('unexpected ' + u);
  };
  return calls;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('lookup: FDC Branded match by gtinUpc', async () => {
  const calls = stubFetch([[/api\.nal\.usda\.gov/, () => json(fx('fdc-branded-search.json'))]]);
  const { food } = await lookupBarcode('012345678905', 'UPC_A');
  assert.equal(food.fdcId, 2002);
  assert.equal(food.source, 'USDA FoodData Central');
  assert.equal(food.per100.protein, 21.9);
  assert.deepEqual(food.portions, [{ label: 'serving (2 Tbsp)', grams: 32 }]);
  assert.match(calls[0], /dataType=Branded/);
  assert.match(calls[0], /query=012345678905/);
  assert.equal(calls.length, 1);
});

test('lookup: no FDC match falls back to Open Food Facts', async () => {
  const calls = stubFetch([
    [/api\.nal\.usda\.gov/, () => json({ foods: [] })],
    [/openfoodfacts\.org\/api\/v2\/product\/3017620422003\.json/, () => json(fx('off-product.json'))],
  ]);
  const { food } = await lookupBarcode('3017620422003', 'EAN_13');
  assert.equal(food.source, 'Open Food Facts');
  assert.equal(food.per100.kcal, 539);
  assert.ok(calls.some((u) => /openfoodfacts/.test(u)));
});

test('lookup: FDC error (e.g. rate limit) still tries Open Food Facts', async () => {
  stubFetch([
    [/api\.nal\.usda\.gov/, () => json({}, 429)],
    [/openfoodfacts/, () => json(fx('off-product.json'))],
  ]);
  const { food } = await lookupBarcode('3017620422003', 'EAN_13');
  assert.equal(food.name, 'Nutella');
});

test('lookup: neither source has it -> { food: null }', async () => {
  stubFetch([
    [/api\.nal\.usda\.gov/, () => json(fx('fdc-branded-search.json'))], // results, but no gtin match
    [/openfoodfacts/, () => json(fx('off-not-found.json'), 404)],
  ]);
  assert.deepEqual(await lookupBarcode('3017620422003', 'EAN_13'), { food: null, note: '' });
});

test('lookup: OFF product without nutrition is reported, not logged as 0 kcal', async () => {
  stubFetch([
    [/api\.nal\.usda\.gov/, () => json({ foods: [] })],
    [/openfoodfacts/, () => json({ status: 1, product: { product_name: 'Mystery Snack', nutriments: {} } })],
  ]);
  const r = await lookupBarcode('3017620422003', 'EAN_13');
  assert.equal(r.food, null);
  assert.match(r.note, /Mystery Snack.*no calorie or protein/);
});

test('lookup: both sources unreachable -> throws a retryable error; invalid code rejected', async () => {
  stubFetch([[/./, () => { throw new TypeError('Failed to fetch'); }]]);
  await assert.rejects(lookupBarcode('3017620422003', 'EAN_13'), /Could not reach FoodData Central/);
  await assert.rejects(lookupBarcode('123'), /isn't a valid UPC\/EAN/);
});
