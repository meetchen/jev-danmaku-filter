#!/usr/bin/env node
// 零依赖构建：把纯逻辑模块复制进扩展目录，并把 MAIN world / content script 需要的模块
// 拼成一个经典脚本（内容脚本不支持 ES module，所以只能拼）。
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(ROOT, 'apps/extension');

// content script 不能 import，所以去掉模块语法后按顺序拼接，整体包一层 IIFE 避免污染页面全局。
function stripModuleSyntax(source) {
  return source
    .replace(/^\s*import\s[^;]*;\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*(?:from\s*'[^']*')?\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '');
}

async function bundle(output, sources) {
  const parts = [];
  for (const relative of sources) {
    parts.push(`/* ---- ${relative} ---- */\n${stripModuleSyntax(await readFile(join(ROOT, relative), 'utf8'))}`);
  }
  await writeFile(join(EXT, output), `(() => {\n${parts.join('\n\n')}\n})();\n`);
  return output;
}

const CORE = ['rules.js', 'tokens.js', 'hash.js', 'memory.js', 'jev.js', 'batch.js'];
const BILI = ['protobuf.js', 'xml.js', 'urls.js'];

await rm(join(EXT, 'vendor'), { recursive: true, force: true });
await mkdir(join(EXT, 'vendor/core'), { recursive: true });
await mkdir(join(EXT, 'vendor/adapters/bilibili'), { recursive: true });

for (const file of CORE) {
  await copyFile(join(ROOT, 'src/core', file), join(EXT, 'vendor/core', file));
}
for (const file of BILI) {
  await copyFile(join(ROOT, 'src/adapters/bilibili', file), join(EXT, 'vendor/adapters/bilibili', file));
}

const built = [
  await bundle('page.js', [
    'src/adapters/bilibili/protobuf.js',
    'src/adapters/bilibili/xml.js',
    'src/adapters/bilibili/urls.js',
    'apps/extension/src/page-runtime.js',
  ]),
  await bundle('content.js', ['apps/extension/src/content-runtime.js']),
];

for (const file of built) {
  const { size } = await (await import('node:fs/promises')).stat(join(EXT, file));
  console.log(`  ${file.padEnd(12)} ${(size / 1024).toFixed(1)} KB`);
}
console.log(`✓ 扩展已构建到 apps/extension，Chrome 里加载这个目录`);
