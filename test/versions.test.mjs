import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('扩展不含远程脚本或过分宽泛的权限', () => {
  const manifest = read('apps/extension/manifest.json');
  assert.deepEqual(manifest.permissions, ['storage'], '权限不该悄悄变多');
  assert.ok(!(manifest.host_permissions ?? []).some(host => /\/\*\/\*$|\*:\/\//.test(host) || host === '<all_urls>'), '不该申请全站权限');
  const remote = [...(manifest.content_scripts ?? [])].flatMap(entry => entry.js ?? []).filter(file => /^https?:/.test(file));
  assert.deepEqual(remote, [], 'content script 不该引用远程脚本（MV3 也不允许）');
});
