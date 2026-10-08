import { SPOILER } from './rules.js';
import { cacheKey } from './hash.js';
import {
  DEFAULT_MODEL, MAX_CONTEXT_TOKENS, MAX_SINGLE_TOKENS,
  ask, buildRequest, parseAnswers, questionTokenCost,
} from './jev.js';
import { estimateTokens } from './tokens.js';
import { NullCache } from './memory.js';
import { buildChatRequest, parseChatAnswers, parseChatUsage } from './backends/chat.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
  if (signal?.aborted) return onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
});

// 按 JEV 的双重上下文预算切分：state + 全部 questions ≤ 60K，state + 单问 ≤ 28K。
export function chunkEntries(entries, {
  rule = SPOILER, model = DEFAULT_MODEL, context = {},
  maxContext = MAX_CONTEXT_TOKENS, maxSingle = MAX_SINGLE_TOKENS,
  // 不同厂商对「一次问多少个问题」的建议不同：TypeSafe 说加问题几乎不增加延迟，
  // 阿里百炼的文档说延迟随问题数近线性增长、建议 ≤16。所以批量上限要能按厂商调。
  maxQuestions = Infinity,
} = {}) {
  const perQuestion = questionTokenCost(rule);
  const base = estimateTokens(buildRequest([], { rule, model, ...context }).state);
  const chunks = [];
  let current = [];
  let stateTokens = base;
  let questionTokens = 0;

  for (const entry of entries) {
    const entryTokens = estimateTokens(entry) + 6;
    const overflow = stateTokens + entryTokens > maxSingle
      || stateTokens + entryTokens + questionTokens + perQuestion > maxContext
      || current.length >= maxQuestions;
    if (current.length && overflow) {
      chunks.push(current);
      current = [];
      stateTokens = base;
      questionTokens = 0;
    }
    current.push(entry);
    stateTokens += entryTokens;
    questionTokens += perQuestion;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function withRetry(run, { maxRetries, signal, onRetry }) {
  for (let attempt = 0; ; attempt++) {
    try {
      // 把尝试序号传进去：聊天模型偶尔会漏几条，最后一次尝试就得接受部分结果。
      return await run(attempt);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (!error?.retryable || attempt >= maxRetries) throw error;
      const delay = error.retryAfter ? error.retryAfter * 1000 : Math.min(15_000, 600 * 2 ** attempt) + Math.random() * 300;
      onRetry?.({ attempt: attempt + 1, delay, error });
      await sleep(delay, signal);
    }
  }
}

/**
 * 批量判断弹幕是否为剧透。去重 → 读缓存 → 按预算分批 → 并发请求 → 回写缓存。
 * @returns {{results: Map<string,{choice:string,confidence:number|null,source:'cache'|'api'}>, stats: object}}
 */
export async function classifyTexts(texts, options = {}) {
  const {
    apiKey,
    rule = SPOILER,
    model: initialModel = DEFAULT_MODEL,
    cache = new NullCache(),
    context = {},
    // 优先用整个 backend 对象：逐个字段往下传必然漏掉某个（已经漏过一次 kind）。
    backend = null,
    kind = backend?.kind ?? 'systemone',
    maxQuestions = backend?.maxQuestions ?? Infinity,
    concurrency = 2,
    maxRetries = 3,
    onProgress,
    onRetry,
    signal,
    fetchImpl = fetch,
    endpoint = backend?.endpoint,
    atByText = new Map(),
    useCache = true,
    log = null,
  } = options;

  let model = initialModel;
  if (backend?.model) model = backend.model;
  if (kind === 'chat' && !Array.isArray(rule.levels)) {
    throw new Error(`聊天后端要求 rule 带有序量表（levels），而 ${rule.id} 是 ${rule.type} 规则。choice/noul 这类只能配 systemone 后端。`);
  }
  if (kind === 'chat' && !/\/chat\/completions\/?$/.test(endpoint ?? '')) {
    throw new Error(`聊天后端 ${backend?.id ?? ''} 的端点不像 chat/completions：${endpoint}。多半是没把 backend 或 kind 传下来。`);
  }

  const unique = [...new Set(texts.filter(t => typeof t === 'string' && t.trim()))];
  const results = new Map();
  const pending = [];

  if (useCache) {
    for (const text of unique) {
      const hit = cache.get(await cacheKey(rule, model, text));
      if (hit) {
        // 缓存里存的是原始概率，按当前阈值重新判决，所以调阈值不用重跑。
        const choice = typeof hit.v === 'number'
          ? (hit.v >= (rule.threshold ?? 0.6) ? rule.options[0] : rule.options[1])
          : hit.c;
        results.set(text, { choice, severity: hit.v ?? null, source: 'cache' });
      }
      else pending.push(text);
    }
  } else {
    pending.push(...unique);
  }

  const stats = { total: texts.length, unique: unique.length, cached: unique.length - pending.length, requested: 0, batches: 0, inputTokens: 0 };
  if (!pending.length) return { results, stats };

  if (!apiKey) throw new Error('缺少 API Key：请设置 TYPESAFE_API_KEY，或传入 --key。');

  const entries = pending.map(text => ({ text, at: atByText.get(text) ?? null }));
  const chunks = chunkEntries(entries, { rule, model, context, maxQuestions });
  stats.batches = chunks.length;

  let cursor = 0;
  let done = 0;
  let failure = null;

  const worker = async () => {
    for (;;) {
      if (failure) return;
      const index = cursor++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      try {
        const isChat = kind === 'chat';
        const body = isChat
          ? buildChatRequest(chunk, rule, { model, ...context })
          : buildRequest(chunk, { rule, model, ...context });
        const data = await withRetry(async attempt => {
          const response = await ask({ apiKey, body, signal, fetchImpl, ...(endpoint ? { endpoint } : {}) });
          if (isChat) {
            const { severities, missing } = parseChatAnswers(response, chunk.length, rule);
            // 漏几条就重试；最后一次尝试接受部分结果，缺的按放行处理并记一笔。
            if (missing.length && attempt < maxRetries) {
              throw Object.assign(new Error(`模型漏了 ${missing.length} 条，重试。`), { retryable: true });
            }
            return { response, severities, missing };
          }
          return { response, answers: parseAnswers(response, chunk.length, rule) };
        }, { maxRetries, signal, onRetry });

        const answers = isChat
          ? data.severities.map(severity => ({
            severity,
            choice: (severity ?? 0) >= (rule.threshold ?? 0.6) ? rule.options[0] : rule.options[1],
          }))
          : data.answers;
        if (isChat && data.missing.length) stats.incomplete = (stats.incomplete ?? 0) + data.missing.length;

        for (let i = 0; i < chunk.length; i++) {
          const text = chunk[i].text;
          results.set(text, { ...answers[i], source: 'api' });
          if (useCache) cache.set(await cacheKey(rule, model, text), { c: answers[i].choice, v: answers[i].severity, m: model, r: rule.id });
        }
        stats.requested += chunk.length;
        stats.inputTokens += isChat
          ? parseChatUsage(data.response).inputTokens
          : (data.response?.usage?.input_tokens ?? estimateTokens(body));
        log?.(`批次 ${index + 1}/${chunks.length}：${chunk.length} 条，模型 ${data.response?.model ?? model}`);
      } catch (error) {
        failure = failure ?? error;
        return;
      } finally {
        done += 1;
        onProgress?.({ done: Math.min(done, chunks.length), total: chunks.length, processed: results.size, of: unique.length });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  } finally {
    await cache.save();
  }
  if (failure) throw failure;
  return { results, stats };
}
