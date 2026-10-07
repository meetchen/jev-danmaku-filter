#!/usr/bin/env node
// 显式测试入口。不用 `node --test` 的自动发现，因为它的默认规则含 `**/test/**/*.js`，
// 会把 test/fixtures/ 下的辅助文件也当测试跑；也不用 `node --test test/`，
// 那个写法在 Node 20/22 上会把目录当模块加载而报 MODULE_NOT_FOUND。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(ROOT, 'test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name));

if (!files.length) {
  console.error('✗ test/ 下没有找到 *.test.mjs');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status ?? 1);
