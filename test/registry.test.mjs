import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { composeBundle } from '../scripts/bundle.mjs';
import { createRegistry } from '../src/sites/registry.js';
import { SITES } from '../src/sites/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'registry-test-token-0123456789';
const FAKE_URL = 'https://fake.example/watch/1';
const DANMAKU_URL = 'https://fake.example/fake/danmaku.json';
const PAYLOAD = new TextEncoder().encode(JSON.stringify([
  { text: '这条是该屏蔽的', at: 1 }, { text: '这条是正常的', at: 2 },
]));

test('注册表：按顺序匹配，没有站点接管时返回 null', () => {
  const registry = createRegistry([
    { id: 'a', matches: () => false },
    { id: 'b', matches: href => href.includes('b') },
  ]);
  assert.equal(registry.find('xxbxx').id, 'b');
  assert.equal(registry.find('xxx'), null);
});

test('注册表：单个站点匹配抛错不影响其他站点', () => {
  const registry = createRegistry([
    { id: 'boom', matches: () => { throw new Error('坏了'); } },
    { id: 'ok', matches: () => true },
  ]);
  assert.equal(registry.find('whatever').id, 'ok');
});

test('真实注册表认识 B 站页面，不认识别的站点', () => {
  const registry = createRegistry(SITES);
  assert.equal(registry.find('https://www.bilibili.com/video/BV1AzYs6bEeX').id, 'bilibili');
  assert.equal(registry.find('https://www.bilibili.com/bangumi/play/ep403700').id, 'bilibili');
  assert.equal(registry.find('https://www.bilibili.com/'), null, '首页不该被接管');
  assert.equal(registry.find('https://example.com/video/1'), null);
});

// 用假站点拼一个 page.js：证明加站点只写描述符，不用碰通信层。
async function createFakePage(href) {
  const bundle = await composeBundle(ROOT, [
    'src/sites/registry.js',
    'test/fixtures/fake-site.js',
    { label: 'fake-registry', inline: 'const SITES = [fakeSite];\nconst findSite = createRegistry(SITES).find;' },
    'apps/extension/src/page-runtime.js',
  ]);
  const listeners = [];
  const outgoing = [];
  const location = { origin: new URL(href).origin, href, pathname: new URL(href).pathname, search: '' };
  const win = {
    fetch: async () => new Response(PAYLOAD, { status: 200, headers: { 'content-type': 'application/json' } }),
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: data => outgoing.push(data),
  };
  class FakeXHR { get response() { return null; } }
  const sandbox = {
    window: win, location, document: { title: '假文档' }, XMLHttpRequest: FakeXHR,
    TextDecoder, TextEncoder, URL, URLSearchParams, Blob, DecompressionStream, Response, Request,
    setTimeout, clearTimeout, queueMicrotask, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);

  const send = packet => listeners.forEach(fn => fn({
    source: win, origin: location.origin, data: { __jev: true, channel: 'jev-danmaku', token: TOKEN, ...packet },
  }));
  const waitFor = async (predicate, ms = 3000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const found = outgoing.find(predicate);
      if (found) return found;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`等待超时，已收到：${JSON.stringify(outgoing).slice(0, 300)}`);
  };
  return { win, outgoing, send, waitFor };
}

test('假站点：通信层没改一行，光靠描述符就跑通了全流程', async () => {
  const page = await createFakePage(FAKE_URL);

  page.send({ kind: 'hello' });
  const ack = await page.waitFor(m => m.kind === 'hello-ack');
  assert.equal(ack.site, 'fake', 'hello-ack 要带上接管页面的站点 id');
  assert.equal(ack.domSelector, '.fake-danmaku', 'DOM 兜底选择器来自描述符');

  page.send({ kind: 'prepare', id: 1 });
  const reply = await page.waitFor(m => m.kind === 'reply' && m.id === 1);
  assert.equal(reply.result.video.source, 'fake');
  assert.equal(reply.result.video.cid, 'vid-1');
  assert.deepEqual([...reply.result.texts], ['预热文本甲', '预热文本乙']);
  assert.equal(reply.result.domSelector, '.fake-danmaku');

  // JSON 响应也要能被改写掉，说明链路不依赖 protobuf
  page.send({ kind: 'verdicts', blocked: ['这条是该屏蔽的'], judged: ['这条是该屏蔽的', '这条是正常的'] });
  const filtered = new Uint8Array(await (await page.win.fetch(DANMAKU_URL)).arrayBuffer());
  const kept = JSON.parse(new TextDecoder().decode(filtered));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, '这条是正常的');
});

test('假站点：不属于它的响应一律原样放行', async () => {
  const page = await createFakePage(FAKE_URL);
  page.send({ kind: 'hello' });
  await page.waitFor(m => m.kind === 'hello-ack');
  page.send({ kind: 'verdicts', blocked: ['这条是该屏蔽的'], judged: ['这条是该屏蔽的', '这条是正常的'] });

  const untouched = new Uint8Array(await (await page.win.fetch('https://fake.example/other/api.json')).arrayBuffer());
  assert.deepEqual([...untouched], [...PAYLOAD], '非弹幕响应必须逐字节原样返回');

  const noNeed = page.outgoing.filter(m => m.kind === 'need');
  assert.equal(noNeed.length, 0, '不属于站点的响应不该触发判定往返');
});

test('站点不匹配时，运行时完全不干预网络', async () => {
  const page = await createFakePage('https://fake.example/about');
  page.send({ kind: 'hello' });
  const ack = await page.waitFor(m => m.kind === 'hello-ack');
  assert.equal(ack.site, null, '没有站点接管时应明确回 null');
  assert.equal(page.win.fetch.name, 'fetch', '匹配失败时不该替换 window.fetch');
});
