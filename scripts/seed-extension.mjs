#!/usr/bin/env node
// 把 CLI 已经判好的缓存灌进扩展，首次加载就能立刻生效，不用重新调 JEV。
// 只保留当前格式的条目：RULE_VERSION 一变，缓存键全变，旧条目永远命不中，留着白占体积。
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPOILER, RULE_VERSION } from '../src/core/rules.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(ROOT, '.cache/bili-danmaku.json');
const target = join(ROOT, 'apps/extension/seed.json');

try {
  const raw = JSON.parse(await readFile(source, 'utf8'));
  // score 规则写 v(严重度)，noul 规则写 s，早期 choice 规则写 f —— 只留当前规则能用的那种。
  const key = { score: 'v', noul: 's', choice: 'f' }[SPOILER.type];
  const kept = {};
  let dropped = 0;
  for (const [hash, entry] of Object.entries(raw)) {
    if (entry && typeof entry[key] === 'number') kept[hash] = entry;
    else dropped += 1;
  }
  await writeFile(target, JSON.stringify(kept));
  const { size } = await stat(target);
  console.log(`✓ seed.json：保留 ${Object.keys(kept).length} 条（RULE_VERSION ${RULE_VERSION} / ${SPOILER.type}），丢弃 ${dropped} 条旧格式，${(size / 1024).toFixed(0)} KB`);
} catch (error) {
  console.error(`✗ 先跑一次 CLI 生成缓存：${error.message}`);
  process.exitCode = 1;
}
