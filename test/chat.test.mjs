import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, parseChatAnswers, systemPrompt, userPrompt } from '../src/core/backends/chat.js';
import { SPOILER } from '../src/core/rules.js';

const reply = content => ({ choices: [{ message: { content } }] });
const top = SPOILER.levels.length - 1;

test('请求体把量表原样带进 prompt，且不随条目数重复', () => {
  const body = buildChatRequest([{ text: '甲' }, { text: '乙' }], SPOILER, { model: 'qwen-flash', title: '某剧' });
  assert.equal(body.model, 'qwen-flash');
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: 'json_object' }, '阿里要求 JSON 模式时 prompt 里必须提到 JSON');
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
  for (const level of SPOILER.levels) assert.ok(body.messages[0].content.includes(level), '每级描述都要出现');
  assert.match(body.messages[1].content, /\[0\] 甲/);
  assert.match(body.messages[1].content, /\[1\] 乙/);
  assert.match(body.messages[1].content, /某剧/);
});

test('超长弹幕会被截断，避免撑爆上下文', () => {
  const body = buildChatRequest([{ text: 'x'.repeat(5000) }], SPOILER, { model: 'm' });
  assert.ok(body.messages[1].content.length < 1000, '单条不该原样塞进去');
});

test('解析：正常 JSON 映射成归一化严重度', () => {
  const { severities, missing } = parseChatAnswers(reply('{"results":[{"i":0,"score":4},{"i":1,"score":2},{"i":2,"score":0}]}'), 3, SPOILER);
  assert.deepEqual(severities, [1, 2 / top, 0]);
  assert.deepEqual(missing, []);
});

test('解析：容忍 markdown 代码块包裹', () => {
  const { severities } = parseChatAnswers(reply('```json\n{"results":[{"i":0,"score":1}]}\n```'), 1, SPOILER);
  assert.deepEqual(severities, [1 / top]);
});

test('解析：越界与非法条目被忽略并记为缺失，而不是当成 0', () => {
  const { severities, missing } = parseChatAnswers(
    reply('{"results":[{"i":0,"score":3},{"i":9,"score":4},{"i":"x","score":1},{"i":2,"score":"不是数字"}]}'),
    3, SPOILER,
  );
  assert.equal(severities[0], 3 / top);
  assert.equal(severities[1], null);
  assert.equal(severities[2], null);
  assert.deepEqual(missing, [1, 2], '越界和非法值必须算缺失，触发重试');
});

test('解析：分数越界被夹到量表范围内', () => {
  const { severities } = parseChatAnswers(reply('{"results":[{"i":0,"score":99},{"i":1,"score":-5}]}'), 2, SPOILER);
  assert.equal(severities[0], 1);
  assert.equal(severities[1], 0);
});

test('解析：各种畸形输出都抛错（交给重试），不会静默当成全部正常', () => {
  for (const bad of ['', '不是 JSON', '{"results":"不是数组"}', '{"foo":1}', '[]']) {
    assert.throws(() => parseChatAnswers(reply(bad), 2, SPOILER), Error, `「${bad}」应该抛错`);
  }
  assert.throws(() => parseChatAnswers({ choices: [] }, 2, SPOILER));
  assert.throws(() => parseChatAnswers({}, 2, SPOILER));
});

test('prompt 里的等级编号与量表一致', () => {
  const prompt = systemPrompt(SPOILER);
  assert.match(prompt, new RegExp(`0~${top}`));
  assert.match(prompt, /只输出 JSON/);
  assert.ok(userPrompt([{ text: '甲' }], {}).includes('[0] 甲'));
});
