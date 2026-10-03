import * as db from './db.js';
import * as fdc from './fdc.js';
import * as C from './calc.js';
import { lookupBarcode, barcodeCandidates } from './barcode.js';
import { openScanner } from './scanner.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SLOTS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snacks', label: 'Snacks' },
];
const slotLabel = (id) => SLOTS.find((s) => s.id === id)?.label || id;
const defaultSlot = () => {
  const h = new Date().getHours();
  return h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snacks';
};

const state = {
  tab: 'log',
  date: C.dateKey(),
  goals: { kcal: 2000, protein: 150 },
  apiKey: '',
  localKey: '',
  recipeView: 'list', // 'list' | 'edit'
  draft: null,
  search: { q: '', type: 'generic', items: [] },
  slot: defaultSlot(),
};

// ---------------------------------------------------------------- helpers

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function openSheet(html, { full = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet${full ? ' full' : ''}" role="dialog">${html}</div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('noscroll');
  $('.sheet-backdrop', wrap).addEventListener('click', () => closeSheet(wrap));
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(wrap)));
  return wrap;
}

function closeSheet(wrap) {
  wrap.remove();
  if (!document.querySelector('.sheet-wrap')) document.body.classList.remove('noscroll');
}

const closeAllSheets = () => document.querySelectorAll('.sheet-wrap').forEach(closeSheet);

const macroLine = (m) =>
  `<span class="m kcal">${C.fmtKcal(m.kcal)} kcal</span><span class="m prot">${C.fmtG(m.protein)}g P</span>` +
  `<span class="m minor">${C.fmtG(m.carbs)}g C</span><span class="m minor">${C.fmtG(m.fat)}g F</span>`;

function slotOptions(selected) {
  return SLOTS.map((s) => `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${s.label}</option>`).join('');
}

// ---------------------------------------------------------------- food search component

function mountSearch(root, store, onPick) {
  root.innerHTML = `
    <form class="searchbar">
      <input type="search" name="q" placeholder="Search foods (e.g. chicken breast raw)" autocomplete="off" autocapitalize="none" enterkeyhint="search" value="${esc(store.q)}">
      <select name="type" aria-label="Food type">
        <option value="generic">Generic</option>
        <option value="branded">Branded</option>
        <option value="all">All</option>
      </select>
      <button class="btn primary" type="submit">Search</button>
    </form>
    ${fdc.usingDemoKey() ? '<p class="note">Using the shared USDA <code>DEMO_KEY</code> (heavily rate-limited). Add your own free key in Settings.</p>' : ''}
    <div class="results"></div>`;
  const form = $('form', root);
  const results = $('.results', root);
  form.type.value = store.type;

  const paint = () => {
    if (!store.items.length) {
      results.innerHTML = store.q ? '<div class="empty">No results.</div>' : '<div class="empty">Search the USDA FoodData Central database.<br>Values are per 100 g.</div>';
      return;
    }
    results.innerHTML = store.items.map((f, i) => `
      <button class="row result" data-i="${i}">
        <span class="grow"><b>${esc(f.name)}</b><small>${esc([f.brand, f.dataType].filter(Boolean).join(' · '))}</small></span>
        <span class="right"><b>${C.fmtKcal(f.per100.kcal)}</b> kcal<small>${C.fmtG(f.per100.protein)}g protein</small></span>
      </button>`).join('');
  };
  paint();

  results.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) onPick(store.items[+b.dataset.i]);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return;
    form.q.blur();
    results.innerHTML = '<div class="empty">Searching…</div>';
    try {
      store.items = await fdc.searchFoods(q, { type: form.type.value });
      store.q = q;
      store.type = form.type.value;
      paint();
    } catch (err) {
      results.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  });
}

// ---------------------------------------------------------------- food sheet (qty + unit)

/**
 * mode: 'browse' (Log meal / Add to recipe) | 'log' | 'ingredient' | 'edit'
 * onAction(kind, { food, qty, unit, grams, date, slot }) — kind: 'log' | 'recipe' | 'ingredient' | 'update' | 'remove'
 */
function openFoodSheet(food, { mode, initial = { qty: 100, unit: 'g' }, date = state.date, slot = state.slot, onAction }) {
  const showLog = mode === 'browse' || mode === 'log';
  const buttons = {
    browse: '<button class="btn primary" data-do="log">Log meal</button><button class="btn" data-do="recipe">Add to recipe</button>',
    log: '<button class="btn primary" data-do="log">Log</button>',
    ingredient: '<button class="btn primary" data-do="ingredient">Add ingredient</button>',
    edit: '<button class="btn primary" data-do="update">Update</button><button class="btn danger" data-do="remove">Remove</button>',
  }[mode];

  const wrap = openSheet(`
    <div class="sheet-head"><h2>${esc(food.name)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="sub">${esc([food.brand, food.dataType].filter(Boolean).join(' · '))}</p>
    ${food.gtin ? `<p class="sub">Source: ${esc(food.source)} · barcode ${esc(food.gtin)}</p>` : ''}
    <div class="macros per100"><span class="label">Per 100 g</span>${macroLine(food.per100)}</div>
    <div id="serving"></div>
    <div class="field-row">
      <label class="field grow">Amount<input id="qty" inputmode="decimal" autocomplete="off" value="${esc(initial.qty)}"></label>
      <label class="field grow">Unit<select id="unit"></select></label>
    </div>
    <p class="hint" id="hint"></p>
    ${showLog ? `<div class="field-row">
      <label class="field grow">Date<input id="date" type="date" value="${date}"></label>
      <label class="field grow">Meal<select id="slot">${slotOptions(slot)}</select></label></div>` : ''}
    <div class="macros preview" id="preview"></div>
    <div class="actions">${buttons}</div>`);

  const qtyEl = $('#qty', wrap);
  const unitEl = $('#unit', wrap);
  let currentFood = food;

  const fillUnits = () => {
    const keep = unitEl.value || initial.unit;
    const opts = C.unitOptions(currentFood);
    unitEl.innerHTML = opts.map((o) => `<option value="${esc(o.label)}">${esc(o.label)}${o.approx ? ' ≈' : ''}</option>`).join('');
    unitEl.value = opts.some((o) => o.label === keep) ? keep : 'g';
  };
  const read = () => {
    const qty = C.parseQty(qtyEl.value);
    const opt = C.unitOptions(currentFood).find((o) => o.label === unitEl.value) || { grams: 1, label: 'g' };
    return { qty, opt, grams: qty * opt.grams };
  };
  const paintServing = () => {
    const sv = (currentFood.portions || []).find((p) => /^serving/i.test(p.label));
    $('#serving', wrap).innerHTML = sv
      ? `<div class="macros per100"><span class="label">Per ${esc(sv.label)} = ${C.fmtG(sv.grams)} g</span>${macroLine(C.scale(currentFood.per100, sv.grams))}</div>` : '';
  };
  const refresh = () => {
    paintServing();
    const { qty, opt, grams } = read();
    const ok = qty > 0;
    $('#hint', wrap).textContent = ok
      ? `= ${C.fmtG(grams)} g${opt.approx ? ' (approximate: water density; pick a g/oz amount for accuracy)' : ''}`
      : 'Enter an amount (e.g. 150, 1.5, 1/2).';
    $('#preview', wrap).innerHTML = ok ? macroLine(C.scale(currentFood.per100, grams)) : '';
    wrap.querySelectorAll('[data-do]').forEach((b) => { if (b.dataset.do !== 'remove') b.disabled = !ok; });
  };
  fillUnits();
  refresh();
  qtyEl.addEventListener('input', refresh);
  unitEl.addEventListener('change', refresh);

  // portions (cups, "1 medium", servings…) only come with the detail record
  if (!food.portions?.length) {
    fdc.withDetail(food).then((full) => {
      if (!wrap.isConnected || full === food) return;
      currentFood = { ...full, per100: food.per100 };
      fillUnits();
      refresh();
    });
  }

  wrap.querySelectorAll('[data-do]').forEach((b) => b.addEventListener('click', () => {
    const { qty, opt, grams } = read();
    const kind = b.dataset.do;
    if (kind !== 'remove' && !(qty > 0)) return;
    onAction(kind, {
      food: currentFood, qty, unit: opt.label, grams,
      date: $('#date', wrap)?.value || date,
      slot: $('#slot', wrap)?.value || slot,
    }, wrap);
  }));
  return wrap;
}

// ---------------------------------------------------------------- logging

async function saveLog(entry) {
  await db.putLog({ createdAt: Date.now(), ...entry });
  state.slot = entry.slot;
}

function logFood(food, { grams, date, slot }) {
  const pg = C.perGramOfFood(food.per100);
  return saveLog({
    kind: 'food', date, slot, name: food.name, fdcId: food.fdcId, gtin: food.gtin, source: food.source, grams, perGram: pg,
    ...C.fromPerGram(pg, grams),
  });
}

function foodLogHandler(wrapToClose) {
  return async (kind, r) => {
    if (kind === 'log') {
      await logFood(r.food, r);
      closeAllSheets();
      state.date = r.date;
      toast(`Logged to ${slotLabel(r.slot)}`);
      go('log');
    } else if (kind === 'recipe') {
      chooseRecipeFor(r);
    }
  };
}

// ---------------------------------------------------------------- cook / portion sheet

function openCookSheet(recipe, { date = state.date, slot = state.slot } = {}) {
  const total = C.sumIngredients(recipe.ingredients);
  const raw = C.totalWeight(recipe.ingredients);
  const last = recipe.lastCookedWeight;
  const wrap = openSheet(`
    <div class="sheet-head"><h2>Log ${esc(recipe.name)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="macros per100"><span class="label">Whole recipe</span>${macroLine(total)}</div>
    <p class="sub">Raw ingredients weigh ${C.fmtG(raw)} g. Weigh the finished dish and enter it below.</p>
    <label class="field">Total cooked weight (g)
      <input id="cw" inputmode="decimal" autocomplete="off" placeholder="e.g. 1200"></label>
    ${last ? `<button class="chip" id="reuse" type="button">Use last cooked weight (${C.fmtG(last)} g)</button>` : ''}
    <p class="hint" id="rate"></p>
    <label class="field">Your plate / portion weight (g)
      <input id="pw" inputmode="decimal" autocomplete="off" placeholder="e.g. 350"></label>
    <div class="field-row">
      <label class="field grow">Date<input id="date" type="date" value="${date}"></label>
      <label class="field grow">Meal<select id="slot">${slotOptions(slot)}</select></label>
    </div>
    <div class="macros preview" id="preview"></div>
    <div class="actions"><button class="btn primary" id="go" disabled>Log portion</button></div>`);

  const cw = $('#cw', wrap), pw = $('#pw', wrap), btn = $('#go', wrap);
  const refresh = () => {
    const cooked = C.parseQty(cw.value), plate = C.parseQty(pw.value);
    const pg = C.perGram(total, cooked);
    $('#rate', wrap).innerHTML = pg
      ? `Finished dish per 100 g: ${macroLine(C.fromPerGram(pg, 100))}` : '';
    const ok = pg && plate > 0;
    $('#preview', wrap).innerHTML = ok ? macroLine(C.fromPerGram(pg, plate)) : '';
    btn.disabled = !ok;
  };
  cw.addEventListener('input', refresh);
  pw.addEventListener('input', refresh);
  $('#reuse', wrap)?.addEventListener('click', () => { cw.value = last; refresh(); pw.focus(); });
  cw.focus();

  btn.addEventListener('click', async () => {
    const cooked = C.parseQty(cw.value), plate = C.parseQty(pw.value);
    const pg = C.perGram(total, cooked);
    if (!pg || !(plate > 0)) return;
    const d = $('#date', wrap).value || date, s = $('#slot', wrap).value;
    await db.putRecipe({ ...recipe, lastCookedWeight: cooked });
    await saveLog({
      kind: 'recipe', date: d, slot: s, name: recipe.name, recipeId: recipe.id,
      grams: plate, cookedWeight: cooked, perGram: pg, ...C.fromPerGram(pg, plate),
    });
    closeAllSheets();
    state.date = d;
    toast(`Logged to ${slotLabel(s)}`);
    go('log');
  });
}

// ---------------------------------------------------------------- add-to-meal sheet

function openAddSheet(date, slot) {
  state.slot = slot;
  const wrap = openSheet(`
    <div class="sheet-head"><h2>Add to ${slotLabel(slot)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="segmented"><button class="seg active" data-seg="recipes">My recipes</button><button class="seg" data-seg="search">Search foods</button></div>
    <div id="pane"></div>`, { full: true });
  const pane = $('#pane', wrap);
  const store = { q: '', type: 'generic', items: [] };

  const showRecipes = async () => {
    const recipes = await db.allRecipes();
    pane.innerHTML = recipes.length
      ? recipes.map((r) => `<button class="row" data-id="${r.id}"><span class="grow"><b>${esc(r.name)}</b><small>${r.ingredients.length} ingredients${r.lastCookedWeight ? ` · last cooked ${C.fmtG(r.lastCookedWeight)} g` : ''}</small></span></button>`).join('')
      : '<div class="empty">No recipes yet. Build one in the Recipes tab.</div>';
    pane.onclick = async (e) => {
      const b = e.target.closest('[data-id]');
      if (b) openCookSheet(recipes.find((r) => r.id === +b.dataset.id), { date, slot });
    };
  };
  const showSearch = () => {
    pane.onclick = null;
    mountSearch(pane, store, (f) => openFoodSheet(f, { mode: 'log', date, slot, onAction: foodLogHandler() }));
  };
  wrap.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => {
    wrap.querySelectorAll('[data-seg]').forEach((x) => x.classList.toggle('active', x === b));
    b.dataset.seg === 'recipes' ? showRecipes() : showSearch();
  }));
  showRecipes();
}

// ---------------------------------------------------------------- LOG view

let logToken = 0;

async function renderLog(v) {
  const token = ++logToken;
  const entries = (await db.logsByDate(state.date)).sort((a, b) => a.createdAt - b.createdAt);
  if (token !== logToken) return;
  const today = C.dateKey();
  const sum = (list) => list.reduce((t, e) => C.add(t, e), C.zero());
  const day = sum(entries);
  const label = C.parseDateKey(state.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  const bar = (name, val, goal, cls, unit) => {
    const pct = goal > 0 ? Math.min(100, (val / goal) * 100) : 0;
    const over = goal > 0 && val > goal;
    return `<div class="goal">
      <div class="goal-top"><span>${name}</span><b>${name === 'Calories' ? C.fmtKcal(val) : C.fmtG(val)} / ${C.fmtG(goal)}${unit}</b></div>
      <div class="bar"><div class="fill ${cls}${over ? ' over' : ''}" style="width:${pct}%"></div></div>
      <small>${over ? `${name === 'Calories' ? C.fmtKcal(val - goal) : C.fmtG(val - goal)}${unit} over` : `${name === 'Calories' ? C.fmtKcal(goal - val) : C.fmtG(goal - val)}${unit} left`}</small>
    </div>`;
  };

  v.innerHTML = `
    <div class="datenav">
      <button class="icon-btn" data-action="day" data-n="-1" aria-label="Previous day">‹</button>
      <label class="datelabel"><b>${esc(state.date === today ? 'Today' : label)}</b><small>${state.date === today ? esc(label) : esc(state.date)}</small>
        <input type="date" id="jump" value="${state.date}"></label>
      <button class="icon-btn" data-action="day" data-n="1" aria-label="Next day">›</button>
    </div>
    ${state.date !== today ? '<button class="chip center" data-action="today">Jump to today</button>' : ''}
    <section class="card goals">
      ${bar('Calories', day.kcal, state.goals.kcal, 'kcal', '')}
      ${bar('Protein', day.protein, state.goals.protein, 'prot', 'g')}
      <div class="macros small"><span class="label">Carbs / Fat</span><span class="m minor">${C.fmtG(day.carbs)}g C</span><span class="m minor">${C.fmtG(day.fat)}g F</span></div>
    </section>
    ${SLOTS.map((s) => {
      const list = entries.filter((e) => e.slot === s.id);
      const t = sum(list);
      return `<section class="card slot">
        <div class="slot-head"><h3>${s.label}</h3>
          <span class="slot-total">${list.length ? `<b>${C.fmtKcal(t.kcal)}</b> kcal · <b>${C.fmtG(t.protein)}</b>g P` : ''}</span>
          <button class="add" data-action="add" data-slot="${s.id}" aria-label="Add to ${s.label}">+</button></div>
        ${list.map((e) => `<button class="entry" data-action="edit-log" data-id="${e.id}">
          <span class="grow"><b>${esc(e.name)}</b><small>${C.fmtG(e.grams)} g${e.kind === 'recipe' ? ' · recipe' : ''}</small></span>
          <span class="right"><b>${C.fmtKcal(e.kcal)}</b> kcal<small>${C.fmtG(e.protein)}g P</small></span></button>`).join('')}
      </section>`;
    }).join('')}`;
  $('#jump', v).addEventListener('change', (e) => { if (e.target.value) { state.date = e.target.value; render(); } });
}

async function openEditLog(id) {
  const entries = await db.logsByDate(state.date);
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const wrap = openSheet(`
    <div class="sheet-head"><h2>${esc(e.name)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    ${e.kind === 'recipe' ? `<p class="sub">Recipe portion · batch cooked weight ${C.fmtG(e.cookedWeight)} g</p>` : ''}
    <label class="field">Weight (g)<input id="g" inputmode="decimal" value="${C.fmtG(e.grams)}"></label>
    <div class="field-row">
      <label class="field grow">Date<input id="date" type="date" value="${e.date}"></label>
      <label class="field grow">Meal<select id="slot">${slotOptions(e.slot)}</select></label>
    </div>
    <div class="macros preview" id="preview"></div>
    <div class="actions"><button class="btn primary" id="save">Save</button><button class="btn danger" id="del">Delete</button></div>`);
  const g = $('#g', wrap);
  const refresh = () => {
    const grams = C.parseQty(g.value);
    $('#preview', wrap).innerHTML = grams > 0 ? macroLine(C.fromPerGram(e.perGram, grams)) : '';
    $('#save', wrap).disabled = !(grams > 0);
  };
  g.addEventListener('input', refresh);
  refresh();
  $('#save', wrap).addEventListener('click', async () => {
    const grams = C.parseQty(g.value);
    if (!(grams > 0)) return;
    await db.putLog({ ...e, grams, date: $('#date', wrap).value || e.date, slot: $('#slot', wrap).value, ...C.fromPerGram(e.perGram, grams) });
    closeSheet(wrap);
    render();
  });
  $('#del', wrap).addEventListener('click', async () => {
    if (!confirm(`Delete "${e.name}" from ${slotLabel(e.slot)}?`)) return;
    await db.deleteLog(e.id);
    closeSheet(wrap);
    render();
  });
}

// ---------------------------------------------------------------- SEARCH view

function renderSearch(v) {
  v.innerHTML = `<button class="btn block scan-btn" data-action="scan">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8 8v8M11 8v8M14 8v8M17 8v8"/></svg>
      Scan barcode</button>
    <div id="search-pane"></div>`;
  mountSearch($('#search-pane', v), state.search, (f) => openFoodSheet(f, {
    mode: 'browse',
    onAction: foodLogHandler(),
  }));
}

// ---------------------------------------------------------------- barcode scanning

function startScan() {
  openScanner({ onCode: (code, format) => lookupAndShow(code, format), onManual: openManualBarcode });
}

function openManualBarcode() {
  const wrap = openSheet(`
    <div class="sheet-head"><h2>Type barcode</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="sub">Enter all the digits under the barcode (8, 12 or 13 digits, UPC or EAN).</p>
    <form id="bc-form">
      <label class="field">Barcode<input id="bc" inputmode="numeric" autocomplete="off" pattern="[0-9 ]*" placeholder="e.g. 012345678905"></label>
      <p class="hint" id="bc-hint"></p>
      <div class="actions"><button class="btn primary" type="submit">Look up</button></div>
    </form>`);
  const input = $('#bc', wrap);
  input.focus();
  $('#bc-form', wrap).addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.replace(/\D/g, '');
    if (!barcodeCandidates(code).length) {
      $('#bc-hint', wrap).textContent = [8, 12, 13].includes(code.length)
        ? "Those digits don't form a valid barcode (check digit mismatch). Double-check them."
        : 'A barcode has 8, 12 or 13 digits.';
      return;
    }
    closeSheet(wrap);
    lookupAndShow(code);
  });
}

async function lookupAndShow(code, format) {
  const wrap = openSheet(`
    <div class="sheet-head"><h2>Barcode ${esc(code)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div id="bc-body"><div class="empty">Looking up product…</div></div>`);
  const body = $('#bc-body', wrap);
  const offerFallbacks = (html, retry) => {
    body.innerHTML = `${html}<div class="actions">
      ${retry ? '<button class="btn primary" data-bc="retry">Try again</button>' : ''}
      <button class="btn${retry ? '' : ' primary'}" data-bc="search">Search by name</button>
      <button class="btn" data-bc="scan">Scan again</button>
      <button class="btn" data-bc="type">Type barcode</button></div>`;
    body.onclick = (e) => {
      const b = e.target.closest('[data-bc]');
      if (!b) return;
      closeSheet(wrap);
      ({
        retry: () => lookupAndShow(code, format),
        scan: startScan,
        type: openManualBarcode,
        search: async () => { await go('search'); $('#search-pane input[name=q]')?.focus(); },
      })[b.dataset.bc]();
    };
  };
  try {
    const { food, note } = await lookupBarcode(code, format);
    if (!wrap.isConnected) return;
    if (food) {
      closeSheet(wrap);
      openFoodSheet(food, { mode: 'browse', onAction: foodLogHandler() });
    } else {
      offerFallbacks(`<p>${note ? esc(note) : `No product with barcode <b>${esc(code)}</b> was found in USDA FoodData Central or Open Food Facts.`}</p>
        <p class="sub">Try searching for it by name instead.</p>`);
    }
  } catch (err) {
    if (wrap.isConnected) offerFallbacks(`<div class="error">${esc(err.message)}</div>`, true);
  }
}

// ---------------------------------------------------------------- RECIPES view

const newDraft = () => ({ name: '', ingredients: [] });

async function renderRecipes(v) {
  if (state.recipeView === 'edit' && state.draft) return renderRecipeEditor(v);
  const recipes = (await db.allRecipes()).sort((a, b) => a.name.localeCompare(b.name));
  v.innerHTML = `
    <button class="btn primary block" data-action="new-recipe">+ New recipe</button>
    ${recipes.length ? recipes.map((r) => {
      const t = C.sumIngredients(r.ingredients);
      return `<section class="card recipe">
        <h3>${esc(r.name)}</h3>
        <small>${r.ingredients.length} ingredients · raw ${C.fmtG(C.totalWeight(r.ingredients))} g${r.lastCookedWeight ? ` · last cooked ${C.fmtG(r.lastCookedWeight)} g` : ''}</small>
        <div class="macros">${macroLine(t)}</div>
        <div class="actions">
          <button class="btn primary" data-action="cook" data-id="${r.id}">Log</button>
          <button class="btn" data-action="edit-recipe" data-id="${r.id}">Edit</button>
          <button class="btn danger" data-action="del-recipe" data-id="${r.id}">Delete</button>
        </div></section>`;
    }).join('') : '<div class="empty">No recipes yet.<br>Create one, add ingredients from the USDA database, and save it.</div>'}`;
}

function renderRecipeEditor(v) {
  const d = state.draft;
  const total = C.sumIngredients(d.ingredients);
  v.innerHTML = `
    <label class="field">Recipe name<input id="rname" autocomplete="off" placeholder="e.g. Chicken &amp; rice batch" value="${esc(d.name)}"></label>
    <h3 class="section">Ingredients</h3>
    ${d.ingredients.length ? d.ingredients.map((ing, i) => {
      const m = C.scale(ing.food.per100, ing.grams);
      return `<button class="row" data-action="edit-ing" data-i="${i}">
        <span class="grow"><b>${esc(ing.food.name)}</b><small>${esc(ing.qty)} ${esc(ing.unit)} = ${C.fmtG(ing.grams)} g</small></span>
        <span class="right"><b>${C.fmtKcal(m.kcal)}</b> kcal<small>${C.fmtG(m.protein)}g P</small></span></button>`;
    }).join('') : '<div class="empty small">No ingredients yet.</div>'}
    <button class="btn block" data-action="add-ing">+ Add ingredient</button>
    <section class="card totals">
      <h3>Recipe total (raw)</h3>
      <div class="macros big">${macroLine(total)}</div>
      <small>Raw weight ${C.fmtG(C.totalWeight(d.ingredients))} g. You'll enter the cooked weight when you log it.</small>
    </section>
    <div class="actions">
      <button class="btn primary" data-action="save-recipe">Save recipe</button>
      <button class="btn" data-action="cancel-recipe">Cancel</button>
    </div>`;
  $('#rname', v).addEventListener('input', (e) => { d.name = e.target.value; });
}

function addIngredientFlow() {
  const store = { q: '', type: 'generic', items: [] };
  const picker = openSheet(`
    <div class="sheet-head"><h2>Add ingredient</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div id="pane"></div>`, { full: true });
  mountSearch($('#pane', picker), store, (f) => openFoodSheet(f, {
    mode: 'ingredient',
    onAction: (kind, r) => {
      state.draft.ingredients.push({ food: r.food, qty: r.qty, unit: r.unit, grams: r.grams });
      closeAllSheets();
      render();
    },
  }));
}

function editIngredient(i) {
  const ing = state.draft.ingredients[i];
  openFoodSheet(ing.food, {
    mode: 'edit', initial: { qty: ing.qty, unit: ing.unit },
    onAction: (kind, r) => {
      if (kind === 'remove') state.draft.ingredients.splice(i, 1);
      else state.draft.ingredients[i] = { food: r.food, qty: r.qty, unit: r.unit, grams: r.grams };
      closeAllSheets();
      render();
    },
  });
}

/** From the Search tab: send a looked-up food into a (new or saved) recipe. */
async function chooseRecipeFor(r) {
  const recipes = (await db.allRecipes()).sort((a, b) => a.name.localeCompare(b.name));
  const ing = { food: r.food, qty: r.qty, unit: r.unit, grams: r.grams };
  const wrap = openSheet(`
    <div class="sheet-head"><h2>Add to which recipe?</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    ${state.draft ? '<button class="row" data-pick="draft"><span class="grow"><b>Recipe being edited</b><small>' + esc(state.draft.name || 'Untitled') + '</small></span></button>' : ''}
    <button class="row" data-pick="new"><span class="grow"><b>+ New recipe</b></span></button>
    ${recipes.map((x) => `<button class="row" data-pick="${x.id}"><span class="grow"><b>${esc(x.name)}</b></span></button>`).join('')}`);
  wrap.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const p = b.dataset.pick;
    if (p === 'new') state.draft = newDraft();
    else if (p !== 'draft') state.draft = structuredClone(recipes.find((x) => x.id === +p));
    state.draft.ingredients.push(ing);
    state.recipeView = 'edit';
    closeAllSheets();
    toast('Added to recipe');
    go('recipes');
  });
}

async function saveRecipe() {
  const d = state.draft;
  d.name = d.name.trim();
  if (!d.name) return toast('Give the recipe a name');
  if (!d.ingredients.length) return toast('Add at least one ingredient');
  const rec = { ...d, totals: C.sumIngredients(d.ingredients), updatedAt: Date.now() };
  await db.putRecipe(rec);
  state.draft = null;
  state.recipeView = 'list';
  toast('Recipe saved');
  render();
}

// ---------------------------------------------------------------- SETTINGS view

async function renderSettings(v) {
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  v.innerHTML = `
    <section class="card">
      <h3>Daily goals</h3>
      <div class="field-row">
        <label class="field grow">Calories<input id="g-kcal" inputmode="numeric" value="${state.goals.kcal}"></label>
        <label class="field grow">Protein (g)<input id="g-prot" inputmode="numeric" value="${state.goals.protein}"></label>
      </div>
      <button class="btn primary" data-action="save-goals">Save goals</button>
    </section>
    <section class="card">
      <h3>USDA API key</h3>
      <p class="sub">Stored only on this device (IndexedDB). It is never part of the code or the GitHub repo. Get a free key at <a href="https://fdc.nal.usda.gov/api-key.html" target="_blank" rel="noopener">fdc.nal.usda.gov</a>.</p>
      <label class="field">API key<input id="key" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="${state.localKey ? 'Using config.local.js' : 'paste key'}" value="${esc(state.apiKey)}"></label>
      <div class="actions"><button class="btn primary" data-action="save-key">Save key</button><button class="btn" data-action="test-key">Test</button></div>
      <p class="hint" id="keystatus"></p>
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="sub">Your data lives only on this device. Export a backup now and then; import it to restore or move to another device. (The API key is not included.)</p>
      <div class="actions"><button class="btn" data-action="export">Export backup</button>
        <label class="btn file">Import backup<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      <p class="hint">Persistent storage: ${persisted === null ? 'unknown' : persisted ? 'granted' : 'not granted (installing to the Home Screen helps)'}.</p>
    </section>`;
  $('#import', v).addEventListener('change', importBackup);
}

async function exportBackup() {
  const data = JSON.stringify(await db.exportAll(), null, 2);
  const name = `food-tracker-backup-${C.dateKey()}.json`;
  const file = new File([data], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!confirm(`Replace ALL data on this device with this backup (${data.recipes?.length ?? 0} recipes, ${data.logs?.length ?? 0} log entries)?`)) return;
    await db.importAll(data);
    state.goals = (await db.getSetting('goals', state.goals));
    toast('Backup restored');
    render();
  } catch (err) { toast(err.message || 'Import failed'); }
  e.target.value = '';
}

// ---------------------------------------------------------------- actions + router

const actions = {
  day: (el) => { state.date = C.shiftDate(state.date, +el.dataset.n); render(); },
  today: () => { state.date = C.dateKey(); render(); },
  add: (el) => openAddSheet(state.date, el.dataset.slot),
  'edit-log': (el) => openEditLog(+el.dataset.id),

  'new-recipe': () => { state.draft = newDraft(); state.recipeView = 'edit'; render(); },
  'edit-recipe': async (el) => { state.draft = structuredClone(await db.getRecipe(+el.dataset.id)); state.recipeView = 'edit'; render(); },
  'del-recipe': async (el) => {
    const r = await db.getRecipe(+el.dataset.id);
    if (confirm(`Delete recipe "${r.name}"? Past log entries are kept.`)) { await db.deleteRecipe(r.id); render(); }
  },
  cook: async (el) => openCookSheet(await db.getRecipe(+el.dataset.id)),
  'add-ing': addIngredientFlow,
  'edit-ing': (el) => editIngredient(+el.dataset.i),
  'save-recipe': saveRecipe,
  'cancel-recipe': () => { state.draft = null; state.recipeView = 'list'; render(); },

  'save-goals': async () => {
    const kcal = C.parseQty($('#g-kcal').value), protein = C.parseQty($('#g-prot').value);
    if (!(kcal > 0) || !(protein > 0)) return toast('Enter valid goals');
    state.goals = { kcal, protein };
    await db.setSetting('goals', state.goals);
    toast('Goals saved');
  },
  'save-key': async () => {
    state.apiKey = $('#key').value.trim();
    await db.setSetting('apiKey', state.apiKey);
    toast(state.apiKey ? 'Key saved' : 'Key cleared');
  },
  'test-key': async () => {
    const out = $('#keystatus');
    state.apiKey = $('#key').value.trim();
    out.textContent = 'Testing…';
    try {
      const r = await fdc.searchFoods('apple', { pageSize: 1 });
      out.textContent = `Key works (${r.length ? 'got "' + r[0].name + '"' : 'no results'}).`;
    } catch (e) { out.textContent = e.message; }
  },
  export: exportBackup,
  scan: startScan,
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});

const TITLES = { log: 'Daily Log', search: 'Food Search', recipes: 'Recipes', settings: 'Settings' };

function go(tab) {
  state.tab = tab;
  window.scrollTo(0, 0);
  return render();
}

async function render() {
  $('#title').textContent = state.tab === 'recipes' && state.recipeView === 'edit'
    ? (state.draft?.id ? 'Edit Recipe' : 'New Recipe') : TITLES[state.tab];
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  const v = $('#view');
  const y = window.scrollY;
  await ({ log: renderLog, search: renderSearch, recipes: renderRecipes, settings: renderSettings }[state.tab])(v);
  window.scrollTo(0, y);
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.tab)));

async function init() {
  state.goals = await db.getSetting('goals', state.goals);
  state.apiKey = await db.getSetting('apiKey', '');
  // Optional gitignored dev config; 404s harmlessly on GitHub Pages.
  try { state.localKey = (await import('../config.local.js')).default?.apiKey || ''; } catch { /* not present */ }
  if (/PASTE_YOUR/.test(state.localKey)) state.localKey = '';
  fdc.setKeyProvider(() => state.apiKey || state.localKey || 'DEMO_KEY');
  navigator.storage?.persist?.();
  await render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();
