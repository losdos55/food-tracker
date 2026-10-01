# Macro Tracker

A personal, single-user PWA for tracking calories and protein (carbs/fat shown too).
Plain HTML/CSS/JS with ES modules, **no build step**. Data lives in IndexedDB on each device.

**Features:** USDA FoodData Central search · recipe builder (g, oz, lb, cup, tbsp, tsp, USDA portions) ·
weight-based portions (cooked weight → macros per gram → plate weight) · four-meal daily log with day
navigation · daily goals with progress · JSON backup/restore · offline app shell.

## How the portion maths works

1. A recipe's raw ingredients are summed into total kcal/protein/carbs/fat.
2. Each time you cook it you enter the **total cooked weight**. Macros per gram = recipe total ÷ cooked weight.
   (Field starts empty; a "Use last cooked weight" button reuses the previous one.)
3. You enter the **plate weight**; logged macros = plate weight × macros per gram.

Standalone foods are logged the same way using the food's per-100 g values.

## API key handling (nothing secret is committed)

GitHub Pages only serves committed files, so a gitignored config file can never reach your phone. Instead:

- **On your devices:** paste the key into **Settings → USDA API key**. It is stored in that device's
  IndexedDB only. It is not in the repo, the deployed JS, or the backup export.
- **For desktop development:** copy `config.example.js` to `config.local.js` (gitignored) and paste the key there.
- Until a key is set the app falls back to USDA's shared `DEMO_KEY`, which is heavily rate-limited.

Get a free key at <https://fdc.nal.usda.gov/api-key.html>.

**Recommendation:** this "enter it in Settings" approach beats both alternatives for personal use. It leaks
nothing and needs no infrastructure. A Cloudflare Worker proxy is only worth it if you ever make the app
public. Committing the key to deployed JS is the one option to avoid (GitHub's secret scanning may also
auto-report/revoke it).

## Install on iPhone / iPad

Do this **in Safari** (not Chrome or an in-app browser):

1. Open `https://losdos55.github.io/food-tracker/`.
2. Tap the **Share** button (square with up arrow; on iPad it's at the top right, on iPhone at the bottom).
3. Scroll and tap **Add to Home Screen**. Keep the name "Macros" and tap **Add**.
4. **Launch it from the new home-screen icon.** It should open full-screen with no Safari address bar.
5. In the installed app: **Settings → paste your API key → Save → Test**, then set your goals.

Important iOS behaviours:
- The installed app and Safari tabs have **separate storage**. Enter your key/goals/recipes in the installed
  app. Anything entered while browsing in Safari won't appear there.
- iPhone and iPad each have their own data (no sync). Use **Settings → Export/Import backup** to move
  recipes between them or to keep a safety copy (e.g. save to Files/iCloud Drive from the share sheet).
- iOS shows the manifest `background_color` (green) briefly at launch; custom splash images need
  per-device-size assets and aren't included.

## Develop locally

```
python3 -m http.server 8000      # then open http://localhost:8000  (service worker works on localhost)
node --test tests/calc.test.mjs  # unit tests for the maths and USDA parsing
node scripts/make-icons.mjs      # regenerate icons
```

## Layout

```
index.html, manifest.json, sw.js
css/style.css
js/app.js   UI + screens        js/calc.js  pure maths/units/dates (unit-tested)
js/db.js    IndexedDB           js/fdc.js   USDA API client + normalisation
icons/      generated PNGs      scripts/    icon generator        tests/
```

Barcode scanning can be added later without restructuring: `fdc.js` already supports lookup by `fdcId`, and
Branded foods carry a UPC (`gtinUpc`) that a scanner could search on.
