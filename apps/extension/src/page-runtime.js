/* MAIN world。运行在 B 站页面自己的 JS 上下文里，因此：
   1) fetch 带的是页面来源（https://www.bilibili.com），不会触发 B 站对 chrome-extension:// 来源的 412 风控；
   2) 可以读 window.__INITIAL_STATE__，也可以改写播放器拿到的 seg.so 响应（protobuf 无损重编码）。

   安全模型：window.postMessage 是同窗口广播，页面上任何脚本都能伪造消息。因为本脚本和隔离世界的
   content 脚本都在 document_start 注入（早于页面自己的任何脚本），所以在那一刻做一次带随机令牌的
   握手，之后的通信都要求携带该令牌 —— 页面脚本要窃取就得比 document_start 更早，做不到。
   握手只接受一次，防止页面脚本后来用自带令牌重新握手。

   构建时与 protobuf.js / xml.js / urls.js 拼成一个经典脚本，整体包一层 IIFE。 */
(() => {
  const CHANNEL = 'jev-danmaku';
  const SEGMENT_PATH = '/x/v2/dm/web/seg.so';
  const TOKEN_MIN_LENGTH = 16;
  const nativeFetch = window.fetch.bind(window);
  const decoder = new TextDecoder('utf-8');

  const blocked = new Set();
  const asked = new Set();
  let token = null;
  let connected = false;

  const post = (payload, transfer) => window.postMessage({ __jev: true, channel: CHANNEL, token, ...payload }, location.origin, transfer || []);

  function isSegment(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === 'https://api.bilibili.com' && parsed.pathname === SEGMENT_PATH;
    } catch { return false; }
  }

  // 一律走原生 fetch，避免和下面的过滤钩子互相递归。
  async function fetchRaw(url) {
    const response = await nativeFetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(`B 站接口 HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function fetchJson(url) {
    const json = JSON.parse(decoder.decode(await fetchRaw(url)));
    if (json.code !== 0) throw new Error(json.message || `B 站接口返回错误 ${json.code}`);
    return json.result ?? json.data;
  }

  // fetch 会按 content-encoding 自动解压，所以正文常常已经是明文；不是再兜底解压。
  async function toText(bytes) {
    if (bytes[0] === 0x3c) return decoder.decode(bytes);
    for (const format of ['deflate', 'deflate-raw', 'gzip']) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return await new Response(stream).text();
      } catch { /* 换下一种 */ }
    }
    return decoder.decode(bytes);
  }

  function stateFromPage() {
    const state = window.__INITIAL_STATE__; // 番剧页没有这个变量，会走下面的接口
    if (!state) return null;
    const episode = state.epInfo;
    if (episode?.cid) {
      return { kind: 'bangumi', bvid: episode.bvid, aid: episode.aid, cid: episode.cid,
        title: episode.longTitle || episode.title || document.title, description: '',
        duration: normalizeDuration(episode.duration) };
    }
    const data = state.videoData;
    if (data?.cid) {
      // 多 P 视频：videoData.pages[] 里每 P 有自己的 cid / duration，必须按 ?p= 取。
      const index = Math.max(0, (Number(new URLSearchParams(location.search).get('p')) || 1) - 1);
      const page = data.pages?.[index] ?? data.pages?.[0];
      return {
        kind: 'video',
        bvid: data.bvid,
        aid: data.aid,
        cid: page?.cid ?? data.cid,
        // 单 P 视频的 pages[0].part 就等于标题，直接拼会变成「标题 · 标题」。
        title: (page?.part && page.part !== data.title)
          ? `${data.title || document.title} · ${page.part}`
          : (data.title || document.title),
        description: data.desc || '',
        duration: normalizeDuration(page?.duration ?? data.duration),
      };
    }
    return null;
  }

  async function resolve() {
    const fromPage = stateFromPage();
    if (fromPage) return fromPage;
    const ref = parseVideoRef(location.href);
    if (ref.epId) return normalizeEpisode(await fetchJson(pgcUrl(ref.epId)), ref.epId);
    const page = new URLSearchParams(location.search).get('p');
    return normalizeVideo(await fetchJson(viewUrl(location.href)), page);
  }

  // 预热：一次 list.so 就能拿到全片一大把弹幕，先批量判定，播放器后续拉分段时基本都命中。
  // 注意 list.so 是抽样返回的（同一视频两次调用子集不同），所以预热只是延迟优化，
  // 真正兜底的是下面"分段到来时按需判定"。
  async function warmup(video) {
    if (!video?.cid) return [];
    try {
      const items = parseDanmakuXml(await toText(await fetchRaw(xmlUrl(video.cid))));
      const seen = new Set();
      const texts = [];
      for (const item of items) {
        const text = (item.text || '').trim();
        if (text && !seen.has(text)) { seen.add(text); texts.push(text); }
      }
      return texts;
    } catch (error) {
      post({ kind: 'warn', message: `预热弹幕失败：${error.message}` });
      return [];
    }
  }

  // 播放器拉到的分段里出现没判过的文本时，向隔离世界要结果。
  const waiting = new Map();
  let needSeq = 0;

  function judge(texts) {
    const id = ++needSeq;
    return new Promise(resolve => {
      waiting.set(id, resolve);
      post({ kind: 'need', id, texts });
      setTimeout(() => { if (waiting.delete(id)) resolve(null); }, 2500);
    });
  }

  async function filterBuffer(raw) {
    if (!connected) return null;
    const texts = decodeSegment(raw).map(item => item.text).filter(Boolean);
    const unknown = [...new Set(texts)].filter(text => !asked.has(text));
    if (unknown.length) {
      const verdicts = await judge(unknown);
      if (verdicts) {
        for (const text of unknown) asked.add(text);
        for (const text of verdicts) blocked.add(text);
      }
    }
    if (!blocked.size) return null;
    const { bytes, dropped, total } = filterSegment(raw, text => blocked.has(text));
    if (dropped) post({ kind: 'filtered', dropped, total });
    return dropped ? bytes : null;
  }

  // ---- fetch 钩子 ----
  window.fetch = function jevFetch(...args) {
    const url = args[0] instanceof Request ? args[0].url : args[0];
    const promise = nativeFetch(...args);
    if (!isSegment(url)) return promise;
    return promise.then(async response => {
      if (!response.ok) return response;
      try {
        const filtered = await filterBuffer(new Uint8Array(await response.clone().arrayBuffer()));
        if (!filtered) return response;
        return new Response(filtered, { status: 200, statusText: 'OK', headers: { 'content-type': 'application/octet-stream' } });
      } catch (error) {
        post({ kind: 'warn', message: `过滤弹幕分段失败：${error?.message || error}` });
        return response;
      }
    });
  };

  // ---- XHR 钩子：定义实例上的 response getter，读取时同步过滤，不阻塞播放器 ----
  const XHR = XMLHttpRequest.prototype;
  const xhrOpen = XHR.open;
  const xhrSend = XHR.send;
  const responseDescriptor = Object.getOwnPropertyDescriptor(XHR, 'response');

  XHR.open = function jevOpen(method, url, ...rest) {
    try { this.__jevSegment = isSegment(url); } catch { this.__jevSegment = false; }
    return xhrOpen.call(this, method, url, ...rest);
  };

  XHR.send = function jevSend(...args) {
    if (this.__jevSegment && responseDescriptor?.get) {
      try {
        Object.defineProperty(this, 'response', {
          configurable: true,
          get() {
            const raw = responseDescriptor.get.call(this);
            if (!blocked.size || !(raw instanceof ArrayBuffer) || raw.byteLength < 8) return raw;
            try {
              const { bytes, dropped } = filterSegment(new Uint8Array(raw), text => blocked.has(text));
              return dropped ? bytes.buffer : raw;
            } catch { return raw; }
          },
        });
      } catch { /* 定义失败就放行，绝不能让播放器报错 */ }
    }
    return xhrSend.apply(this, args);
  };

  // ---- 与隔离世界的 RPC ----
  window.addEventListener('message', event => {
    const packet = event.data;
    if (event.source !== window || packet?.__jev !== true || packet.channel !== CHANNEL) return;

    // 握手：只接受一次，令牌必须够长，且不允许改密。
    if (packet.kind === 'hello') {
      const next = typeof packet.token === 'string' ? packet.token : '';
      if (next.length < TOKEN_MIN_LENGTH) return;
      if (token && token !== next) return;
      token = next;
      connected = true;
      post({ kind: 'hello-ack' });
      return;
    }

    // 其余消息一律要求携带握手令牌。
    if (!token || packet.token !== token) return;

    if (packet.kind === 'prepare') {
      (async () => {
        const video = await resolve();
        const texts = await warmup(video);
        return { video, texts };
      })().then(
        result => post({ kind: 'reply', id: packet.id, result }),
        error => post({ kind: 'reply', id: packet.id, error: String(error?.message || error) }),
      );
    } else if (packet.kind === 'verdicts') {
      for (const text of packet.judged || []) asked.add(text);
      for (const text of packet.blocked || []) blocked.add(text);
    } else if (packet.kind === 'need-result') {
      const resolve = waiting.get(packet.id);
      if (resolve) { waiting.delete(packet.id); resolve(packet.blocked || []); }
    } else if (packet.kind === 'reset') {
      blocked.clear();
      asked.clear();
    }
  });
})();
