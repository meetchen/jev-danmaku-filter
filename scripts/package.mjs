#!/usr/bin/env node
// 打包可上传/可安装的扩展 zip。
// 强制排除 seed.json（本地测试用的预判缓存，只对特定视频有意义）和 src/（构建源，包内不需要）。
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(ROOT, 'apps/extension');
const OUT = join(ROOT, 'out');
const STAGE = join(OUT, 'package');
const MANIFEST = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
const NAME = `jev-danmaku-filter-v${MANIFEST.version}.zip`;
const EXCLUDE = new Set(['seed.json', 'src']);

// 先重新构建，保证打包的是最新源码
execFileSync(process.execPath, [join(ROOT, 'scripts/build-extension.mjs')], { stdio: 'inherit' });

// 校验 manifest 引用的文件都存在 —— 少一个文件 Chrome 就直接拒绝加载
const referenced = new Set(['manifest.json']);
for (const entry of MANIFEST.content_scripts ?? []) {
  for (const file of [...(entry.js ?? []), ...(entry.css ?? [])]) referenced.add(file);
}
for (const file of Object.values(MANIFEST.icons ?? {})) referenced.add(file);
for (const file of Object.values(MANIFEST.action?.default_icon ?? {})) referenced.add(file);
if (MANIFEST.background?.service_worker) referenced.add(MANIFEST.background.service_worker);
if (MANIFEST.action?.default_popup) referenced.add(MANIFEST.action.default_popup);

const missing = [];
for (const file of referenced) {
  try { await stat(join(EXT, file)); } catch { missing.push(file); }
}
if (missing.length) {
  console.error(`✗ manifest 引用了不存在的文件：${missing.join(', ')}`);
  process.exit(1);
}
console.log(`  已校验 manifest 引用的 ${referenced.size} 个文件都存在`);

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
await cp(EXT, STAGE, {
  recursive: true,
  filter: source => !EXCLUDE.has(source.slice(EXT.length + 1).split('/')[0]),
});

const present = await stat(join(STAGE, 'seed.json')).then(() => true, () => false);
if (present) { console.error('✗ seed.json 泄漏进包了'); process.exit(1); }

await writeFile(join(OUT, '.keep'), '');
execFileSync('zip', ['-r', '-q', '-X', join(OUT, NAME), '.'], { cwd: STAGE });
const { size } = await stat(join(OUT, NAME));
console.log(`✓ out/${NAME}  ${(size / 1024).toFixed(0)} KB（已排除 seed.json 与 src/）`);
