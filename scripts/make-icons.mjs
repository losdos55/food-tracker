// Generates the app icons (pure Node, no dependencies): node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Full-bleed (no transparency, no rounded corners: iOS rounds it) green gradient with a "plate".
const WHITE = [255, 255, 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function sample(u, v) { // u,v in 0..1
  const bg = mix([52, 179, 106], [30, 118, 70], v);
  const d = Math.hypot(u - 0.5, v - 0.5);
  if (d < 0.2) return WHITE;
  if (d < 0.27) return mix([52, 179, 106], [30, 118, 70], v);
  if (d < 0.34) return WHITE;
  return bg;
}
const SS = 3;
const pixel = (x, y, size) => {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
    const [pr, pg, pb] = sample((x + (i + 0.5) / SS) / size, (y + (j + 0.5) / SS) / size);
    r += pr; g += pg; b += pb;
  }
  const n = SS * SS;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
};

for (const [name, size] of [['icon-192', 192], ['icon-512', 512], ['apple-touch-icon', 180], ['favicon-32', 32]]) {
  writeFileSync(new URL(`../icons/${name}.png`, import.meta.url), png(size, pixel));
  console.log('wrote', name);
}
