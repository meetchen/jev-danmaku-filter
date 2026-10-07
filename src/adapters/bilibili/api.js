// Node / CLI 专用：浏览器端不要 import 这个文件（有静态 node:zlib 依赖）。
import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { collectSegments } from './collect.js';
import { parseDanmakuXml } from './xml.js';
import { normalizeEpisode, normalizeVideo, parseVideoRef, pgcUrl, segmentUrl, viewUrl, xmlUrl } from './urls.js';

export { parseVideoRef, normalizeDuration, SEGMENT_SECONDS, segmentUrl, viewUrl, xmlUrl, pgcUrl } from './urls.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HEADERS = { Referer: 'https://www.bilibili.com/', 'User-Agent': UA, Accept: '*/*' };

async function requestBytes(url, { signal, timeout = 20_000, fetchImpl = fetch } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchImpl(url, { headers: HEADERS, signal: combined, redirect: 'follow' });
  if (!response.ok) throw new Error(`B 站接口 HTTP ${response.status}：${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function requestJson(url, options = {}) {
  const bytes = await requestBytes(url, options);
  const json = JSON.parse(new TextDecoder().decode(bytes));
  if (json.code !== 0) throw new Error(`B 站接口返回错误 ${json.code}：${json.message || url}`);
  return json.result ?? json.data;
}

export async function resolveVideo(input, options = {}) {
  const ref = parseVideoRef(input);
  // 番剧走 pgc season 接口：番剧页没有 __INITIAL_STATE__，bvid 也不在 URL 里。
  if (ref.epId) return normalizeEpisode(await requestJson(pgcUrl(ref.epId), options), ref.epId);
  return normalizeVideo(await requestJson(viewUrl(input), options), options.pageNumber);
}

export function fetchSegments(video, options = {}) {
  return collectSegments({ ...video, fetchBytes: (url, extra) => requestBytes(url, { ...options, ...extra }) });
}

/**
 * list.so 返回 deflate 压缩的 XML，但 Node fetch 会按 content-encoding 自动解压，
 * 所以拿到的可能已经是明文。按 magic 判断，别再 inflate 一次（否则报
 * "too many length or distance symbols"）。
 */
export function decodeXmlBytes(bytes) {
  if (bytes[0] === 0x3c) return new TextDecoder('utf-8').decode(bytes); // '<?'
  for (const inflate of [inflateSync, inflateRawSync, gunzipSync]) {
    try { return inflate(bytes).toString('utf8'); } catch { /* 换下一个 */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** 全量 XML 弹幕（maxlimit 6000~7200 条）。实测比分段接口稳定，作为主源。 */
export async function fetchXml(cid, options = {}) {
  return parseDanmakuXml(decodeXmlBytes(await requestBytes(xmlUrl(cid), options)));
}

export async function fetchDanmaku(input, options = {}) {
  const video = options.video ?? await resolveVideo(input, options);
  if (!video.cid) throw new Error('拿不到 cid，无法获取弹幕。');
  let items = [];
  let source = 'list.so';
  try {
    items = await fetchXml(video.cid, options);
  } catch (error) {
    if (options.log) options.log(`list.so 失败（${error.message}），改用 seg.so`);
    source = 'seg.so';
  }
  if (!items.length) {
    items = await fetchSegments(video, options);
    source = 'seg.so';
  }
  return { video, items, source };
}
