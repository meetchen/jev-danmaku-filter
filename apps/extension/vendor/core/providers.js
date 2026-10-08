/**
 * 判定后端。TypeSafe System One 的协议已经成了事实标准 —— 阿里云百炼的「决策模型」
 * 是兼容实现：同样的 POST /systemone、同样的 state + typed questions、同样的
 * {choice|noul|score, probabilities, confidence} 返回。
 *
 * 所以换厂商不需要动核心逻辑（buildRequest / parseAnswers 完全复用），只需要换地址、
 * 模型名，以及按各家特性调整批量大小。
 *
 * 新增一家：在这里加一条，然后同步 apps/extension/manifest.json 的 host_permissions。
 * （test/versions.test.mjs 里有一条测试会遍历所有 provider 的默认 endpoint，
 *   校验它被 manifest 的 host_permissions 覆盖，漏改会直接失败。）
 *
 * 关于通配符的边界：Chrome 的 host 通配符是纯字符串后缀匹配
 * （见 Chromium extensions/common/url_pattern.cc 的 MatchesHost：
 *  EndsWith(test_host, pattern_host) && 前一个字符是 '.'），**不限制层级数**。
 * 所以 *.maas.aliyuncs.com 能覆盖 ws-abc.cn-beijing.maas.aliyuncs.com 这种两级子域。
 */
export const PROVIDERS = {
  typesafe: {
    id: 'typesafe',
    kind: 'systemone',                       // 原生 typed questions + 概率分布
    label: 'TypeSafe 官方',
    envKey: 'TYPESAFE_API_KEY',
    hint: '官方 jev-latest。需自行准备可访问 api.typesafe.ai 的网络环境。',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    // 官方明确说「加问题几乎不改变响应时间」，所以批量只受 state+questions ≤ 64K token 约束。
    maxQuestions: 500,
    docs: 'https://console.typesafe.ai/',
    docsLabel: '去 TypeSafe 控制台拿 API Key ↗',
  },
  bailian: {
    id: 'bailian',
    kind: 'systemone',
    label: '阿里云百炼 · 决策模型',
    envKey: 'DASHSCOPE_API_KEY',
    hint: '国内直连。需要业务空间 ID（百炼控制台可见），模型名 decision-model-preview。',
    endpoint: 'https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone',
    endpointPath: '/compatible-mode/v1/systemone',
    model: 'decision-model-preview',
    // 官方文档写「问题数不设上限（建议 ≤ 16）」，但**接口实际是硬限制**：
    // 超过就 400「questions: N exceeds the limit of 16」。所以这里必须是 16。
    maxQuestions: 16,
    // 这个模型的量表刻度与 JEV 不一致，整体压低（实测正样本落在 0.23~0.70，
    // 而 JEV 落在 0.61~0.77）。所以阈值必须能按后端单独标定，不能全局共用一个。
    // 实测：阈值 0.6 → F1 0.35（recall 仅 0.25）；阈值 0.4 → F1 0.77。
    threshold: 0.4,
    needsWorkspace: true,
    docs: 'https://bailian.console.aliyun.com/',
    docsLabel: '去百炼控制台拿 API Key 和接口地址 ↗',
  },
  bailianChat: {
    id: 'bailianChat',
    // 聊天模型没有 typed questions，也没有原生概率分布，得自己拼 prompt 要 JSON。
    // 好处是**不需要业务空间**，一个 sk- key 就能用。
    kind: 'chat',
    label: '阿里云百炼 · 聊天模型',
    envKey: 'DASHSCOPE_API_KEY',
    hint: '不需要业务空间，国内直连。用聊天模型模拟判定，精度与延迟需要实测。',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-flash',
    // 聊天模型是顺序生成，总时长由生成量决定，跟批量几乎无关（实测 80/160/320 条
    // 都是约 87ms/条，且都不漏条）。所以批量取大些：请求数少、量表只带一次、单条更便宜。
    // 全片 6672 条约 60~75 秒（并发 8），比 System One 后端的 ~9 秒慢一个量级。
    maxQuestions: 160,
    docs: 'https://bailian.console.aliyun.com/',
    docsLabel: '去百炼控制台拿 API Key ↗',
  },
};

export const DEFAULT_PROVIDER = 'typesafe';

/**
 * 把用户填的东西归一化成完整 endpoint。控制台给用户的可能是三种形态中的任意一种，
 * 不该让他自己去挖出「业务空间 ID」这四个字：
 *   ws-1j23p7rfkx9a1ocj                                             → 补全成北京地域
 *   ws-1j23p7rfkx9a1ocj.cn-beijing.maas.aliyuncs.com                → 补全 scheme 与路径
 *   https://ws-….cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone → 原样用
 */
export function normalizeEndpoint(input, preset) {
  const value = String(input ?? '').trim();
  if (!value) return preset.endpoint;
  if (/^https?:\/\//i.test(value)) return value;                    // 完整 URL，直接用
  if (value.includes('/')) return `https://${value}`;                // host + 路径，只补 scheme
  if (value.includes('.')) return `https://${value}${preset.endpointPath ?? ''}`;  // 主机名，补路径
  return preset.endpoint.replace('{workspaceId}', value);            // 只有 workspace id
}

/** 把设置解析成实际要用的 {endpoint, model, maxQuestions}。设置里的值优先于预设。 */
export function resolveProvider(settings = {}) {
  const preset = PROVIDERS[settings.provider] ?? PROVIDERS[DEFAULT_PROVIDER];
  // workspaceId 与 endpoint 谁填了都行，endpoint 更宽（能接受主机名和完整 URL）。
  const raw = String(settings.endpoint ?? '').trim() || String(settings.workspaceId ?? '').trim();
  const endpoint = normalizeEndpoint(raw, preset);

  const unresolved = endpoint.includes('{') || (preset.needsWorkspace && !raw);
  return {
    id: preset.id,
    kind: preset.kind,
    label: preset.label,
    endpoint,
    model: String(settings.model ?? '').trim() || preset.model,
    maxQuestions: preset.maxQuestions,
    // 后端可覆盖全局阈值。不同厂商的量表刻度不一样，共用一个阈值是错的。
    threshold: preset.threshold,
    // 每个后端读自己的环境变量名，否则 .env 里同时有两条 key 时必然抓错一条。
    envKey: preset.envKey ?? 'TYPESAFE_API_KEY',
    configured: !unresolved,
    needsWorkspace: Boolean(preset.needsWorkspace),
  };
}

/**
 * 从判定端点推出「列出可用模型」的地址。两家都是 OpenAI 兼容风格：
 * System One 端点是 .../v1/systemone，模型列表是 .../v1/models。
 * 模型名报错时用它来自动诊断「这个 Key 到底能用哪些模型」。
 */
export function modelsEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    // 两家的判定端点分别是 .../v1/systemone 与 .../v1/chat/completions，模型列表都是 .../v1/models
    if (!/\/(systemone|chat\/completions)\/?$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/(systemone|chat\/completions)\/?$/, '/models');
    return url.toString();
  } catch { return null; }
}

/** endpoint 属于哪个主机，用于申请运行时权限。 */
export function endpointOrigin(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}
