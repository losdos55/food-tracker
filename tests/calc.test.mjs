import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/calc.js';
import { normalizeFood, extractPer100 } from '../js/fdc.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('scale macros per 100 g', () => {
  const m = C.scale({ kcal: 165, protein: 31, carbs: 0, fat: 3.6 }, 250);
  close(m.kcal, 412.5); close(m.protein, 77.5); close(m.fat, 9);
});

test('recipe -> cooked weight -> plate portion (the core workflow)', () => {
  const ings = [
    { food: { per100: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 } }, grams: 500 },   // chicken
    { food: { per100: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 } }, grams: 300 }, // rice
  ];
  const total = C.sumIngredients(ings);
  close(total.kcal, 825 + 390); close(total.protein, 155 + 8.1);
  close(C.totalWeight(ings), 800);
  const pg = C.perGram(total, 1000);            // dish weighs 1000 g cooked
  close(pg.kcal, 1.215); close(pg.protein, 0.1631);
  const plate = C.fromPerGram(pg, 350);
  close(plate.kcal, 425.25); close(plate.protein, 57.085);
  assert.equal(C.perGram(total, 0), null);
  assert.equal(C.perGram(total, NaN), null);
});

test('parseQty', () => {
  assert.equal(C.parseQty('150'), 150);
  assert.equal(C.parseQty('1,5'), 1.5);
  assert.equal(C.parseQty('1/2'), 0.5);
  assert.equal(C.parseQty('1 1/2'), 1.5);
  assert.ok(Number.isNaN(C.parseQty('abc')));
  assert.ok(Number.isNaN(C.parseQty('')));
});

test('unitOptions uses USDA cup portion for tbsp/tsp, else flags approx water density', () => {
  const flour = { portions: [{ label: 'cup, sifted', grams: 110 }, { label: 'medium', grams: 50 }] };
  const o = C.unitOptions(flour);
  close(o.find((x) => x.label === 'tbsp').grams, 110 / 16);
  assert.ok(!o.find((x) => x.label === 'tbsp').approx);
  assert.ok(o.some((x) => x.label === 'medium'));
  assert.ok(!o.some((x) => x.label === 'cup')); // covered by the USDA "cup, sifted" portion
  const bare = C.unitOptions({ portions: [] });
  assert.ok(bare.find((x) => x.label === 'cup').approx);
  close(bare.find((x) => x.label === 'oz').grams, 28.3495);
});

test('date helpers', () => {
  assert.equal(C.shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(C.shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(C.dateKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('FDC search-shaped nutrients (per 100 g)', () => {
  const m = extractPer100([
    { nutrientId: 1003, value: 22.5 }, { nutrientId: 1004, value: 2.6 },
    { nutrientId: 1005, value: 0 }, { nutrientId: 1008, value: 120 },
  ]);
  assert.deepEqual(m, { kcal: 120, protein: 22.5, carbs: 0, fat: 2.6 });
});

test('FDC detail-shaped nutrients, Atwater + kJ energy fallbacks', () => {
  assert.equal(extractPer100([{ nutrient: { id: 2047 }, amount: 97 }]).kcal, 97);
  close(extractPer100([{ nutrientId: 1062, value: 418.4 }]).kcal, 100);
  assert.equal(extractPer100([{ nutrient: { id: 1003 }, amount: 12 }]).protein, 12);
  assert.equal(extractPer100(undefined).kcal, 0);
});

test('normalizeFood: foundation portions + branded serving', () => {
  const f = normalizeFood({
    fdcId: 1, description: 'Rice, white, long-grain, raw', dataType: 'SR Legacy',
    foodNutrients: [{ nutrient: { id: 1008 }, amount: 365 }],
    foodPortions: [
      { amount: 1, gramWeight: 185, measureUnit: { name: 'cup' }, modifier: 'dry' },
      { amount: 2, gramWeight: 30, measureUnit: { name: 'undetermined' }, portionDescription: 'Quantity not specified' },
    ],
  });
  assert.deepEqual(f.portions, [{ label: 'cup, dry', grams: 185 }]);
  const b = normalizeFood({
    fdcId: 2, description: 'GREEK YOGURT', brandOwner: 'ACME FOODS', dataType: 'Branded',
    servingSize: 170, servingSizeUnit: 'g', householdServingFullText: '3/4 cup', foodNutrients: [],
  });
  assert.equal(b.name, 'Greek Yogurt');
  assert.deepEqual(b.portions, [{ label: 'serving (3/4 cup)', grams: 170 }]);
});
