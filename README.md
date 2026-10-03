# Macro Tracker

A personal, single-user PWA for tracking calories and protein (carbs/fat shown too).
Plain HTML/CSS/JS with ES modules, **no build step**. Data lives in IndexedDB on each device.

**Features:** USDA FoodData Central search · recipe builder (g, oz, lb, cup, tbsp, tsp, USDA portions) ·
weight-based portions (cooked weight → macros per gram → plate weight) · four-meal daily log with day
navigation · daily goals with progress · barcode scanning (USDA, then Open Food Facts) · JSON backup/restore ·
offline app shell.

## How the portion maths works

1. A recipe's raw ingredients are summed into total kcal/protein/carbs/fat.
2. Each time you cook it you enter the **total cooked weight**. Macros per gram = recipe total ÷ cooked weight.
   (Field starts empty; a "Use last cooked weight" button reuses the previous one.)
3. You enter the **plate weight**; logged macros = plate weight × macros per gram.

Standalone foods are logged the same way using the food's per-100 g values.

## Barcode scanning

**Food Search → Scan barcode** opens the rear camera. It reads UPC-A, UPC-E, EAN-13 and EAN-8. The camera
stops as soon as a code is read, or when you cancel or leave the app. **Type barcode instead** lets you key in
the digits.

Lookup order:
1. USDA FoodData Central, Branded foods, searched by the barcode digits. A result only counts if its `gtinUpc`
   matches after stripping leading zeros on both sides (FDC mixes 12-, 13- and 14-digit forms). UPC-E codes
   are expanded to UPC-A first.
2. If USDA has no match, [Open Food Facts](https://world.openfoodfacts.org) (no key needed). These products are
   labelled "Source: Open Food Facts".
3. If neither source has it, the app says so and offers name search, another scan, or typing the code.

The product opens in the normal food sheet, so you log it by weight or add it to a recipe exactly like a
searched food.

**Camera notes:**
- Camera access requires **HTTPS**. GitHub Pages is fine, and `localhost` works for development. Over plain
  `http://` on a LAN IP the scanner shows a message and you can still type the code.
- iOS asks for camera permission separately in Safari and in the **installed Home Screen app**. The installed
  app may ask again on later launches; that's normal iOS behaviour for web apps.
- If you tapped "Don't Allow": iOS **Settings → Apps → Safari → Camera** (Settings → Safari → Camera on older
  iOS), set it to Ask or Allow, then reopen the app.
- The scanner library (ZXing, Apache-2.0) is vendored in `vendor/`, loaded only when you scan, and cached by the
  service worker so the scanner opens offline. Lookups still need a connection.

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
node --test tests/*.test.mjs     # unit tests: maths, USDA parsing, barcode + Open Food Facts mapping
node scripts/make-icons.mjs      # regenerate icons
```

## Layout

```
index.html, manifest.json, sw.js
css/style.css
js/app.js   UI + screens        js/calc.js  pure maths/units/dates (unit-tested)
js/db.js    IndexedDB           js/fdc.js   USDA API client + normalisation
js/barcode.js  barcode normalisation + USDA/Open Food Facts lookup (unit-tested)
js/scanner.js  camera scan view (ZXing)
vendor/     vendored ZXing bundle (see vendor/README.md)
icons/      generated PNGs      scripts/    icon generator        tests/ (+ fixtures/)
```
