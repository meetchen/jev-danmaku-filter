// B 站适配器的汇总出口。新增站点时按同样的形状加一个 <site>/ 目录即可，见 CONTRIBUTING.md。
export { decodeSegment, filterSegment, readFields, decodeElem } from './protobuf.js';
export { parseDanmakuXml, decodeEntities } from './xml.js';
export { collectSegments } from './collect.js';
export { parseVideoRef, normalizeDuration, normalizeVideo, normalizeEpisode, segmentUrl, viewUrl, xmlUrl, pgcUrl, SEGMENT_SECONDS } from './urls.js';
export { resolveVideo, fetchDanmaku, fetchSegments, fetchXml } from './api.js';
