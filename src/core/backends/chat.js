/**
 * 聊天模型后端。国内大模型的 API 都是 OpenAI 兼容的，但它们是「生成」模型，
 * 不是 JEV 那种 System One 决策模型：没有 typed questions，也没有原生概率分布。
 *
 * 所以这里自己拼 prompt、要求返回 JSON、解析并校验，格式不对就重试。
 * 量表（rule.levels）与 System One 后端**共用同一份**，这样两边的 F1 才可比。
 *
 * 实测（29 条标注样本、白色巨塔 ep403700）：
 *   qwen-flash           614ms，无推理 token     ← 默认
 *   qwen3.8-flash       11.6s，499 推理 token
 *   deepseek-v4.1-flash  3.7s，287 推理 token
 * 分类任务上推理 token 纯属浪费，所以默认挑无推理的 flash 模型。
 */

/** prompt 里引用的条目上限，避免超长弹幕把上下文撑爆。 */
const MAX_TEXT = 400;

function rubric(rule) {
  return rule.levels.map((description, level) => `${level} = ${description}`).join('\n');
}

export function systemPrompt(rule) {
  const top = rule.levels.length - 1;
  return [
    '你是内容判定分类器，为每一条弹幕独立打一个严重度分数。',
    '',
    '判据：',
    rubric(rule),
    '',
    '输出要求：',
    '- 只输出 JSON，不要解释，不要 markdown 代码块',
    '- 格式：{"results":[{"i":0,"score":3.2},{"i":1,"score":0}]}',
    `- results 必须覆盖每一条，i 是条目编号，score 是 0~${top} 的数字`,
    '- score 允许一位小数，例如 2.5 表示介于 2 和 3 之间',
    '- 每条只看它自己的文字，不要互相参考；拿不准就给中间值',
  ].join('\n');
}

export function userPrompt(entries, { title = '', description = '' } = {}) {
  const header = [title && `视频：${title}`, description && `简介：${description.slice(0, 300)}`]
    .filter(Boolean).join('\n');
  const list = entries.map((entry, i) => `[${i}] ${String(entry.text ?? '').slice(0, MAX_TEXT)}`).join('\n');
  return `${header}\n\n弹幕：\n${list}`;
}

export function buildChatRequest(entries, rule, { model, title, description } = {}) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt(rule) },
      { role: 'user', content: userPrompt(entries, { title, description }) },
    ],
    // 阿里文档要求 JSON 模式时 prompt 里必须提到 JSON，否则报错 —— 上面已经写了。
    response_format: { type: 'json_object' },
    temperature: 0,
  };
}

/**
 * @returns {{severities: (number|null)[], missing: number[]}}
 *   severities[i] 是归一化后的严重度（score / 最高级编号），缺失项为 null。
 *   归一化是为了让阈值在两家后端、任意级数的量表下都通用。
 */
export function parseChatAnswers(response, count, rule) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回内容。');

  let parsed;
  try {
    // 有些模型会好心包一层 ```json，容错一下
    parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error(`模型返回的不是合法 JSON：${content.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed?.results)) throw new Error('模型返回里没有 results 数组。');

  const top = rule.levels.length - 1;
  const severities = new Array(count).fill(null);
  for (const item of parsed.results) {
    const index = Number(item?.i);
    const score = Number(item?.score);
    if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isFinite(score)) continue;
    severities[index] = Math.min(Math.max(score, 0), top) / top;
  }
  return { severities, missing: severities.map((value, i) => (value === null ? i : -1)).filter(i => i >= 0) };
}

export function parseChatUsage(response) {
  const usage = response?.usage ?? {};
  return { inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
}
