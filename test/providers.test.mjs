import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, resolveProvider, endpointOrigin, normalizeEndpoint, modelsEndpoint } from '../src/core/providers.js';
import { SPOILER } from '../src/core/rules.js';
import { buildRequest, parseAnswers } from '../src/core/jev.js';
import { chunkEntries, classifyTexts } from '../src/core/batch.js';
import { NullCache } from '../src/core/memory.js';

test('provider 解析：预设、模板替换、缺配置时明确不可用', () => {
  const typesafe = resolveProvider({ provider: 'typesafe' });
  assert.equal(typesafe.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(typesafe.model, 'jev-latest');
  assert.equal(typesafe.configured, true);

  const bailian = resolveProvider({ provider: 'bailian', workspaceId: 'ws-abc' });
  assert.equal(bailian.endpoint, 'https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone');
  assert.equal(bailian.model, 'decision-model-preview');
  assert.equal(bailian.configured, true);

  assert.equal(resolveProvider({ provider: 'bailian' }).configured, false, '没填 WorkspaceId 时必须报未配置，而不是发一个带 {workspaceId} 的地址出去');

  // 设置里的 endpoint / model 覆盖预设
  const custom = resolveProvider({ provider: 'typesafe', endpoint: 'https://my.gateway/systemone', model: 'my-model' });
  assert.equal(custom.endpoint, 'https://my.gateway/systemone');
  assert.equal(custom.model, 'my-model');
});

test('控制台给的三种形态都能填，不必自己去挖业务空间 ID', () => {
  // 用户从控制台拿到的是「地址」，不是「一个叫 workspace 的字段」。
  // 让他去地址里抠出 ID 是设计失误，这里三种形态都接受。
  const expected = 'https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone';
  for (const form of [
    'ws-abc',                                                    // 只有 ID
    'ws-abc.cn-beijing.maas.aliyuncs.com',                       // 主机名
    expected,                                                    // 完整 URL
    'https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone/',
  ]) {
    const resolved = resolveProvider({ provider: 'bailian', workspaceId: form });
    assert.equal(resolved.endpoint.replace(/\/$/, ''), expected, `「${form}」应归一化成同一个地址`);
    assert.equal(resolved.configured, true);
  }
  // 换地域也一样：主机名形态能自动补 /compatible-mode/v1/systemone
  assert.equal(
    resolveProvider({ provider: 'bailian', workspaceId: 'ws-abc.ap-southeast-1.maas.aliyuncs.com' }).endpoint,
    'https://ws-abc.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone',
  );
  // endpoint 与 workspaceId 任一填了都算配置好了
  assert.equal(resolveProvider({ provider: 'bailian', endpoint: 'https://custom/x' }).configured, true);
  assert.equal(normalizeEndpoint('', PROVIDERS.typesafe), PROVIDERS.typesafe.endpoint);
});

test('provider 的批量上限真的影响切分', () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ text: `第${i}条弹幕，有一点中文内容撑长度` }));
  const wide = chunkEntries(entries, { rule: SPOILER, maxQuestions: PROVIDERS.typesafe.maxQuestions });
  const narrow = chunkEntries(entries, { rule: SPOILER, maxQuestions: PROVIDERS.bailian.maxQuestions });
  assert.ok(wide.length < narrow.length, '阿里建议问题数更少，批次应该更多');
  assert.ok(narrow.every(chunk => chunk.length <= PROVIDERS.bailian.maxQuestions));
  assert.equal(wide.flat().length, narrow.flat().length, '切法不同但覆盖面必须一致');
});

test('请求体与厂商无关：同一份 state/questions 两家通用', () => {
  const entries = [{ text: '这条弹幕点名了结局', at: 12 }];
  const typesafe = buildRequest(entries, { rule: SPOILER, model: PROVIDERS.typesafe.model });
  const bailian = buildRequest(entries, { rule: SPOILER, model: PROVIDERS.bailian.model });
  // 除了 model 字段，其余必须逐字一致 —— 这就是「协议相同」的可验证形式
  assert.deepEqual({ ...typesafe, model: null }, { ...bailian, model: null });
  assert.deepEqual(Object.keys(typesafe), ['model', 'state', 'questions']);
  assert.equal(typesafe.questions.e0.type, 'score');
  assert.equal(typesafe.questions.e0.criteria.length, SPOILER.levels.length);
});

test('阿里文档里的真实返回样例能被现有解析器直接吃下', () => {
  // 来源：https://help.aliyun.com/zh/model-studio/decision-model-api 的「返回示例」
  const alibabaDocResponse = {
    model: 'decision-model-preview',
    request_id: '7b986c65-b223-9341-b5f0-b988e27ecaac',
    answers: {
      department: { type: 'choice', choice: 'billing', confidence: 0.88, probabilities: { billing: 0.94, technical: 0.06 } },
      escalate: { type: 'noul', noul: 0.99 },
      severity: {
        type: 'score', score: 2.25, confidence: 0.91,
        legend: { 0: '轻微问题，不影响功能', 1: '部分功能受影响，但存在替代方案', 2: '核心功能不可用，没有替代方案', 3: '造成严重业务或安全影响' },
        probabilities: { 0: 0.0, 1: 0.01, 2: 0.73, 3: 0.26 },
      },
    },
    usage: { input_tokens: 125 },
    latency_ms: 52.9,
  };

  const rule5 = SPOILER;                                      // 5 级量表
  const severity = parseAnswers({ answers: { e0: alibabaDocResponse.answers.severity } }, 1, rule5)[0];
  assert.equal(severity.score, 2.25);
  assert.equal(severity.severity, 2.25 / (rule5.levels.length - 1));
  assert.deepEqual(severity.probabilities, { 0: 0.0, 1: 0.01, 2: 0.73, 3: 0.26 });

  const noul = parseAnswers({ answers: { e0: alibabaDocResponse.answers.escalate } }, 1, {
    type: 'noul', options: ['spoiler', 'normal'], threshold: 0.5, question: 'x',
  })[0];
  assert.equal(noul.choice, 'spoiler');
  assert.equal(noul.severity, 0.99);

  const choice = parseAnswers({ answers: { e0: alibabaDocResponse.answers.department } }, 1, {
    type: 'choice', options: ['billing', 'technical'], threshold: 0.5, task: 'x', criteria: {},
  })[0];
  assert.equal(choice.choice, 'billing');
});

test('换 endpoint 只改地址：整条批量链路指向阿里也能跑通', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization });
    const body = JSON.parse(init.body);
    const answers = {};
    for (const key of Object.keys(body.questions)) answers[key] = { type: 'score', score: 4, probabilities: {}, confidence: 0.9 };
    return { ok: true, status: 200, json: async () => ({ model: body.model, answers, usage: { input_tokens: 100 }, latency_ms: 52.9 }) };
  };
  const provider = resolveProvider({ provider: 'bailian', workspaceId: 'ws-test' });

  const { results, stats } = await classifyTexts(['点名了结局的弹幕'], {
    apiKey: 'sk-test', rule: SPOILER, cache: new NullCache(), fetchImpl,
    endpoint: provider.endpoint, model: provider.model, maxQuestions: provider.maxQuestions,
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone');
  assert.equal(seen[0].auth, 'Bearer sk-test');
  assert.equal(results.get('点名了结局的弹幕').choice, 'spoiler');
  assert.equal(stats.inputTokens, 100, '阿里的 usage.input_tokens 要能正确读到');
});

test('endpointOrigin 用于申请运行时权限', () => {
  assert.equal(endpointOrigin('https://ws-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone'),
    'https://ws-1.cn-beijing.maas.aliyuncs.com/*');
  assert.equal(endpointOrigin('不是 URL'), null);
});

test('模型列表地址从判定端点推导出来（用于 model_not_found 自动诊断）', () => {
  assert.equal(
    modelsEndpoint('https://ws-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone'),
    'https://ws-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
  );
  assert.equal(
    modelsEndpoint('https://api.typesafe.ai/v1/systemone'),
    'https://api.typesafe.ai/v1/models',
  );
  assert.equal(modelsEndpoint('https://custom/endpoint'), null, '不是 /systemone 结尾就不该瞎猜');
  assert.equal(modelsEndpoint('乱写的'), null);
});
