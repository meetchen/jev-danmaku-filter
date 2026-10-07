# 贡献指南

零依赖、纯 ESM。`git clone` 之后 `npm test` 就能跑，不需要 `npm install`。

```sh
npm test          # 18 个测试，不发真实请求
npm run build     # 构建扩展（改完 src/ 必须重建）
npm run package   # 打包，会校验 manifest 引用完整
```

调试插件：`chrome://extensions/` → 点插件的 **Service Worker** 看后台日志，
视频页 F12 看 page.js / content.js 的报错。页面上可以直接读状态：

```js
document.documentElement.dataset.jevmStatus
```

---

## 最需要帮助的两件事

### 一、补充人工标注样本 ⭐ 性价比最高

`scripts/verify-labeled.mjs` 里的 `LABELED` 数组是**唯一能把"感觉变准了"变成数字的东西**。
现在的 29 条来自一部剧，样本量小、偏斜大（12 正 17 负，全是同一部作品）。

按这个格式加就行：

```js
['这条弹幕的原文', 1],   // 1 = 应该屏蔽
['这条弹幕的原文', 0],   // 0 = 应该放行
```

**标注标准**（和量表的等级 3/4 对齐）：这条弹幕是否**点名了还没演到的具体事件或结果**？
只说"后面有大事"不算；说自己猜"可能会怎样"不算；评价已经演过的局势不算。

加完跑 `npm run verify` 看 P/R/F1 变化。**如果某个改动让 F1 掉了，请把数据贴进 PR 描述。**
样本变多之后，很多"我觉得"的问题会自己消失。

### 二、加新的站点适配器

目前只有 B 站。要加第二个站点，**先要做一次重构** —— 这是当前最值得做的一件事：

`apps/extension/src/page-runtime.js` 里的站点逻辑还是写死的（`isSegment()` 判断 seg.so、
`resolve()` 里的 pgc / view 分支、弹幕解码）。加第二个站点之前，应该把它抽成一张注册表：

```js
// 目标形状（尚未实现）
export const adapters = [
  {
    id: 'bilibili',
    // 1. 这个页面是不是我的
    matches: url => /^\/(video|list|bangumi\/play)\//.test(new URL(url).pathname),
    // 2. 解析出视频标识，返回统一的形状
    //    { cid, aid, title, description, duration, kind }
    resolve: async (fetchJson, href) => ({ ... }),
    // 3. 哪些响应是要过滤的弹幕响应
    isDanmakuResponse: url => parsed.pathname === '/x/v2/dm/web/seg.so',
    // 4. 从响应字节里取出所有弹幕文本
    decodeTexts: bytes => decodeSegment(bytes).map(i => i.text),
    // 5. 剔除命中项，返回新字节（null 表示不用改）
    filterBytes: (bytes, isBlocked) => { ... },
    // 6. 兜底：DOM 弹幕的选择器（可选，没有就返回 null）
    domSelector: '.bili-danmaku-x-dm,.b-danmaku,.danmaku-item',
  },
];
```

`page-runtime.js` 之后只做通用的事：握手、RPC、钩 fetch/XHR、按 `isDanmakuResponse` 分派。
这样加站点只需要写一个新对象，不用碰通信层。

各站点的难度差很多，动手前先确认"能不能拿到弹幕原文 + 能不能把过滤后的弹幕塞回播放器"：

| 站点 | 数据来源 | 难度 |
|---|---|---|
| 弹弹play | 本地 XML / JSON，还支持第三方弹幕库 | 最容易，可以先做这个 |
| A 站 | JSON 接口 | 低 |
| niconico | 官方 API | 中 |
| 腾讯 / 爱奇艺 / 优酷 / 芒果 | 各自的私有加密接口 | 高，逐个逆向 |
| YouTube | 无原生弹幕，依赖第三方扩展 | 要先选一个扩展 |

**另一个更省事的方向：通用文件适配器。**吃本地 XML / JSON / ASS 弹幕文件，输出带剧透标记的结果，
不碰任何站点接口，用户自己把标记好的弹幕导进播放器。这条路完全绕开逆向，而且正好复用了 `filterSegment()`。

---

## 提交前检查

CI 会跑这些，本地先跑一遍省时间：

1. `npm test` 全过
2. `npm run build` 之后 **`git status` 里 `apps/extension` 没有未提交的改动**
   （CI 会对比生成文件与源码，不一致直接失败）
3. 新行为要有测试。**优先测"容易悄悄坏掉"的地方**：字节级兼容、协议握手、缓存键、
   重试与退避、边界输入
4. 如果改了 `src/core/rules.js` 的规则或量表，**必须提升 `RULE_VERSION`** ——
   否则旧缓存会被错误的复用
5. 改了 prompt 措辞或量表，在 PR 描述里贴上 `npm run verify` 的前后对比

## 不要提交这些

`.gitignore` 已经覆盖，但请注意：

- **`.env`** —— 里面有 API Key
- **`apps/extension/seed.json`** —— 本地预判缓存，只对特定视频有意义，
  `npm run package` 会强制拒绝它进包

## 代码风格

- 没上 lint 和格式化工具。请跟随现有文件的风格：2 空格缩进、单引号、行尾分号。
- **注释写"为什么"，不写"是什么"。** 比如"Node fetch 已按 content-encoding 解压过，
  所以不要再 inflate 一次"这种坑点必须写下来，`const x = 1` 这种不用。
- 错误信息写给人看，说清楚下一步该做什么。
