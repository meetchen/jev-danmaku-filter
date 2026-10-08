# 贡献指南

零依赖、纯 ESM。`git clone` 之后 `npm test` 就能跑，不需要 `npm install`。

```sh
npm test          # 47 个测试，不发真实请求
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

站点差异**已经全部抽到 `src/sites/` 的描述符里**了，`page-runtime.js` 不含任何站点特有逻辑
（可以用 `grep -E "bilibili|SEGMENT|bili-danmaku" apps/extension/page.js` 验证 —— 命中全部落在
站点描述符那一段，运行时那一段是 0）。

所以加一个站点 = 新建一个描述符 + 注册，**不用碰通信层**。契约见 `src/sites/contract.js`，
最简实现见 `src/sites/bilibili.js`。

```js
// src/sites/mysite.js
export const mysite = {
  id: 'mysite',
  label: '某站',
  domSelector: '.some-danmaku,.other-danmaku',   // 可选：DOM 兜底用；null 表示不做兜底

  // 1. 这个页面归不归我管
  matches: href => new URL(href).hostname === 'mysite.example' && new URL(href).pathname.startsWith('/watch/'),

  // 2. 解析成统一形状。context 提供 fetchBytes / fetchJson / toText / post
  async resolve({ fetchJson }) {
    const data = await fetchJson(`https://api.mysite.example/video?url=${encodeURIComponent(location.href)}`);
    return { source: 'mysite', cid: data.videoId, title: data.title, description: data.desc, duration: data.seconds };
  },

  // 3. 哪些响应是弹幕数据（返回 true 的才会被钩子接住）
  isDanmakuResponse: url => url.includes('/api/danmaku'),

  // 4. 从弹幕数据里取出所有文本
  decodeTexts: bytes => JSON.parse(new TextDecoder().decode(bytes)).map(item => item.text),

  // 5. 剔除命中项，返回新字节；返回 null 表示这条不用改
  filterBytes(bytes, isBlocked) {
    const items = JSON.parse(new TextDecoder().decode(bytes));
    const kept = items.filter(item => !isBlocked(item.text));
    return { bytes: new TextEncoder().encode(JSON.stringify(kept)), dropped: items.length - kept.length, total: items.length };
  },

  // 6. 可选：预热文本，让播放器拉分段时基本都命中缓存
  async warmup({ fetchBytes, toText }, video) { /* ... */ },
};
```

然后注册进去，顺序即优先级：

```js
// src/sites/index.js
export const SITES = [bilibili, mysite];
```

**必做三件事**：

1. 在 `test/registry.test.mjs` 里加断言：`createRegistry(SITES).find('你的页面 URL').id === 'mysite'`，
   同时确认别的站点不会被误匹配。
2. 用 `test/fixtures/fake-site.js` 那套办法验证 decodeTexts / filterBytes 真的能跑通 ——
   它演示了怎么用 `composeBundle()` 拼一个只含你站点的 bundle 丢进 sandbox 跑
   （那个假站点故意用 JSON 而不是 protobuf，用以证明链路不依赖任何 B 站假设）。
3. 手动加载扩展，在真实页面上确认一遍。**没在实机上验证过的适配器请不要在 README 里宣称支持。**

**动手前的判断标准**：能不能拿到弹幕原文 + 能不能把过滤后的弹幕塞回播放器。

| 站点 | 数据来源 | 难度 |
| --- | --- | --- |
| 弹弹play | 本地 XML / JSON，还支持第三方弹幕库 | 最容易 |
| AcFun | 播放器私有接口，需要逆向 | 中 |
| niconico | 官方 API，但要会话 | 中 |
| 腾讯 / 爱奇艺 / 优酷 / 芒果 | 各自的私有加密接口 | 高 |
| 巴哈姆特動畫瘋 | 接口公开，但会对非浏览器来源返回 403 | 中 |
| YouTube | 无原生弹幕，依赖第三方扩展 | 要先选一个扩展 |

> 目前仓库里只有 B 站一个适配器。我试过 AcFun / 巴哈姆特 / niconico，都没能在无浏览器环境下
> 验证接口，所以没有把未经验证的适配器塞进来冒充支持。

**另一条更省事的路：通用文件适配器。**吃本地 XML / JSON / ASS 弹幕文件，输出带剧透标记的结果，
不碰任何站点接口，用户自己把标记好的弹幕导进播放器。完全绕开逆向，而且直接复用
`filterBytes()` 那套逻辑。这个方向不需要浏览器验证，是很好的起步点。

## 怎么接第三家判定后端

判定走的是 **TypeSafe System One 协议**，阿里云百炼是它的兼容实现。所以想接第三家
（火山方舟 / 智谱 / 自建 vLLM / 任何实现了同协议的服务），改动集中在一个文件：

```js
// src/core/providers.js
export const PROVIDERS = {
  typesafe: { /* ... */ },
  bailian: { /* ... */ },
  myservice: {
    id: 'myservice',
    label: '我的判定服务',
    hint: '面板里显示给用户的一句说明',
    endpoint: 'https://judge.example.com/v1/systemone',
    model: 'judge-v1',
    kind: 'systemone',       // 或 'chat'（纯聊天模型，自己拼 prompt 要 JSON）
  envKey: 'MY_API_KEY',    // .env 里对应的变量名，CLI 与 verify 靠它取 key
  maxQuestions: 64,        // 单次问题数上限，按厂商文档或实测来
    docs: 'https://example.com/docs',
  },
};
```

然后**必须**同步两处，否则运行时才炸：

1. `apps/extension/manifest.json` 的 `host_permissions` 加上该域名
   （`test/versions.test.mjs` 里对固定 host 列表有断言，会提醒你）
2. 如果该厂商的返回字段和 System One 有差异，改 `src/core/jev.js` 的 `parseAnswers()`

**先确认它真的实现了同协议**：拿 `npm run verify --provider myservice` 打一遍，
29 条标注样本上的 P/R/F1 和 TypeSafe 比一比。核心逻辑（`buildRequest` / 批次切分 /
缓存 / 重试）应当一行都不用改 —— 如果要改，说明这个厂商并不是同协议，而是需要另写适配层，
那就该在 `src/core/` 下单开一个 backend，而不是硬塞进 providers。

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
