export const API = 'https://api.bilibili.com';
export const SEGMENT_SECONDS = 360; // 播放器按 6 分钟一段拉取弹幕

/** 接受 BV 号、av 号、完整 URL 或裸数字，返回 {bvid} 或 {aid}。 */
export function parseVideoRef(input) {
  const value = String(input ?? '').trim();
  // 番剧：/bangumi/play/ep403700 或裸 ep403700
  const ep = value.match(/\bep(\d{4,})/i);
  if (ep) return { epId: Number(ep[1]) };
  const bv = value.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0] };
  const av = value.match(/(?:^|\/|av)(\d{4,})/i);
  if (av) return { aid: Number(av[1]) };
  throw new Error(`无法识别的视频标识：${value || '(空)'}`);
}

// 不同接口的 duration 单位不一样：/video/ 是秒，番剧 pgc 是毫秒。
export function normalizeDuration(value) {
  const seconds = Number(value) || 0;
  return seconds > 100_000 ? Math.round(seconds / 1000) : Math.round(seconds);
}

export function viewUrl(input) {
  const ref = parseVideoRef(input);
  return `${API}/x/web-interface/view?${ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`}`;
}

export function segmentUrl(cid, aid, index) {
  return `${API}/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${aid}&segment_index=${index}`;
}

export function xmlUrl(cid) {
  return `${API}/x/v1/dm/list.so?oid=${cid}`;
}

export function pgcUrl(epId) {
  return `${API}/pgc/view/web/season?ep_id=${epId}`;
}

export function normalizeVideo(data, pageNumber = 1) {
  const index = Math.max(0, (Number(pageNumber) || 1) - 1);
  const page = data.pages?.[index] ?? data.pages?.[0] ?? null;
  return {
    kind: 'video',
    bvid: data.bvid,
    aid: data.aid,
    cid: page?.cid ?? data.cid,
    // 单 P 视频的 pages[0].part 就等于标题，直接拼会变成「标题 · 标题」。
    title: (page?.part && page.part !== data.title) ? `${data.title ?? ''} · ${page.part}` : (data.title ?? ''),
    description: data.desc ?? '',
    duration: normalizeDuration(page?.duration ?? data.duration),
    owner: data.owner?.name ?? '',
    pageCount: data.videos ?? 1,
  };
}

/** 番剧：pgc season 结构，episodes 和 section 里都可能有分集。 */
export function normalizeEpisode(season, epId) {
  const episodes = [...(season.episodes || []), ...((season.section || []).flatMap(section => section.episodes || []))];
  const ep = episodes.find(item => item.id === epId || item.ep_id === epId) || episodes[0] || {};
  const label = [season.title, ep.title ? `第${ep.title}集` : '', ep.long_title || ''].filter(Boolean).join(' · ');
  return {
    kind: 'bangumi',
    bvid: ep.bvid,
    aid: ep.aid,
    cid: ep.cid,
    title: label || season.title || '',
    description: season.evaluate || season.subtitle || '',
    duration: normalizeDuration(ep.duration),
    owner: '',
    pageCount: episodes.length,
  };
}
