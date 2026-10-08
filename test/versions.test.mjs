import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

test('package.json 与 manifest.json 的版本号必须一致', () => {
  const pkg = read('package.json');
  const manifest = read('apps/extension/manifest.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json 版本号必须是 x.y.z');
  assert.equal(manifest.version, pkg.version, '发版时两个版本号必须同步，否则 release 流程会产出对不上号的包');
});

test('manifest 引用的文件都在仓库里', () => {
  const manifest = read('apps/extension/manifest.json');
  const files = [
    ...(manifest.content_scripts ?? []).flatMap(entry => [...(entry.js ?? []), ...(entry.css ?? [])]),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.background?.service_worker,
    manifest.action?.default_popup,
  ].filter(Boolean);
  for (const file of files) {
    assert.doesNotThrow(() => readFileSync(new URL(`../apps/extension/${file}`, import.meta.url)), `manifest 引用了不存在的 ${file}`);
  }
});

test('权限与主机范围是明确列举的，不是偷偷放宽', () => {
  const manifest = read('apps/extension/manifest.json');
  assert.deepEqual(manifest.permissions, ['storage'], '权限不该悄悄变多');
  assert.deepEqual(manifest.host_permissions, [
    'https://api.typesafe.ai/*',
    'https://*.maas.aliyuncs.com/*',
  ], '固定 host 权限只应包含内置的判定后端，加厂商时同步更新这条断言');
  // 自定义后端需要任意主机，但必须是 optional，由用户在面板里当场授权，不能默认拿到。
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*'],
    'https://*/* 只能出现在 optional_host_permissions 里');
  assert.ok(!('host_permissions' in manifest && manifest.host_permissions.includes('<all_urls>')));

  const remote = [...(manifest.content_scripts ?? [])].flatMap(entry => entry.js ?? []).filter(file => /^https?:/.test(file));
  assert.deepEqual(remote, [], 'content script 不该引用远程脚本（MV3 也不允许）');
});

test('扩展里的相对 import 全部能解析到实际文件', () => {
  // 构建时会把 src/ 下的模块复制进 vendor/，漏复制一个就只在运行时炸。
  // popup.js / background.js 是 ES module 且只在扩展加载时才求值，所以必须有静态检查。
  const root = resolve('apps/extension');
  const walk = dir => readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith('.js') ? [full] : [];
  });

  const problems = [];
  for (const file of walk(root)) {
    // page.js / content.js 是拼好的经典脚本，不含 import
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s+'(\.\/[^']+)'/g)) {
      const target = resolve(dirname(file), match[1]);
      if (!existsSync(target)) problems.push(`${file.slice(root.length + 1)} → ${match[1]}`);
    }
  }
  assert.deepEqual(problems, [], `这些 import 指向不存在的文件：${problems.join(', ')}`);
});
