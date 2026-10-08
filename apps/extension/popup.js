import { PROVIDERS, resolveProvider, endpointOrigin } from './vendor/core/providers.js';

const $ = id => document.getElementById(id);
let state = null;

const send = async message => {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。');
  return result;
};

function renderProviders() {
  const select = $('provider');
  if (select.options.length) return;
  for (const provider of state.providers ?? []) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    option.dataset.hint = provider.hint ?? '';
    option.dataset.docs = provider.docs ?? '';
    option.dataset.needsWorkspace = String(Boolean(provider.needsWorkspace));
    option.dataset.model = provider.model ?? '';
    select.append(option);
  }
}

function syncProviderFields() {
  const option = $('provider').selectedOptions[0];
  const needsWorkspace = option?.dataset.needsWorkspace === 'true';
  $('provider-hint').textContent = [
    option?.dataset.hint ?? '',
    needsWorkspace ? '地址填 ws-xxxx（业务空间 ID）或控制台给你的完整域名都可以，面板会自动补全。' : '',
  ].filter(Boolean).join(' ');
  $('provider-docs').href = option?.dataset.docs || 'https://console.typesafe.ai/';
  $('workspace').hidden = !needsWorkspace;
  $('workspace-label').hidden = !needsWorkspace;
}

function render() {
  renderProviders();
  $('enabled').checked = state.enabled;
  $('provider').value = state.provider ?? 'typesafe';
  $('workspace').value = state.workspaceId ?? '';
  $('endpoint').value = state.endpointOverride ?? '';
  $('model').value = state.modelOverride ?? '';
  syncProviderFields();

  $('connection').open = !state.configured || !state.providerReady;
  const target = state.providerLabel ? `${state.providerLabel} · ${state.model}` : state.model;
  const text = state.error
    || (!state.configured ? '先填 API Key。'
      : !state.providerReady ? '判定后端还缺配置（多半是业务空间 ID）。'
        : !state.enabled ? '已关闭，弹幕恢复原样。'
          : `已开启 · ${target} · 缓存 ${state.cached} 条 · 今日 ${state.usedToday ?? 0}/${state.dailyBudget ?? '-'} 条`);
  $('status').textContent = text;
  $('status').className = state.error ? 'error' : '';
}

$('enabled').onchange = async event => {
  try { state = await send({ type: 'SAVE', enabled: event.target.checked }); }
  catch (error) { state = { ...state, error: error.message }; }
  render();
};

$('provider').onchange = syncProviderFields;

$('connect-form').onsubmit = async event => {
  event.preventDefault();
  $('connect').disabled = true;
  $('status').textContent = '正在保存…';
  $('status').className = '';
  try {
    const draft = {
      provider: $('provider').value,
      workspaceId: $('workspace').value.trim(),
      endpoint: $('endpoint').value.trim(),
      model: $('model').value.trim(),
    };
    // 自定义地址不在 manifest 的固定 host_permissions 里，得当场申请运行时权限。
    const resolved = resolveProvider(draft);
    const origin = endpointOrigin(resolved.endpoint);
    if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(`没有拿到访问 ${origin} 的权限，无法调用该后端。`);
    }
    const key = $('api-key').value.trim();
    state = await send({ type: 'SAVE', ...draft, ...(key ? { apiKey: key } : {}) });
    state = await send({ type: 'TEST' });
    $('api-key').value = '';
    $('connection').open = false;
    $('status').textContent = '连接成功，刷新 B 站页面即可生效。';
    render();
    return;
  } catch (error) {
    state = { ...state, error: error.message };
  } finally {
    $('connect').disabled = false;
  }
  render();
};

send({ type: 'GET_STATE' }).then(result => { state = result; render(); }).catch(error => {
  $('status').textContent = error.message; $('status').className = 'error';
});
