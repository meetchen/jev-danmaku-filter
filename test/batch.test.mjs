import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkEntries, classifyTexts } from '../src/core/batch.js';
import { SPOILER } from '../src/core/rules.js';
import { buildRequest, parseAnswers, MAX_CONTEXT_TOKENS } from '../src/core/jev.js';
import { estimateTokens } from '../src/core/tokens.js';

const entries = n => Array.from({ length: n }, (_, i) => ({ text: `第${i}条弹幕，这里有一些中文内容用来撑一点长度`, at: i }));

test('批次切分不越过 64K 上下文预算', () => {
  const chunks = chunkEntries(entries(4000), { rule: SPOILER });
  assert.ok(chunks.length > 1);
  const joined = chunks.flat();
  assert.equal(joined.length, 4000);
  for (const chunk of chunks) {
    const body = buildRequest(chunk, { rule: SPOILER });
    assert.ok(estimateTokens(body) <= MAX_CONTEXT_TOKENS, `批次 ${chunk.length} 条超预算`);
    assert.ok(chunk.length > 0);
  }
});

test('单条超长弹幕不会把 state 撑爆', () => {
  const chunks = chunkEntries([{ text: 'x'.repeat(200_000) }], { rule: SPOILER });
  assert.equal(chunks.length, 1);
});

test('parseAnswers 把 score 归一化后按阈值判决', () => {
  // 5 级量表，最高级编号 4；threshold 0.6 → 需要 score >= 2.4
  const high = parseAnswers({ answers: { e0: { type: 'score', score: 3.2 } } }, 1, SPOILER);
  assert.equal(high[0].choice, 'spoiler');
  assert.equal(high[0].severity, 0.8);
  const low = parseAnswers({ answers: { e0: { type: 'score', score: 2.0 } } }, 1, SPOILER);
  assert.equal(low[0].choice, 'normal');
  assert.equal(low[0].severity, 0.5);
  assert.throws(() => parseAnswers({ answers: { e0: { type: 'noul', noul: 1 } } }, 1, SPOILER));
  assert.throws(() => parseAnswers({ answers: {} }, 1, SPOILER));
});

test('批量判断：命中的文本写缓存且第二次不再请求', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const answers = {};
    for (const [key, question] of Object.entries(body.questions)) {
      const index = Number(key.slice(1));
      const spoils = body.state.entries[index].text.includes('剧透');
      answers[key] = { type: 'score', score: spoils ? 4 : 0, confidence: 0.9, probabilities: {} };
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: body.model, usage: { input_tokens: 321 } }) };
  };
  const store = new Map();
  const cache = { get: k => store.get(k), set: (k, v) => store.set(k, v), save: async () => {} };

  const texts = ['这条是剧透结局', '普通弹幕', '剧透剧透'];
  const first = await classifyTexts(texts, { apiKey: 'k', cache, fetchImpl });
  assert.equal(first.results.get('这条是剧透结局').choice, 'spoiler');
  assert.equal(first.results.get('普通弹幕').choice, 'normal');
  assert.equal(first.stats.requested, 3);
  assert.equal(seen.length, 1);

  const second = await classifyTexts(texts, { apiKey: 'k', cache, fetchImpl });
  assert.equal(second.stats.cached, 3);
  assert.equal(second.stats.requested, 0);
  assert.equal(seen.length, 1);
});

test('限流错误按 retry-after 重试后成功', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'slow down' };
    }
    const body = JSON.parse(init.body);
    const answers = {};
    for (const key of Object.keys(body.questions)) answers[key] = { type: 'score', score: 0, probabilities: {} };
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  const { results } = await classifyTexts(['a'], { apiKey: 'k', fetchImpl, useCache: false });
  assert.equal(results.get('a').choice, 'normal');
  assert.equal(calls, 2);
});

test('401 不重试，直接报错', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 401, headers: { get: () => null }, text: async () => 'nope' }; };
  await assert.rejects(() => classifyTexts(['a'], { apiKey: 'bad', fetchImpl, useCache: false }), /API Key/);
  assert.equal(calls, 1);
});
