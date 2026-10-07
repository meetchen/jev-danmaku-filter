import { decodeSegment } from './protobuf.js';
import { SEGMENT_SECONDS, segmentUrl } from './urls.js';

/**
 * 按 6 分钟一段拉完整片弹幕并去重。
 * fetchBytes 由调用方注入：CLI 用 Node fetch，扩展用页面来源的 fetch（绕开 B 站对扩展来源的 412）。
 */
export async function collectSegments({ cid, aid, duration, fetchBytes, delay = 250, limit = Infinity, signal, onSegment, decode = decodeSegment }) {
  const count = Math.max(1, Math.ceil((duration || 0) / SEGMENT_SECONDS));
  const seen = new Set();
  const items = [];
  for (let index = 1; index <= count; index++) {
    if (items.length >= limit) break;
    let segment;
    try {
      segment = decode(await fetchBytes(segmentUrl(cid, aid, index), { signal }));
    } catch (error) {
      if (index === 1) throw error;
      break; // 后续分段拉不到就停，保留已有结果
    }
    for (const item of segment) {
      const key = `${item.id}:${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
    onSegment?.({ index, count, got: segment.length, total: items.length });
    if (!segment.length) break;
    if (index < count && delay) await new Promise(resolve => setTimeout(resolve, delay));
  }
  return Number.isFinite(limit) ? items.slice(0, limit) : items;
}
