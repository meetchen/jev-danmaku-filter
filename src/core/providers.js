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
    label: 'TypeSafe 官方',
    hint: '官方 jev-latest。需自行准备可访问 api.typesafe.ai 的网络环境。',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    // 官方明确说「加问题几乎不改变响应时间」，所以批量只受 state+questions ≤ 64K token 约束。
    maxQuestions: 500,
    docs: 'https://console.typesafe.ai/',
  },
  bailian: {
    id: 'bailian',
    label: '阿里云百炼 · 决策模型',
    hint: '国内直连。需要业务空间 ID（百炼控制台可见），模型名 decision-model-preview。',
    endpoint: 'https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone',
    endpointPath: '/compatible-mode/v1/systemone',
    model: 'decision-model-preview',
    // 官方文档：问题数不设上限，但「建议 ≤ 16，延迟随问题数近线性增长」。
    // 这里取 32 折中 —— 问题数越多单次越慢，但请求数越少，实测后再调。
    maxQuestions: 32,
    needsWorkspace: true,
    docs: 'https://help.aliyun.com/zh/model-studio/decision-model-api',
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
    label: preset.label,
    endpoint,
    model: String(settings.model ?? '').trim() || preset.model,
    maxQuestions: preset.maxQuestions,
    configured: !unresolved,
    needsWorkspace: Boolean(preset.needsWorkspace),
  };
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
