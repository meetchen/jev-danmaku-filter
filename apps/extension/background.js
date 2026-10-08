// Service Worker：只负责调用 JEV、缓存、以及额度保护。
// 注意：B 站接口必须由页面上下文请求（chrome-extension:// 来源会被 B 站风控返回 412），
// 所以这里完全不碰 B 站，B 站网络全部交给 page.js。
import { SPOILER, RULE_VERSION } from './vendor/core/rules.js';
import { classifyTexts } from './vendor/core/batch.js';
import { MapCache } from './vendor/core/memory.js';
import { PROVIDERS, DEFAULT_PROVIDER, resolveProvider, modelsEndpoint } from './vendor/core/providers.js';

// endpoint / model 的覆盖字段带 Override 后缀，避免与早期版本存下的同名字段碰撞。
const DEFAULTS = { enabled: true, provider: DEFAULT_PROVIDER, workspaceId: '', endpointOverride: '', modelOverride: '' };
const MAX_TEXTS_PER_CALL = 20_000;
// 这是花用户自己额度的插件，装完之后没人盯着。加一道每日上限，
// 防止恶意页面伪造消息或超长视频把额度悄悄烧光。约合每天 $2~3。
const DAILY_TEXT_BUDGET = 200_000;

const settings = { ...DEFAULTS };
const cache = new MapCache({ max: 20_000 });
let apiKey = '';
let lastError = '';
let usage = { day: '', texts: 0 };
let saveTimer = null;

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const provider = () => resolveProvider(settings);

/**
 * 模型名不对（model_not_found）是最难自查的一类错 —— 名字看着没错，但该 Key /
 * 该业务空间下根本没有这个模型。失败时顺手查一下可用列表，直接告诉用户能用什么。
 * 只用于 TEST，不打扰正常过滤流程。
 */
async function availableModels(active) {
  const url = modelsEndpoint(active.endpoint);
  if (!url) return null;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store' });
    if (!response.ok) return null;
    const json = await response.json();
    const ids = (json.data ?? json.models ?? []).map(model => model?.id ?? model?.name).filter(Boolean);
    return ids.length ? ids : null;
  } catch { return null; }
}

const ready = (async () => {
  // API Key 只保存在本机扩展存储里。限制为仅可信上下文可读，content script 也读不到。
  try { await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* 老版本 Chrome 忽略 */ }

  const stored = await chrome.storage.local.get(['settings', 'apiKey', 'cache', 'usage']);
  if (stored.settings) {
    Object.assign(settings, stored.settings);
    // 早期版本的默认设置里有 model: 'jev-latest'，现在这个键已经不用了。
    // 留着会让人在排查时误以为它是生效的配置，直接清掉。
    if ('model' in settings || 'endpoint' in settings) {
      delete settings.model;
      delete settings.endpoint;
      await chrome.storage.local.set({ settings: { ...settings } });
    }
  }
  if (typeof stored.apiKey === 'string') apiKey = stored.apiKey;
  cache.hydrate(stored.cache);
  if (stored.usage?.day === today()) usage = stored.usage;

  // 允许带一份预判缓存（由 CLI 跑好再灌进来），首次打开就不用等预热、也不花额度。
  // 只补缺失的键，已有结果优先。发布包里不应包含 seed.json。
  try {
    const seed = await (await fetch(chrome.runtime.getURL('seed.json'))).json();
    let added = 0;
    for (const [key, value] of Object.entries(seed)) {
      if (!cache.map.has(key)) { cache.map.set(key, value); added++; }
    }
    if (added) scheduleSave();
  } catch { /* 没有 seed.json 就正常走 API */ }
})();

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ cache: cache.toObject() }).catch(() => {}), 1500);
}

const remainingBudget = () => Math.max(0, DAILY_TEXT_BUDGET - (usage.day === today() ? usage.texts : 0));

const state = () => ({
  ok: true,
  enabled: settings.enabled,
  configured: Boolean(apiKey),
  provider: settings.provider,
  providerLabel: provider().label,
  providers: Object.values(PROVIDERS).map(({ id, label, hint, model, docs, docsLabel, needsWorkspace }) => ({ id, label, hint, model, docs, docsLabel, needsWorkspace })),
  endpoint: provider().endpoint,
  model: provider().model,
  providerReady: provider().configured,
  workspaceId: settings.workspaceId,
  endpointOverride: settings.endpointOverride,
  modelOverride: settings.modelOverride,
  ruleVersion: RULE_VERSION,
  active: settings.enabled && Boolean(apiKey) && provider().configured,
  error: lastError,
  cached: cache.map.size,
  usedToday: usage.day === today() ? usage.texts : 0,
  dailyBudget: DAILY_TEXT_BUDGET,
});

async function classify(message, sender) {
  const incoming = Array.isArray(message.texts) ? message.texts : [];
  const texts = [...new Set(incoming.map(text => String(text ?? '').trim().slice(0, 200)).filter(Boolean))].slice(0, MAX_TEXTS_PER_CALL);
  if (!texts.length) return { ok: true, blocked: [], stats: { unique: 0 } };
  if (!state().active) return { ok: true, blocked: [], stats: { unique: texts.length, inactive: true } };

  const budget = remainingBudget();
  if (budget <= 0) {
    throw new Error(`今天的判定额度已用完（${DAILY_TEXT_BUDGET} 条）。明天自动重置。`);
  }
  const allowed = texts.slice(0, budget);

  const active = provider();
  const { results, stats } = await classifyTexts(allowed, {
    apiKey,
    rule: SPOILER,
    backend: active,
    cache,
    context: {
      title: String(message.context?.title ?? '').slice(0, 240),
      description: String(message.context?.description ?? '').slice(0, 600),
      duration: Number(message.context?.duration) || 0,
    },
    concurrency: 8,
    onProgress: ({ done, total }) => {
      if (sender?.tab?.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'PROGRESS', done, total }).catch(() => {});
    },
  });

  scheduleSave();
  lastError = '';
  if (stats.requested) {
    // 只累计真正发出去的条数，缓存命中不占额度。
    usage = { day: today(), texts: (usage.day === today() ? usage.texts : 0) + stats.requested };
    await chrome.storage.local.set({ usage });
  }
  const blocked = [...results].filter(([, result]) => result.choice === SPOILER.options[0]).map(([text]) => text);
  return { ok: true, blocked, stats: { ...stats, blocked: blocked.length, truncated: texts.length - allowed.length } };
}

// 只接受本扩展自己的页面和内容脚本发来的消息。
function assertSender(sender) {
  if (sender?.id !== chrome.runtime.id) throw new Error('不接受来自其他扩展的消息。');
}

async function handle(message, sender) {
  await ready;
  assertSender(sender);
  switch (message?.type) {
    case 'GET_STATE':
      return state();
    case 'CLASSIFY':
      return await classify(message, sender);
    case 'SAVE': {
      if (typeof message.enabled === 'boolean') settings.enabled = message.enabled;
      if (message.provider !== undefined) {
        if (!PROVIDERS[message.provider]) throw new Error(`未知的判定后端：${message.provider}`);
        settings.provider = message.provider;
      }
      for (const key of ['workspaceId', 'endpointOverride', 'modelOverride']) {
        if (message[key] !== undefined) settings[key] = String(message[key]).trim();
      }
      if (message.apiKey !== undefined) {
        const key = String(message.apiKey).trim();
        if (key && !/^[\x21-\x7e]{8,512}$/.test(key)) throw new Error('API Key 格式不对，请粘贴完整的一串。');
        apiKey = key;
        await chrome.storage.local.set({ apiKey });
      }
      await chrome.storage.local.set({ settings: { ...settings } });
      lastError = '';
      return state();
    }
    case 'TEST': {
      if (!apiKey) throw new Error('请先填写 API Key。');
      const active = provider();
      try {
        await classify({ texts: ['这是一条连接测试，不是真实弹幕。'], context: { title: '连接测试' } }, null);
      } catch (error) {
        // 模型名不对是最难自查的一类错：名字看着没错、key 也对、workspace 也对。
        // 所以失败时把「实际发出的模型名」带上，并顺手查一下可参考的模型列表。
        const models = await availableModels(active);
        if (!models) throw new Error(`实际发出的模型名是「${active.model}」。${error.message}`);
        // 报错里带上可用模型，省得用户对着一个"看着没错"的模型名反复试
        throw new Error(`实际发出的模型名是「${active.model}」。${error.message}`
          + ` —— ${new URL(active.endpoint).host} 报出的模型列表（仅供参考，不代表全部可用的）：${models.slice(0, 12).join('、')}…`);
      }
      return state();
    }
    default:
      throw new Error('未知的消息类型。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply).catch(error => {
    lastError = String(error?.message || error);
    reply({ ok: false, error: lastError });
  });
  return true;
});
