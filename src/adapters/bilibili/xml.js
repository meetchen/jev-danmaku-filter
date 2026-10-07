// 旧版弹幕接口 /x/v1/dm/list.so 返回 deflate 压缩的 XML。
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  }).replace(/\r/g, '');
}

// p 属性顺序：进度(秒), 模式, 字号, 颜色, 发送时间戳, 弹幕池, 发送者, 行号(dmid), 权重
export function parseDanmakuXml(xml, { max = 20_000 } = {}) {
  const items = [];
  const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = pattern.exec(xml)) && items.length < max) {
    const parts = match[1].split(',');
    const at = Number(parts[0]);
    const mode = Number(parts[1]) || 1;
    const id = parts[7] ? Number(parts[7]) : 0;
    const text = decodeEntities(match[2]).trim();
    if (!text || !Number.isFinite(at)) continue;
    items.push({ id, at, mode, text });
  }
  return items;
}
