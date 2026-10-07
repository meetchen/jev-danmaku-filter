#!/usr/bin/env node
// 零依赖生成扩展图标。手写 PNG 编码器（IHDR/IDAT/IEND + CRC32），4 倍超采样抗锯齿。
// 图形语义：绿色圆角方块 + 三条弹幕条，中间那条被切断 = 被过滤掉的那条。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'apps/extension/icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const BACKGROUND = [0x2f, 0x8f, 0x5f];
const BARS = [
  { y: 0.28, from: 0.20, to: 0.80, color: [0xff, 0xff, 0xff] },
  // 中间这条只画一半，右半截留空 —— 被过滤掉的那条弹幕。
  { y: 0.50, from: 0.20, to: 0.50, color: [0xff, 0xff, 0xff] },
  { y: 0.72, from: 0.20, to: 0.68, color: [0xcf, 0xe9, 0xda] },
];
const BAR_HEIGHT = 0.10;

// 圆角矩形内部判定，坐标已归一化到 0~1。
function insideRoundedRect(x, y) {
  const radius = 0.22;
  if (x >= radius && x <= 1 - radius) return true;
  if (y >= radius && y <= 1 - radius) return true;
  const cx = x < radius ? radius : 1 - radius;
  const cy = y < radius ? radius : 1 - radius;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insideBar(x, y, bar) {
  const half = BAR_HEIGHT / 2;
  return y >= bar.y - half && y <= bar.y + half && x >= bar.from && x <= bar.to;
}

/** 在 px,py（超采样坐标）处取样，返回 [r,g,b,a]。 */
function sample(x, y) {
  if (!insideRoundedRect(x, y)) return [0, 0, 0, 0];
  for (const bar of BARS) {
    if (insideBar(x, y, bar)) return [...bar.color, 255];
  }
  return [...BACKGROUND, 255];
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // color type RGBA
  // 每行前面加一个 filter byte（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const [pr, pg, pb, pa] = sample((x * SUPERSAMPLE + sx + 0.5) * step, (y * SUPERSAMPLE + sy + 0.5) * step);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const total = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (y * size + x) * 4;
      // 按 alpha 加权还原颜色，避免透明边缘出现黑边
      pixels[offset] = a ? Math.round(r / a) : 0;
      pixels[offset + 1] = a ? Math.round(g / a) : 0;
      pixels[offset + 2] = a ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round(a / total);
    }
  }
  return pixels;
}

/** 只读回自己写出来的 PNG（RGBA、filter=None），够用于校验。 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let offset = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  if (colorType !== 6) throw new Error(`只支持 RGBA，实际 colorType=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    if (raw[rowStart] !== 0) throw new Error('只支持 filter=None');
    raw.copy(pixels, y * stride, rowStart + 1, rowStart + 1 + stride);
  }
  return { width, height, pixels };
}

const check = process.argv.includes('--check');

await mkdir(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `${size}.png`);
  const expected = renderPixels(size);

  if (check) {
    // 只比像素，不比字节 —— deflateSync 的输出会随 zlib 版本变化，
    // 用 git diff 比字节会在别的 Node 版本上误报。
    let actual;
    try {
      actual = decodePng(await readFile(file));
    } catch (error) {
      throw new Error(`${file}: 读不出来（${error.message}）。文件可能被改过或损坏，跑 npm run icons 重新生成。`);
    }
    if (actual.width !== size || actual.height !== size) throw new Error(`${file}: 尺寸是 ${actual.width}×${actual.height}，期望 ${size}×${size}`);
    if (!actual.pixels.equals(expected)) throw new Error(`${file}: 像素内容与脚本渲染结果不一致，请本地跑 npm run icons 后提交`);
    console.log(`  icons/${size}.png  ✓ 像素一致`);
    continue;
  }
  await writeFile(file, encodePng(size, expected));
  console.log(`  icons/${size}.png`);
}
console.log(check ? '✓ 图标校验通过' : '✓ 图标已生成（像素内容确定；字节取决于 zlib 版本，故校验像素而非字节）');
