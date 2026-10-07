/* 隔离世界。负责编排：拿到全片弹幕文本 → 交给后台判定 → 把结果推给 page.js 并隐藏 DOM 兜底。
   与 MAIN world 的通信靠一个随机令牌保护 —— 见 page-runtime.js 顶部的安全模型说明。 */
(() => {
  const CHANNEL = 'jev-danmaku';
  const DANMAKU = '.bili-danmaku-x-dm,.b-danmaku,.danmaku-item';
  const eligible = () => /^\/(video\/|list\/|bangumi\/play\/)/.test(location.pathname);

  // 128 位随机令牌。content 脚本与 page 脚本都在 document_start 注入，早于页面自己的脚本，
  // 所以这个令牌不会被页面脚本观察到。
  const TOKEN = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

  const toPage = (payload, transfer) => window.postMessage({ __jev: true, channel: CHANNEL, token: TOKEN, ...payload }, location.origin, transfer || []);
  const send = message => chrome.runtime.sendMessage(message);

  let blocked = new Set();
  let state = null;
  let generation = 0;
  let settled = false;
  let judged = 0;
  let hidden = 0;
  let filtered = 0;
  let progress = '';
  let problem = '';
  let pageReady = false;
  let pagePath = location.pathname + location.search;
  let video = null;

  const pending = new Map();
  let seq = 0;

  function ask(payload, timeout = 90_000) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      toPage({ ...payload, id });
      setTimeout(() => { if (pending.delete(id)) reject(new Error('页面脚本没有响应。')); }, timeout);
    });
  }

  async function handshake() {
    if (pageReady) return;
    for (let i = 0; i < 40 && !pageReady; i++) {
      toPage({ kind: 'hello' });
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!pageReady) throw new Error('页面脚本未注入。');
  }

  // ---------- DOM 兜底：分段改写可能来不及，页面上已经出现的弹幕直接隐藏 ----------
  function applyNode(node) {
    if (node.nodeType !== 1 || !node.matches?.(DANMAKU)) return;
    const text = (node.textContent || '').trim();
    if (text && blocked.has(text)) {
      if (node.dataset.jevm !== 'block') { node.dataset.jevm = 'block'; hidden++; updateHud(); }
    } else if (node.dataset.jevm) {
      delete node.dataset.jevm;
    }
  }

  let scanScheduled = false;
  function scan() {
    if (scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(() => {
      scanScheduled = false;
      for (const node of document.querySelectorAll(DANMAKU)) applyNode(node);
    });
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') { scan(); continue; }
      for (const node of record.addedNodes) if (node.nodeType === 1) applyNode(node);
      if (record.target.nodeType === 1) applyNode(record.target);
    }
  });

  // ---------- 状态角标 ----------
  let hudHost = null;
  let hudText = null;

  function updateHud() {
    // 内容脚本在隔离世界，页面 Console 读不到它的变量，只能读 DOM，所以镜像一份状态到 <html>。
    document.documentElement?.setAttribute('data-jevm-status',
      !state ? 'idle | 未取到扩展状态'
        : !state.active ? 'off | 插件未开启或未配置 Key'
          : `${settled ? 'ready' : 'working'} | 判定 ${judged} | 识别剧透 ${blocked.size} | 实际隐藏 ${hidden + filtered}`
            + `${problem ? ` | ${problem}` : progress ? ` | ${progress}` : ''}`);

    if (!hudHost) return;
    if (!state?.active) { hudHost.remove(); hudHost = null; return; }
    const parts = [settled ? `识别剧透 ${blocked.size} 种 · 实际隐藏 ${hidden + filtered} 条` : '判定中…'];
    if (settled) parts.push(`全片 ${judged} 种弹幕`);
    if (problem) parts.push(problem);
    else if (progress) parts.push(progress);
    hudText.textContent = `剧透弹幕 · ${parts.join(' · ')}`;
    if (!hudHost.isConnected && document.body) document.body.append(hudHost);
  }

  function mountHud() {
    if (hudHost || !document.body) return;
    hudHost = document.createElement('div');
    hudHost.id = 'jev-danmaku-hud';
    const shadow = hudHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;left:14px;bottom:14px;z-index:2147483000}div{font:11px/1.6 -apple-system,"Microsoft YaHei",sans-serif;background:#f7f8f5f2;color:#2f5d43;border:1px solid #dfe6dc;border-radius:8px;padding:6px 10px;box-shadow:0 2px 10px #0001}';
    hudText = document.createElement('div');
    hudText.setAttribute('role', 'status');
    shadow.append(style, hudText);
    document.body.append(hudHost);
    updateHud();
  }

  function flag() {
    document.documentElement?.setAttribute('data-jevm-active', state?.active ? 'on' : 'off');
  }

  // ---------- 主流程 ----------
  async function run() {
    const epoch = ++generation;
    blocked = new Set();
    settled = false; judged = 0; hidden = 0; filtered = 0; progress = ''; problem = '';
    video = null;
    pagePath = location.pathname + location.search;
    toPage({ kind: 'reset' });

    if (!eligible()) { state = null; flag(); if (hudHost) { hudHost.remove(); hudHost = null; } updateHud(); return; }

    try {
      state = await send({ type: 'GET_STATE' });
    } catch { state = null; flag(); problem = '扩展后台没有响应'; updateHud(); return; }
    if (!state?.ok) { state = null; flag(); problem = '扩展状态异常'; updateHud(); return; }
    flag();
    if (!state.active) { if (hudHost) { hudHost.remove(); hudHost = null; } updateHud(); return; }

    settled = false; mountHud(); updateHud();
    try {
      await handshake();
      if (epoch !== generation) return;
      const prepared = await ask({ kind: 'prepare' });
      if (epoch !== generation) return;
      video = prepared.video;
      judged = prepared.texts.length;
      updateHud();
      if (!prepared.texts.length) { settled = true; progress = '这个页面没有弹幕'; updateHud(); return; }

      const verdict = await send({ type: 'CLASSIFY', texts: prepared.texts, context: prepared.video });
      if (epoch !== generation) return;
      if (!verdict?.ok) throw new Error(verdict?.error || '判定失败。');
      for (const text of verdict.blocked || []) blocked.add(text);
      toPage({ kind: 'verdicts', blocked: [...blocked], judged: prepared.texts });
      settled = true;
      progress = verdict.stats?.inactive ? '插件未开启' : '';
      updateHud();
      scan();
    } catch (error) {
      if (epoch !== generation) return;
      settled = true;
      problem = String(error?.message || error);
      document.documentElement?.setAttribute('data-jevm-active', 'off');
      updateHud();
    }
  }

  window.addEventListener('message', event => {
    const packet = event.data;
    if (event.source !== window || packet?.__jev !== true || packet.channel !== CHANNEL) return;
    // 只信任带正确令牌的消息：页面上的其他脚本无法伪造。
    if (packet.token !== TOKEN) return;

    if (packet.kind === 'hello-ack') { pageReady = true; return; }
    if (packet.kind === 'reply' && pending.has(packet.id)) {
      const waiter = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) waiter.reject(new Error(packet.error));
      else waiter.resolve(packet.result);
      return;
    }
    if (packet.kind === 'filtered') { filtered += packet.dropped || 0; updateHud(); return; }
    if (packet.kind === 'warn') { problem = packet.message; updateHud(); return; }
    if (packet.kind === 'need') {
      // 播放器拉到的分段里有没判过的文本：立刻去后台判定（后台有缓存，重复文本不再花额度）。
      const texts = (packet.texts || []).slice(0, 500);
      send({ type: 'CLASSIFY', texts, context: video })
        .then(result => {
          for (const text of result.blocked || []) blocked.add(text);
          toPage({ kind: 'need-result', id: packet.id, blocked: result.blocked || [] });
          updateHud();
        })
        .catch(() => toPage({ kind: 'need-result', id: packet.id, blocked: [] }));
    }
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'PROGRESS') { progress = `判定中 ${message.done}/${message.total} 批`; updateHud(); }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.settings || changes.apiKey)) run();
  });

  observer.observe(document, { childList: true, subtree: true, characterData: true });
  run();

  setInterval(() => {
    if (location.pathname + location.search !== pagePath) run();
  }, 1200);
})();
