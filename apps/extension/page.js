(() => {
/* ---- src/adapters/bilibili/protobuf.js ---- */
// B 站弹幕分段接口 /x/v2/dm/web/seg.so 返回的 DmSegMobileReply。
// 顶层结构：field 1 = repeated DanmakuElem（length-delimited），其余字段（state / ai_flag / config）原样保留。
// 因为只需要按"整段 span"丢弃或保留，重编码是无损拼接，不会破坏播放器解析。
const MAX_BYTES = 8 * 1024 * 1024;

function readVarint(bytes, pos) {
  let result = 0;
  let factor = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new Error('protobuf: varint 被截断');
    const byte = bytes[pos++];
    result += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return [result, pos];
    factor *= 128;
  }
  throw new Error('protobuf: varint 过长');
}

/** 把一段 buffer 解析成字段 span，保留原始起止位置，便于无损重编码。 */
function readFields(bytes) {
  const fields = [];
  let pos = 0;
  while (pos < bytes.length) {
    const start = pos;
    let tag;
    [tag, pos] = readVarint(bytes, pos);
    const wire = tag & 7;
    const field = tag >>> 3;
    if (field === 0) throw new Error('protobuf: 非法字段号');
    let span;
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(bytes, pos);
      span = { field, wire, start, end: pos, value };
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(bytes, pos);
      if (length > bytes.length - pos) throw new Error('protobuf: length-delimited 长度越界');
      const valueStart = pos;
      pos += length;
      span = { field, wire, start, end: pos, valueStart };
    } else if (wire === 1) {
      pos += 8;
      span = { field, wire, start, end: pos };
    } else if (wire === 5) {
      pos += 4;
      span = { field, wire, start, end: pos };
    } else {
      throw new Error(`protobuf: 不支持的 wire 类型 ${wire}`);
    }
    if (pos > bytes.length) throw new Error('protobuf: 字段被截断');
    fields.push(span);
  }
  return fields;
}

const asBytes = buffer => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));

/** 单条 DanmakuElem 的字段：1=id(64bit) 2=progress(ms) 3=mode 4=fontsize 5=color 6=midHash 7=content 8=ctime */
function decodeElem(inner, decoder = new TextDecoder()) {
  let id = 0;
  let at = 0;
  let mode = 1;
  let text = '';
  for (const f of readFields(inner)) {
    if (f.wire === 0) {
      if (f.field === 1) id = f.value;
      else if (f.field === 2) at = f.value / 1000;
      else if (f.field === 3) mode = f.value;
    } else if (f.wire === 2 && f.field === 7) {
      text = decoder.decode(inner.subarray(f.valueStart, f.end));
    }
  }
  return { id, at, mode, text };
}

/** 解码一个分段，返回 [{ id, at(秒), mode, text }]。解析失败由调用方决定是否降级。 */
function decodeSegment(buffer, { max = 20_000 } = {}) {
  const bytes = asBytes(buffer);
  if (bytes.length > MAX_BYTES) throw new Error('protobuf: 分段过大');
  const decoder = new TextDecoder('utf-8');
  const items = [];
  for (const span of readFields(bytes)) {
    if (span.field !== 1 || span.wire !== 2) continue;
    const elem = decodeElem(bytes.subarray(span.valueStart, span.end), decoder);
    if (!elem.text) continue;
    items.push(elem);
    if (items.length >= max) break;
  }
  return items;
}

/**
 * 从分段里剔除命中的弹幕，返回新的 Uint8Array。
 * isBlocked(text) 为 true 的 DanmakuElem 整体丢弃，其它字段逐字节保留。
 */
function filterSegment(buffer, isBlocked) {
  const bytes = asBytes(buffer);
  const decoder = new TextDecoder('utf-8');
  const keep = [];
  let dropped = 0;
  let total = 0;
  for (const span of readFields(bytes)) {
    if (span.field === 1 && span.wire === 2) {
      total += 1;
      const elem = decodeElem(bytes.subarray(span.valueStart, span.end), decoder);
      if (elem.text && isBlocked(elem.text, elem)) { dropped += 1; continue; }
    }
    keep.push(bytes.subarray(span.start, span.end));
  }
  const size = keep.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of keep) { out.set(part, offset); offset += part.length; }
  return { bytes: out, total, dropped };
}


/* ---- src/adapters/bilibili/xml.js ---- */
// 旧版弹幕接口 /x/v1/dm/list.so 返回 deflate 压缩的 XML。
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  }).replace(/\r/g, '');
}

// p 属性顺序：进度(秒), 模式, 字号, 颜色, 发送时间戳, 弹幕池, 发送者, 行号(dmid), 权重
function parseDanmakuXml(xml, { max = 20_000 } = {}) {
  const items = [];
  const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = pattern.exec(xml)) && items.length < max) {
    const parts = match[1].split(',');
    const at = Number(parts[0]);
    const mode = Number(parts[1]) || 1;
    const id = parts[7] ? Number(parts[7]) : 0;
    const text = decodeEntities(match[2]).trim();
    if (!text || !Number.isFinite(at)) continue;
    items.push({ id, at, mode, text });
  }
  return items;
}


/* ---- src/adapters/bilibili/urls.js ---- */
const API = 'https://api.bilibili.com';
const SEGMENT_SECONDS = 360; // 播放器按 6 分钟一段拉取弹幕

/** 接受 BV 号、av 号、完整 URL 或裸数字，返回 {bvid} 或 {aid}。 */
function parseVideoRef(input) {
  const value = String(input ?? '').trim();
  // 番剧：/bangumi/play/ep403700 或裸 ep403700
  const ep = value.match(/\bep(\d{4,})/i);
  if (ep) return { epId: Number(ep[1]) };
  const bv = value.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0] };
  const av = value.match(/(?:^|\/|av)(\d{4,})/i);
  if (av) return { aid: Number(av[1]) };
  throw new Error(`无法识别的视频标识：${value || '(空)'}`);
}

// 不同接口的 duration 单位不一样：/video/ 是秒，番剧 pgc 是毫秒。
function normalizeDuration(value) {
  const seconds = Number(value) || 0;
  return seconds > 100_000 ? Math.round(seconds / 1000) : Math.round(seconds);
}

function viewUrl(input) {
  const ref = parseVideoRef(input);
  return `${API}/x/web-interface/view?${ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`}`;
}

function segmentUrl(cid, aid, index) {
  return `${API}/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${aid}&segment_index=${index}`;
}

function xmlUrl(cid) {
  return `${API}/x/v1/dm/list.so?oid=${cid}`;
}

function pgcUrl(epId) {
  return `${API}/pgc/view/web/season?ep_id=${epId}`;
}

function normalizeVideo(data, pageNumber = 1) {
  const index = Math.max(0, (Number(pageNumber) || 1) - 1);
  const page = data.pages?.[index] ?? data.pages?.[0] ?? null;
  return {
    kind: 'video',
    bvid: data.bvid,
    aid: data.aid,
    cid: page?.cid ?? data.cid,
    // 单 P 视频的 pages[0].part 就等于标题，直接拼会变成「标题 · 标题」。
    title: (page?.part && page.part !== data.title) ? `${data.title ?? ''} · ${page.part}` : (data.title ?? ''),
    description: data.desc ?? '',
    duration: normalizeDuration(page?.duration ?? data.duration),
    owner: data.owner?.name ?? '',
    pageCount: data.videos ?? 1,
  };
}

/** 番剧：pgc season 结构，episodes 和 section 里都可能有分集。 */
function normalizeEpisode(season, epId) {
  const episodes = [...(season.episodes || []), ...((season.section || []).flatMap(section => section.episodes || []))];
  const ep = episodes.find(item => item.id === epId || item.ep_id === epId) || episodes[0] || {};
  const label = [season.title, ep.title ? `第${ep.title}集` : '', ep.long_title || ''].filter(Boolean).join(' · ');
  return {
    kind: 'bangumi',
    bvid: ep.bvid,
    aid: ep.aid,
    cid: ep.cid,
    title: label || season.title || '',
    description: season.evaluate || season.subtitle || '',
    duration: normalizeDuration(ep.duration),
    owner: '',
    pageCount: episodes.length,
  };
}


/* ---- apps/extension/src/page-runtime.js ---- */
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

})();
