/**
 * 测试用假站点。故意用一套和 B 站完全不同的数据形状（JSON 数组，不是 protobuf），
 * 用来验证 page-runtime 确实只通过站点描述符接口工作 —— 加站点不需要改通信层。
 */
export const fakeSite = {
  id: 'fake',
  label: '测试站点',
  domSelector: '.fake-danmaku',

  matches: href => String(href).startsWith('https://fake.example/watch/'),

  async resolve() {
    return { source: 'fake', cid: 'vid-1', title: '假视频标题', description: '假简介', duration: 60 };
  },

  isDanmakuResponse: url => String(url).includes('/fake/danmaku.json'),

  decodeTexts(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes)).map(item => item.text).filter(Boolean);
  },

  filterBytes(bytes, isBlocked) {
    const items = JSON.parse(new TextDecoder().decode(bytes));
    const kept = items.filter(item => !isBlocked(item.text));
    return { bytes: new TextEncoder().encode(JSON.stringify(kept)), dropped: items.length - kept.length, total: items.length };
  },

  async warmup() {
    return ['预热文本甲', '预热文本乙'];
  },
};
