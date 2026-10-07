import { RULE_VERSION } from './rules.js';

// 同时适用于 Node 20+ 与浏览器（Web Crypto），保证扩展端和 CLI 端缓存键一致。
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheKey(rule, model, text) {
  return sha256Hex([rule.id, RULE_VERSION, model, text].join('\u0000'));
}
