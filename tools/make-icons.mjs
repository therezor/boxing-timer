// Renders icons/icon.svg's design to PNG with no dependencies: each shape is a
// point test in a 100×100 space, sampled 4×4 per pixel for anti-aliasing.
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [17, 17, 17];
const RED = [220, 38, 38];
const GREEN = [34, 197, 94];
const WHITE = [245, 245, 245];

const CX = 50;
const CY = 56;
const HAND = [69.05, 67];

const inRoundRect = (x, y, x0, y0, w, h, r) => {
  const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r));
  const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r));
  return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h && dx * dx + dy * dy <= r * r;
};

function distToSegment(x, y, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

// Topmost shape first, matching the SVG's paint order in reverse.
function colorAt(x, y) {
  const d = Math.hypot(x - CX, y - CY);
  if (d <= 4.5) return WHITE;
  if (distToSegment(x, y, [CX, CY], HAND) <= 2) return WHITE;
  if (Math.abs(d - 28) <= 3) return RED;
  // Wedge from 12 o'clock clockwise to 120°.
  const angle = (Math.atan2(x - CX, -(y - CY)) * 180) / Math.PI;
  if (d <= 22 && angle >= 0 && angle <= 120) return GREEN;
  if (inRoundRect(x, y, 42, 15, 16, 9, 2.5) || inRoundRect(x, y, 47, 22, 6, 5, 0)) return RED;
  return BG;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const S = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    const row = py * (size * 3 + 1);
    raw[row] = 0;
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = colorAt(((px + (sx + 0.5) / S) * 100) / size, ((py + (sy + 0.5) / S) * 100) / size);
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
      }
      for (let i = 0; i < 3; i++) raw[row + 1 + px * 3 + i] = Math.round(sum[i] / (S * S));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../icons/', import.meta.url);
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL(name, dir), png(size));
  console.log('wrote', name);
}
