import { SPOILER } from './rules.js';
import { cacheKey } from './hash.js';
import {
  DEFAULT_MODEL, MAX_CONTEXT_TOKENS, MAX_SINGLE_TOKENS,
  ask, buildRequest, parseAnswers, questionTokenCost,
} from './jev.js';
import { estimateTokens } from './tokens.js';
import { NullCache } from './memory.js';

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
      return await run();
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
    model = DEFAULT_MODEL,
    cache = new NullCache(),
    context = {},
    maxQuestions = Infinity,
    concurrency = 2,
    maxRetries = 3,
    onProgress,
    onRetry,
    signal,
    fetchImpl = fetch,
    endpoint,
    atByText = new Map(),
    useCache = true,
    log = null,
  } = options;

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
        const body = buildRequest(chunk, { rule, model, ...context });
        const data = await withRetry(
          () => ask({ apiKey, body, signal, fetchImpl, ...(endpoint ? { endpoint } : {}) }),
          { maxRetries, signal, onRetry },
        );
        const answers = parseAnswers(data, chunk.length, rule);
        for (let i = 0; i < chunk.length; i++) {
          const text = chunk[i].text;
          results.set(text, { ...answers[i], source: 'api' });
          if (useCache) cache.set(await cacheKey(rule, model, text), { c: answers[i].choice, v: answers[i].severity, m: model, r: rule.id });
        }
        stats.requested += chunk.length;
        stats.inputTokens += data?.usage?.input_tokens ?? estimateTokens(body);
        log?.(`批次 ${index + 1}/${chunks.length}：${chunk.length} 条，模型 ${data?.model ?? model}`);
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
