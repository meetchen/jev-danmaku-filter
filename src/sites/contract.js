/**
 * 站点描述符的契约。加一个新站点 = 新增一个实现这个形状的对象，注册到 ./index.js，
 * 不需要碰 page-runtime.js 的通信层。
 *
 * 运行环境：MAIN world（页面自己的 JS 上下文）。所以可以用 location / document / window，
 * 但不能 import 任何 node: 内置模块。
 *
 * 只有 matches / resolve / decodeTexts 是必须的，其余按需实现：
 * - 网页站点通常实现 isDanmakuResponse + filterBytes（在播放器解析前改写弹幕数据）
 * - 离线源可以只实现 collect（自己产出文本，不走响应改写）
 *
 * @typedef {object} SiteResolveContext
 * @property {string} href            当前页面地址
 * @property {(url: string) => Promise<Uint8Array>} fetchBytes  用页面来源发请求，返回原始字节
 * @property {(url: string) => Promise<any>} fetchJson          同上，但校验业务 code 并取 data/result
 * @property {(bytes: Uint8Array) => Promise<string>} toText    按 content-encoding 自动解压成文本
 * @property {(payload: object) => void} post                   上报进度或警告给隔离世界
 *
 * @typedef {object} SiteVideo
 * @property {string} source      站点 id
 * @property {string|number} cid  弹幕分组标识（B 站是 cid，别的站点可能是剧集号）
 * @property {string} title       视频标题，作为判定上下文发给 JEV
 * @property {string} description 简介，同上
 * @property {number} duration    秒
 *
 * @typedef {object} Site
 * @property {string} id
 * @property {string} label
 * @property {(href: string) => boolean} matches                这个页面归不归我管
 * @property {(context: SiteResolveContext) => Promise<SiteVideo>} resolve
 * @property {(url: string) => boolean} [isDanmakuResponse]     哪些响应是弹幕数据
 * @property {(bytes: Uint8Array) => string[]} [decodeTexts]    从弹幕数据里取出所有文本
 * @property {(bytes: Uint8Array, isBlocked: (text: string) => boolean) => ({bytes: Uint8Array, dropped: number, total: number}|null)} [filterBytes]  剔除命中项
 * @property {(context: SiteResolveContext, video: SiteVideo) => Promise<string[]>} [warmup]  预热文本
 * @property {string|null} [domSelector]                        页面里弹幕节点的 CSS 选择器，用于 DOM 兜底
 */
export {};
