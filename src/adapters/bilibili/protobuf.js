// B 站弹幕分段接口 /x/v2/dm/web/seg.so 返回的 DmSegMobileReply。
// 顶层结构：field 1 = repeated DanmakuElem（length-delimited），其余字段（state / ai_flag / config）原样保留。
// 因为只需要按"整段 span"丢弃或保留，重编码是无损拼接，不会破坏播放器解析。
const MAX_BYTES = 8 * 1024 * 1024;

function readVarint(bytes, pos) {
  let result = 0;
  let factor = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new Error('protobuf: varint 被截断');
    const byte = bytes[pos++];
    result += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return [result, pos];
    factor *= 128;
  }
  throw new Error('protobuf: varint 过长');
}

/** 把一段 buffer 解析成字段 span，保留原始起止位置，便于无损重编码。 */
export function readFields(bytes) {
  const fields = [];
  let pos = 0;
  while (pos < bytes.length) {
    const start = pos;
    let tag;
    [tag, pos] = readVarint(bytes, pos);
    const wire = tag & 7;
    const field = tag >>> 3;
    if (field === 0) throw new Error('protobuf: 非法字段号');
    let span;
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(bytes, pos);
      span = { field, wire, start, end: pos, value };
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(bytes, pos);
      if (length > bytes.length - pos) throw new Error('protobuf: length-delimited 长度越界');
      const valueStart = pos;
      pos += length;
      span = { field, wire, start, end: pos, valueStart };
    } else if (wire === 1) {
      pos += 8;
      span = { field, wire, start, end: pos };
    } else if (wire === 5) {
      pos += 4;
      span = { field, wire, start, end: pos };
    } else {
      throw new Error(`protobuf: 不支持的 wire 类型 ${wire}`);
    }
    if (pos > bytes.length) throw new Error('protobuf: 字段被截断');
    fields.push(span);
  }
  return fields;
}

const asBytes = buffer => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));

/** 单条 DanmakuElem 的字段：1=id(64bit) 2=progress(ms) 3=mode 4=fontsize 5=color 6=midHash 7=content 8=ctime */
export function decodeElem(inner, decoder = new TextDecoder()) {
  let id = 0;
  let at = 0;
  let mode = 1;
  let text = '';
  for (const f of readFields(inner)) {
    if (f.wire === 0) {
      if (f.field === 1) id = f.value;
      else if (f.field === 2) at = f.value / 1000;
      else if (f.field === 3) mode = f.value;
    } else if (f.wire === 2 && f.field === 7) {
      text = decoder.decode(inner.subarray(f.valueStart, f.end));
    }
  }
  return { id, at, mode, text };
}

/** 解码一个分段，返回 [{ id, at(秒), mode, text }]。解析失败由调用方决定是否降级。 */
export function decodeSegment(buffer, { max = 20_000 } = {}) {
  const bytes = asBytes(buffer);
  if (bytes.length > MAX_BYTES) throw new Error('protobuf: 分段过大');
  const decoder = new TextDecoder('utf-8');
  const items = [];
  for (const span of readFields(bytes)) {
    if (span.field !== 1 || span.wire !== 2) continue;
    const elem = decodeElem(bytes.subarray(span.valueStart, span.end), decoder);
    if (!elem.text) continue;
    items.push(elem);
    if (items.length >= max) break;
  }
  return items;
}

/**
 * 从分段里剔除命中的弹幕，返回新的 Uint8Array。
 * isBlocked(text) 为 true 的 DanmakuElem 整体丢弃，其它字段逐字节保留。
 */
export function filterSegment(buffer, isBlocked) {
  const bytes = asBytes(buffer);
  const decoder = new TextDecoder('utf-8');
  const keep = [];
  let dropped = 0;
  let total = 0;
  for (const span of readFields(bytes)) {
    if (span.field === 1 && span.wire === 2) {
      total += 1;
      const elem = decodeElem(bytes.subarray(span.valueStart, span.end), decoder);
      if (elem.text && isBlocked(elem.text, elem)) { dropped += 1; continue; }
    }
    keep.push(bytes.subarray(span.start, span.end));
  }
  const size = keep.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of keep) { out.set(part, offset); offset += part.length; }
  return { bytes: out, total, dropped };
}
