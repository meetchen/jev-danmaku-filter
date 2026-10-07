// 粗略 token 估算，只用于在发请求前切分批次，避免超过 JEV 的 64K / 32K 上下文预算。
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\u3040-\u30FF]/u;

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  let cjk = 0;
  let rest = 0;
  for (const ch of text) { if (CJK.test(ch)) cjk++; else rest++; }
  // CJK 常常 1 字 ≈ 1~2 token，取 1.4 留出余量；ASCII 约 4 字符 1 token。
  return Math.ceil(cjk * 1.4 + rest / 3.2) + 4;
}
