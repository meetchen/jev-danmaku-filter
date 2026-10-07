const $ = id => document.getElementById(id);
let state = null;

const send = async message => {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。');
  return result;
};

function render() {
  $('enabled').checked = state.enabled;
  $('connection').open = !state.configured;
  const text = state.error
    || (!state.configured ? '先连接 JEV，填一次 API Key 即可。'
      : !state.enabled ? '已关闭，弹幕恢复原样。'
        : `已开启 · 缓存 ${state.cached} 条 · 今日已判定 ${state.usedToday ?? 0}/${state.dailyBudget ?? '-'} 条`);
  $('status').textContent = text;
  $('status').className = state.error ? 'error' : '';
}

$('enabled').onchange = async event => {
  try { state = await send({ type: 'SAVE', enabled: event.target.checked }); }
  catch (error) { state = { ...state, error: error.message }; }
  render();
};

$('connect-form').onsubmit = async event => {
  event.preventDefault();
  const key = $('api-key').value.trim();
  $('status').textContent = '正在测试…';
  try {
    if (key) state = await send({ type: 'SAVE', apiKey: key });
    state = await send({ type: 'TEST' });
    $('api-key').value = '';
    $('connection').open = false;
    $('status').textContent = '连接成功，刷新 B 站页面即可生效。';
  } catch (error) {
    state = { ...state, error: error.message };
  }
  render();
};

send({ type: 'GET_STATE' }).then(result => { state = result; render(); }).catch(error => {
  $('status').textContent = error.message; $('status').className = 'error';
});
