import { decodeSegment, filterSegment } from '../adapters/bilibili/protobuf.js';
import { parseDanmakuXml } from '../adapters/bilibili/xml.js';
import {
  normalizeDuration, normalizeEpisode, normalizeVideo, parseVideoRef, pgcUrl, viewUrl, xmlUrl,
} from '../adapters/bilibili/urls.js';

const SEGMENT_PATH = '/x/v2/dm/web/seg.so';

/**
 * 页面自带的播放数据是最快的来源，但它只在普通视频页存在 —— 番剧页没有 __INITIAL_STATE__，
 * 必须回落到 pgc 接口。这个差异是 B 站特有的，所以留在站点描述符里。
 */
function stateFromPage() {
  const state = globalThis.__INITIAL_STATE__;
  if (!state) return null;

  const episode = state.epInfo;
  if (episode?.cid) {
    return {
      source: 'bilibili',
      kind: 'bangumi',
      bvid: episode.bvid,
      aid: episode.aid,
      cid: episode.cid,
      title: episode.longTitle || episode.title || document.title,
      description: '',
      duration: normalizeDuration(episode.duration),
    };
  }

  const data = state.videoData;
  if (data?.cid) {
    // 多 P 视频：videoData.pages[] 里每 P 有自己的 cid / duration，必须按 ?p= 取。
    const index = Math.max(0, (Number(new URLSearchParams(location.search).get('p')) || 1) - 1);
    const page = data.pages?.[index] ?? data.pages?.[0];
    return {
      source: 'bilibili',
      kind: 'video',
      bvid: data.bvid,
      aid: data.aid,
      cid: page?.cid ?? data.cid,
      // 单 P 视频的 pages[0].part 就等于标题，直接拼会变成「标题 · 标题」。
      title: (page?.part && page.part !== data.title)
        ? `${data.title || document.title} · ${page.part}`
        : (data.title || document.title),
      description: data.desc || '',
      duration: normalizeDuration(page?.duration ?? data.duration),
    };
  }
  return null;
}

export const bilibili = {
  id: 'bilibili',
  label: '哔哩哔哩',
  domSelector: '.bili-danmaku-x-dm,.b-danmaku,.danmaku-item',

  matches(href) {
    try {
      const url = new URL(href);
      return url.hostname.endsWith('bilibili.com') && /^\/(video|list|bangumi\/play)\//.test(url.pathname);
    } catch { return false; }
  },

  async resolve({ fetchJson }) {
    const fromPage = stateFromPage();
    if (fromPage) return fromPage;
    const ref = parseVideoRef(location.href);
    if (ref.epId) return normalizeEpisode(await fetchJson(pgcUrl(ref.epId)), ref.epId);
    const page = new URLSearchParams(location.search).get('p');
    return normalizeVideo(await fetchJson(viewUrl(location.href)), page);
  },

  isDanmakuResponse(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === 'https://api.bilibili.com' && parsed.pathname === SEGMENT_PATH;
    } catch { return false; }
  },

  decodeTexts(bytes) {
    return decodeSegment(bytes).map(item => item.text).filter(Boolean);
  },

  filterBytes(bytes, isBlocked) {
    return filterSegment(bytes, isBlocked);
  },

  /**
   * 预热：一次 list.so 就能拿到全片一大把弹幕，先批量判定，播放器后续拉分段时基本都命中。
   * 注意 list.so 是抽样返回的（同一视频两次调用子集不同），所以预热只是延迟优化，
   * 真正兜底的是"分段到来时按需判定"。
   */
  async warmup({ fetchBytes, toText }, video) {
    if (!video?.cid) return [];
    const items = parseDanmakuXml(await toText(await fetchBytes(xmlUrl(video.cid))));
    const seen = new Set();
    const texts = [];
    for (const item of items) {
      const text = (item.text || '').trim();
      if (text && !seen.has(text)) { seen.add(text); texts.push(text); }
    }
    return texts;
  },
};
