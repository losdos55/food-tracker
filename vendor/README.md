# Vendored libraries

`zxing-browser.esm.js` contains `@zxing/browser@0.2.1` and `@zxing/library@0.23.0` (Apache-2.0, see
`ZXING-LICENSE.txt`). It's vendored so the app needs no CDN and the scanner works offline. iOS Safari has no
native `BarcodeDetector`. It is only loaded when the scanner opens.

To regenerate:

```
npm i @zxing/browser@0.2.1 @zxing/library@0.23.0 esbuild
printf "export { BrowserMultiFormatReader } from '@zxing/browser';\nexport { BarcodeFormat, DecodeHintType } from '@zxing/library';\n" > entry.js
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=eof --outfile=zxing-browser.esm.js
```
