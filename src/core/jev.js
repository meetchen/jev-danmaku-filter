import { estimateTokens } from './tokens.js';
import { SPOILER } from './rules.js';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
// 官方限制：state + questions ≤ 64K token；state + 最长单问 ≤ 32K。留安全余量。
export const MAX_CONTEXT_TOKENS = 60_000;
export const MAX_SINGLE_TOKENS = 28_000;

export function buildState(entries, { rule = SPOILER, title = '', description = '', extra = {} } = {}) {
  return {
    task: 'Judge every entry of state.entries.',
    // score 的 level 描述同时放在 state 里一份：instructions 引用 state.levels，
    // 这份只出现一次，不随条目数增长，成本可忽略。
    ...(rule.levels ? { levels: rule.levels.map((description, level) => ({ level, description })) } : {}),
    ...(rule.policy ? { policy: rule.policy } : {}),
    video: { title, description, ...extra },
    entries: entries.map((entry, i) => ({ i, text: entry.text, at: entry.at == null ? null : Math.round(entry.at) })),
  };
}

export function buildQuestions(count, rule = SPOILER) {
  const questions = {};
  for (let i = 0; i < count; i++) {
    if (rule.type === 'score') {
      questions[`e${i}`] = { type: 'score', instructions: rule.instruction.replace('%s', String(i)), criteria: rule.levels };
    } else if (rule.type === 'noul') {
      questions[`e${i}`] = { type: 'noul', instructions: rule.question.replace('%s', String(i)) };
    } else {
      questions[`e${i}`] = {
        type: 'choice',
        instructions: { task: `Apply state.policy to entries[${i}] only. ${rule.task ?? ''}`.trim() },
        criteria: rule.criteria,
      };
    }
  }
  return questions;
}

export function buildRequest(entries, options = {}) {
  const rule = options.rule ?? SPOILER;
  return {
    model: options.model ?? DEFAULT_MODEL,
    state: buildState(entries, { ...options, rule }),
    questions: buildQuestions(entries.length, rule),
  };
}

// 每条 question 的固定开销，用于批次切分。
export function questionTokenCost(rule = SPOILER) {
  const [sample] = Object.values(buildQuestions(1, rule));
  return estimateTokens(sample);
}

/** 把回答归一化成 { choice, score, source 可读 }。noul 返回 0~1，choice 返回选项名。 */
export function parseAnswers(data, count, rule = SPOILER) {
  const out = [];
  const positive = rule.options[0];
  const negative = rule.options[1];
  const threshold = rule.threshold ?? 0.5;
  for (let i = 0; i < count; i++) {
    const answer = data?.answers?.[`e${i}`];
    if (!answer) throw new Error(`JEV 返回格式异常：缺少 answers.e${i}。`);
    if (rule.type === 'score') {
      if (answer.type !== 'score' || typeof answer.score !== 'number') throw new Error(`JEV 返回格式异常：answers.e${i} 不是 score。`);
      const top = rule.levels.length - 1;
      const severity = answer.score / top;                 // 归一化到 0~1，让不同级数的量表可比
      out.push({ choice: severity >= threshold ? positive : negative, severity, score: answer.score, confidence: answer.confidence ?? null, probabilities: answer.probabilities ?? null });
    } else if (rule.type === 'noul') {
      if (typeof answer.noul !== 'number') throw new Error(`JEV 返回格式异常：answers.e${i} 不是 noul。`);
      out.push({ choice: answer.noul >= threshold ? positive : negative, severity: answer.noul, score: answer.noul, confidence: null, probabilities: null });
    } else {
      if (answer.type !== 'choice' || !rule.options.includes(answer.choice)) {
        throw new Error(`JEV 返回格式异常：answers.e${i} 不是合法的 choice。`);
      }
      const probability = answer.probabilities?.[positive];
      const choice = typeof probability === 'number' ? (probability >= threshold ? positive : negative) : answer.choice;
      out.push({ choice, severity: probability ?? null, score: probability ?? null, confidence: answer.confidence ?? null, probabilities: answer.probabilities ?? null });
    }
  }
  return out;
}

export class JevError extends Error {
  constructor(message, { status = 0, retryable = false, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

export async function ask({ apiKey, body, signal, fetchImpl = fetch, endpoint = ENDPOINT }) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new JevError(`无法连接 JEV：${error.message}`, { retryable: true });
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers?.get?.('retry-after')) || 0;
    const detail = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) throw new JevError('API Key 无效或没有权限。', { status: response.status });
    if (response.status === 402) throw new JevError('TypeSafe 账户额度不足。', { status: response.status });
    if (response.status === 429 || response.status === 529 || response.status >= 500) {
      throw new JevError(`JEV 限流或不可用（HTTP ${response.status}）。`, { status: response.status, retryable: true, retryAfter });
    }
    throw new JevError(`JEV 请求失败（HTTP ${response.status}）：${detail.slice(0, 200)}`, { status: response.status });
  }
  return response.json();
}
