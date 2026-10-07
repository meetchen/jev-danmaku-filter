#!/usr/bin/env node
// 构建扩展：把纯逻辑模块复制进扩展目录，并把需要经典脚本的两处拼起来。
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_SOURCES, composeBundle } from './bundle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(ROOT, 'apps/extension');

// background.js 是 ES module，可以直接 import；需要复制的就是它依赖的那些纯逻辑模块。
const CORE = ['rules.js', 'tokens.js', 'hash.js', 'memory.js', 'jev.js', 'batch.js'];

await rm(join(EXT, 'vendor'), { recursive: true, force: true });
await mkdir(join(EXT, 'vendor/core'), { recursive: true });
for (const file of CORE) await copyFile(join(ROOT, 'src/core', file), join(EXT, 'vendor/core', file));

await writeFile(join(EXT, 'page.js'), await composeBundle(ROOT, PAGE_SOURCES));
await writeFile(join(EXT, 'content.js'), await composeBundle(ROOT, ['apps/extension/src/content-runtime.js']));

for (const file of ['page.js', 'content.js']) {
  const { size } = await stat(join(EXT, file));
  console.log(`  ${file.padEnd(12)} ${(size / 1024).toFixed(1)} KB`);
}
console.log('✓ 扩展已构建到 apps/extension，Chrome 里加载这个目录');
