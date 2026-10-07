/* MAIN world。运行在站点页面自己的 JS 上下文里，因此：
   1) fetch 带的是页面来源，不会触发站点对 chrome-extension:// 来源的风控（B 站返回 412）；
   2) 可以直接读页面自带的播放数据；
   3) 可以改写播放器拿到的弹幕响应。

   这个文件**不含任何站点特有逻辑** —— 站点差异全部在 src/sites/ 的描述符里，通过注册表分派。
   加一个新站点不需要改这里。

   安全模型：window.postMessage 是同窗口广播，页面上任何脚本都能伪造消息。因为本脚本和隔离世界的
   content 脚本都在 document_start 注入（早于页面自己的任何脚本），所以在那一刻做一次带随机令牌的
   握手，之后的通信都要求携带该令牌 —— 页面脚本要窃取就得比 document_start 更早，做不到。
   握手只接受一次，防止页面脚本后来用自带令牌重新握手。

   构建时与站点描述符一起拼成一个经典脚本，整体包一层 IIFE。 */
(() => {
  const CHANNEL = 'jev-danmaku';
  const TOKEN_MIN_LENGTH = 16;
  const nativeFetch = window.fetch.bind(window);
  const decoder = new TextDecoder('utf-8');

  const site = findSite(location.href);
  const blocked = new Set();
  const asked = new Set();
  let token = null;
  let connected = false;

  const post = (payload, transfer) => window.postMessage({ __jev: true, channel: CHANNEL, token, ...payload }, location.origin, transfer || []);

  // 一律走原生 fetch，避免和下面的过滤钩子互相递归。
  async function fetchRaw(url) {
    const response = await nativeFetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(`接口 HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function fetchJson(url) {
    const json = JSON.parse(decoder.decode(await fetchRaw(url)));
    if (json.code !== 0) throw new Error(json.message || `接口返回错误 ${json.code}`);
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

  const context = { href: location.href, fetchBytes: fetchRaw, fetchJson, toText, post };

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
    if (!connected || !site) return null;
    const texts = site.decodeTexts(raw);
    const unknown = [...new Set(texts)].filter(text => !asked.has(text));
    if (unknown.length) {
      const verdicts = await judge(unknown);
      if (verdicts) {
        for (const text of unknown) asked.add(text);
        for (const text of verdicts) blocked.add(text);
      }
    }
    if (!blocked.size) return null;
    const result = site.filterBytes(raw, text => blocked.has(text));
    if (!result?.dropped) return null;
    post({ kind: 'filtered', dropped: result.dropped, total: result.total });
    return result.bytes;
  }

  // 站点没有弹幕响应钩子（例如离线源）时，完全不碰页面的网络层。
  const intercepts = Boolean(site?.isDanmakuResponse && site?.filterBytes);

  if (intercepts) {
    // ---- fetch 钩子 ----
    window.fetch = function jevFetch(...args) {
      const url = args[0] instanceof Request ? args[0].url : args[0];
      const promise = nativeFetch(...args);
      let isDanmaku = false;
      try { isDanmaku = site.isDanmakuResponse(url); } catch { isDanmaku = false; }
      if (!isDanmaku) return promise;
      return promise.then(async response => {
        if (!response.ok) return response;
        try {
          const filtered = await filterBuffer(new Uint8Array(await response.clone().arrayBuffer()));
          if (!filtered) return response;
          return new Response(filtered, { status: 200, statusText: 'OK', headers: { 'content-type': 'application/octet-stream' } });
        } catch (error) {
          post({ kind: 'warn', message: `过滤弹幕响应失败：${error?.message || error}` });
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
      try { this.__jevDanmaku = site.isDanmakuResponse(url); } catch { this.__jevDanmaku = false; }
      return xhrOpen.call(this, method, url, ...rest);
    };

    XHR.send = function jevSend(...args) {
      if (this.__jevDanmaku && responseDescriptor?.get) {
        try {
          Object.defineProperty(this, 'response', {
            configurable: true,
            get() {
              const raw = responseDescriptor.get.call(this);
              if (!blocked.size || !(raw instanceof ArrayBuffer) || raw.byteLength < 8) return raw;
              try {
                const result = site.filterBytes(new Uint8Array(raw), text => blocked.has(text));
                return result?.dropped ? result.bytes.buffer : raw;
              } catch { return raw; }
            },
          });
        } catch { /* 定义失败就放行，绝不能让播放器报错 */ }
      }
      return xhrSend.apply(this, args);
    };
  }

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
      // 站点信息由 page 侧决定（站点匹配跑在 MAIN world），隔离世界据此决定是否继续。
      post({ kind: 'hello-ack', site: site?.id ?? null, domSelector: site?.domSelector ?? null });
      return;
    }

    // 其余消息一律要求携带握手令牌。
    if (!token || packet.token !== token) return;

    if (packet.kind === 'prepare') {
      (async () => {
        if (!site) throw new Error('这个页面还没有适配。');
        const video = await site.resolve(context);
        let texts = [];
        if (site.warmup) {
          try {
            texts = await site.warmup(context, video);
          } catch (error) {
            post({ kind: 'warn', message: `预热弹幕失败：${error.message}` });
          }
        }
        return { video, texts, domSelector: site.domSelector ?? null };
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
