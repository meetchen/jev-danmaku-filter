import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodeSegment, readFields } from '../src/adapters/bilibili/protobuf.js';

const CODE = readFileSync(new URL('../apps/extension/page.js', import.meta.url), 'utf8');
const XML_BYTES = new Uint8Array(readFileSync(new URL('./fixtures/dm-list.deflate', import.meta.url)));
const SEG_BYTES = new Uint8Array(readFileSync(new URL('./fixtures/seg1.bin', import.meta.url)));

const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
// 隔离世界生成的握手令牌；MAIN world 只接受携带它的消息。
const TOKEN = 'test-token-0123456789abcdef';
const bytesResponse = (bytes, type) => new Response(bytes, { status: 200, headers: { 'content-type': type } });

// 在 Node 沙箱里跑打包后的 MAIN world 脚本，只用 postMessage 与它交互。
function createPage({ href, fetchImpl }) {
  const listeners = new Map();
  const outgoing = [];
  const location = { origin: 'https://www.bilibili.com', href, pathname: new URL(href).pathname, search: new URL(href).search };
  const win = {
    fetch: fetchImpl,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    postMessage(data) { outgoing.push(data); },
  };
  class FakeXHR { get response() { return this._response; } }
  const sandbox = {
    window: win, location, document: { title: '文档标题' }, XMLHttpRequest: FakeXHR,
    TextDecoder, TextEncoder, URL, URLSearchParams, Blob, DecompressionStream, Response, Request,
    setTimeout, clearTimeout, queueMicrotask, console,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return {
    window: win,
    outgoing,
    send(packet) {
      for (const fn of listeners.get('message') || []) {
        fn({ source: win, origin: location.origin, data: { __jev: true, channel: 'jev-danmaku', token: TOKEN, ...packet } });
      }
      return this;
    },
    // 真实流程里隔离世界会先发 hello（带随机令牌），page 收到后才开始改写播放器的响应。
    async handshake() {
      this.send({ kind: 'hello' });
      await this.waitFor(m => m.kind === 'hello-ack');
    },
    // 页面上其他脚本可以调 window.postMessage，所以不带令牌/带错令牌的消息必须被忽略。
    forge(packet) {
      for (const fn of listeners.get('message') || []) {
        fn({ source: win, origin: location.origin, data: { __jev: true, channel: 'jev-danmaku', ...packet } });
      }
    },
    async waitFor(predicate, ms = 3000) {
      const started = Date.now();
      while (Date.now() - started < ms) {
        const found = outgoing.find(predicate);
        if (found) return found;
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error(`等待消息超时，已收到：${JSON.stringify(outgoing).slice(0, 400)}`);
    },
  };
}

test('番剧页没有 __INITIAL_STATE__，改走 pgc 接口并预热弹幕', async () => {
  const requested = [];
  const page = createPage({
    href: 'https://www.bilibili.com/bangumi/play/ep403700?spm_id_from=333.1007.partition_recommend.content.click&from_spmid=666.25.episode.0',
    fetchImpl: async url => {
      const target = String(url);
      requested.push(target);
      if (target.includes('/pgc/view/web/season')) {
        return jsonResponse({ code: 0, result: { title: '白色巨塔', evaluate: '剧情简介', episodes: [{ id: 403700, cid: 436715683, aid: 333053359, bvid: 'BV1jA411G7pr', title: '9', duration: 2778000 }] } });
      }
      if (target.includes('/x/v1/dm/list.so')) return bytesResponse(XML_BYTES, 'text/xml');
      throw new Error(`未预期的请求 ${target}`);
    },
  });

  await page.handshake();
  page.send({ kind: 'prepare', id: 1 });
  const reply = await page.waitFor(m => m.kind === 'reply' && m.id === 1);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.video.kind, 'bangumi');
  assert.equal(reply.result.video.cid, 436715683);
  assert.equal(reply.result.video.duration, 2778, 'pgc 的 duration 是毫秒，必须换算成秒');
  assert.match(reply.result.video.title, /白色巨塔/);
  assert.ok(requested.some(u => u.includes('pgc/view/web/season?ep_id=403700')));
  assert.ok(requested.some(u => u.includes('list.so?oid=436715683')));
  assert.ok(reply.result.texts.length > 100, `预热应拿到弹幕文本，实际 ${reply.result.texts.length}`);
});

test('普通视频页走 view 接口，并按 ?p= 取对应分 P', async () => {
  const page = createPage({
    href: 'https://www.bilibili.com/video/BV1AzYs6bEeX?p=2',
    fetchImpl: async url => {
      const target = String(url);
      if (target.includes('/x/web-interface/view')) {
        return jsonResponse({ code: 0, data: { bvid: 'BV1AzYs6bEeX', aid: 1, cid: 11, title: '标题', desc: '简介', duration: 100, pages: [{ cid: 11, part: 'P1', duration: 100 }, { cid: 22, part: 'P2', duration: 200 }] } });
      }
      if (target.includes('/x/v1/dm/list.so')) return bytesResponse(XML_BYTES, 'text/xml');
      throw new Error(`未预期的请求 ${target}`);
    },
  });
  await page.handshake();
  page.send({ kind: 'prepare', id: 2 });
  const reply = await page.waitFor(m => m.kind === 'reply' && m.id === 2);
  assert.equal(reply.result.video.cid, 22, 'p=2 必须取第 2 个分 P 的 cid');
  assert.equal(reply.result.video.duration, 200);
  assert.match(reply.result.video.title, /P2/);
});

test('单 P 视频的标题不会被拼成「标题 · 标题」', async () => {
  const page = createPage({
    href: 'https://www.bilibili.com/video/BV1AzYs6bEeX',
    fetchImpl: async url => {
      const target = String(url);
      if (target.includes('/x/web-interface/view')) {
        return jsonResponse({ code: 0, data: { bvid: 'BV1AzYs6bEeX', aid: 1, cid: 2, title: '某个视频标题', desc: '', duration: 100, videos: 1, pages: [{ cid: 2, part: '某个视频标题', duration: 100 }] } });
      }
      if (target.includes('/x/v1/dm/list.so')) return bytesResponse(XML_BYTES, 'text/xml');
      throw new Error(`未预期的请求 ${target}`);
    },
  });
  await page.handshake();
  page.send({ kind: 'prepare', id: 3 });
  const reply = await page.waitFor(m => m.kind === 'reply' && m.id === 3);
  assert.equal(reply.result.video.title, '某个视频标题');
});

test('改写 seg.so 响应：命中弹幕被剔除，判定前的分段原样放行', async () => {
  const page = createPage({
    href: 'https://www.bilibili.com/video/BV1AzYs6bEeX',
    fetchImpl: async url => {
      const target = String(url);
      if (target.includes('/x/web-interface/view')) {
        return jsonResponse({ code: 0, data: { bvid: 'BV1AzYs6bEeX', aid: 1, cid: 2, title: '标题', desc: '', duration: 1031, pages: [{ cid: 2, part: 'P1', duration: 1031 }] } });
      }
      if (target.includes('/x/v1/dm/list.so')) return bytesResponse(XML_BYTES, 'text/xml');
      if (target.includes('/x/v2/dm/web/seg.so')) return bytesResponse(SEG_BYTES, 'application/octet-stream');
      throw new Error(`未预期的请求 ${target}`);
    },
  });

  const segmentUrl = 'https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=2&segment_index=1';
  await page.handshake();
  const all = decodeSegment(SEG_BYTES);
  const target = all[0].text;
  const otherFields = buffer => readFields(buffer).filter(f => f.field !== 1).map(f => [...buffer.subarray(f.start, f.end)]);

  // 判定完成前：原样放行
  const before = new Uint8Array(await (await page.window.fetch(segmentUrl)).arrayBuffer());
  assert.equal(before.length, SEG_BYTES.length, '判定完成前不应改写响应');

  // 下发判定结果（其余文本标记为已问过，避免触发 need 往返）
  page.send({ kind: 'verdicts', blocked: [target], judged: all.map(item => item.text) });

  const after = new Uint8Array(await (await page.window.fetch(segmentUrl)).arrayBuffer());
  const survivors = decodeSegment(after);
  assert.equal(survivors.length, all.length - 1);
  assert.ok(!survivors.some(item => item.text === target));
  assert.deepEqual(otherFields(after), otherFields(SEG_BYTES), '非弹幕字段必须逐字节保留');
});

test('分段里有没判过的文本时会向隔离世界要结果', async () => {
  const page = createPage({
    href: 'https://www.bilibili.com/video/BV1AzYs6bEeX',
    fetchImpl: async url => {
      const target = String(url);
      if (target.includes('/x/v2/dm/web/seg.so')) return bytesResponse(SEG_BYTES, 'application/octet-stream');
      throw new Error(`未预期的请求 ${target}`);
    },
  });
  await page.handshake();
  const segmentUrl = 'https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=2&segment_index=1';
  const pending = page.window.fetch(segmentUrl);
  const need = await page.waitFor(m => m.kind === 'need');
  assert.ok(need.texts.length > 0);
  page.send({ kind: 'need-result', id: need.id, blocked: [need.texts[0]] });
  const after = new Uint8Array(await (await pending).arrayBuffer());
  assert.equal(decodeSegment(after).length, decodeSegment(SEG_BYTES).length - 1);
});


test('安全：握手之后，页面上其他脚本伪造的无令牌消息一律被忽略', async () => {
  const page = createPage({
    href: 'https://www.bilibili.com/video/BV1AzYs6bEeX',
    fetchImpl: async url => {
      const target = String(url);
      if (target.includes('/x/v2/dm/web/seg.so')) return bytesResponse(SEG_BYTES, 'application/octet-stream');
      throw new Error(`未预期的请求 ${target}`);
    },
  });
  const segmentUrl = 'https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=2&segment_index=1';
  const all = decodeSegment(SEG_BYTES).map(item => item.text);
  const replies = () => page.outgoing.filter(m => m.kind === 'reply').length;

  await page.handshake();
  // 先把这些文本标记为"已问过"且都不屏蔽，这样下面就绪后 fetch 不会再触发 need 往返。
  page.send({ kind: 'verdicts', blocked: [], judged: all });

  // 页面脚本能拿到 channel 名（开源代码里写死的），但拿不到握手令牌。
  // 不带令牌的伪造消息必须全部无效：
  page.forge({ kind: 'verdicts', blocked: all });          // 想把整屏弹幕屏蔽掉
  page.forge({ kind: 'need-result', id: 1, blocked: all }); // 想污染判定结果
  page.forge({ kind: 'prepare', id: 99 });                  // 想让插件花用户额度判定整片
  assert.equal(replies(), 0, '伪造的 prepare 不应产生任何 reply');

  const raw = new Uint8Array(await (await page.window.fetch(segmentUrl)).arrayBuffer());
  assert.equal(raw.length, SEG_BYTES.length, '伪造的 verdicts 不能改变分段内容');

  // 同一批文本，带上正确令牌立刻生效
  page.send({ kind: 'verdicts', blocked: [all[0]] });
  const after = new Uint8Array(await (await page.window.fetch(segmentUrl)).arrayBuffer());
  assert.equal(decodeSegment(after).length, all.length - 1, '合法令牌的 verdicts 必须生效');
});

test('安全：令牌太短或试图改密时忽略', async () => {
  const page = createPage({
    href: 'https://www.bilibili.com/video/BV1AzYs6bEeX',
    fetchImpl: async () => { throw new Error('不应发出请求'); },
  });
  page.forge({ kind: 'hello', token: 'short' });
  assert.equal(page.outgoing.filter(m => m.kind === 'hello-ack').length, 0, '过短的令牌必须被拒绝');

  await page.handshake();
  page.forge({ kind: 'hello', token: 'another-token-0123456789abcdef' });
  assert.equal(page.outgoing.filter(m => m.kind === 'hello-ack').length, 1, '不允许改密重新握手');
});
