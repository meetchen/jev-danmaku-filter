# 剧透弹幕过滤器 · JEV

中文 | [English](README.en.md)

**弹幕照开，剧透别来。**

用 [JEV](https://docs.typesafe.ai/)（TypeSafe System One）判断 B 站弹幕是不是剧透，命中的直接过滤掉。
初版只做哔哩哔哩，架构按「适配一切有弹幕的服务」设计。

零依赖 · 纯 ESM · 无构建工具链 · MIT

```
剧透弹幕 · 识别剧透 51 种 · 实际隐藏 132 条 · 全片 6672 种弹幕
```

---

## 快速开始

**1. 装扩展**

```sh
git clone https://github.com/meetchen/jev-danmaku-filter.git
cd jev-danmaku-filter
npm run build          # 生成 apps/extension/{page,content}.js 和 vendor/
```

Chrome 打开 `chrome://extensions/` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选 **`apps/extension`** 目录。

> 也可以直接下载 [Releases](https://github.com/meetchen/jev-danmaku-filter/releases) 里的 zip 解压后加载。

**2. 选后端 + 填自己的 API Key**

点开插件面板 → 「配置判定后端」→ 选一家：

| 后端 | 需要什么 | 网络 |
| --- | --- | --- |
| **TypeSafe 官方** | [API Key](https://console.typesafe.ai/) | 需要能访问 `api.typesafe.ai` |
| **阿里云百炼 · 决策模型** | [API Key](https://bailian.console.aliyun.com/) + 业务空间 ID | **国内直连** |

Key 只存在本机扩展存储里，不上传、不进安装包。

**3. 打开 B 站视频页**

左下角会出现角标。首次进入一个视频需要几秒预热，之后所有判定都走本地缓存。

---

## 它是怎么工作的

```
┌─ page.js（MAIN world，document_start）──────────────────────────┐
│  用页面来源请求 api.bilibili.com，并改写播放器拿到的弹幕分段     │
└───────────────┬─────────────────────────────────────────────────┘
                │ postMessage（带随机握手令牌）
┌───────────────▼─ content.js（隔离世界）─────────────────────────┐
│  编排：拿全片弹幕 → 交后台判定 → 结果回推给 page.js + DOM 兜底   │
└───────────────┬─────────────────────────────────────────────────┘
                │ chrome.runtime
┌───────────────▼─ background.js（Service Worker）────────────────┐
│  只负责调 api.typesafe.ai 和本地缓存，完全不碰 B 站              │
└─────────────────────────────────────────────────────────────────┘
```

### 为什么 B 站网络必须走页面上下文

实测：B 站对 `Origin: chrome-extension://…` 的请求直接返回 **412**（带不带 Referer 都一样），
所以后台 Service Worker 根本够不着 B 站的弹幕接口。所有 B 站请求下放到 MAIN world，
用页面的来源发出，请求头里自然带着正常的 Referer。
反过来 TypeSafe 不拦扩展来源，所以 JEV 调用留在后台，好处是多个标签页共享一份缓存和额度。

### 两道过滤

1. **数据层（主要）**：B 站播放器实际拉的是 `/x/v2/dm/web/seg.so`，protobuf 格式，
   顶层是 `repeated DanmakuElem elem = 1`。命中剧透的条目**按整段 span 丢弃、其余字节原样保留**，
   重编码是无损拼接。因为在播放器解析**之前**就剔除了，所以 **DOM 弹幕和 Canvas 弹幕同时生效**，
   不需要像其他方案那样把 Canvas 整层藏掉。
2. **DOM 兜底**：判定完成前已经渲染出来的命中弹幕，直接打上 `data-jevm="block"` 隐藏。

### 判定不是"每次都调一遍"

- **去重**：7200 条原始弹幕 → 6672 条唯一文本。缓存和判定都以**文本**为单位。
- **批量**：一次请求把 ~160 条弹幕放进 `state.entries`，每条一个 `score` 问题（`e0`…`e159`）。
  JEV 把 `state` 读一次、所有问题并行求值，所以一批 = 1 次 HTTP 请求，不是 160 次。
- **并发**：批次并发 8。
- **缓存**：`规则版本 + 模型 + 弹幕文本` 的 SHA-256 作键，命中就不发请求。

---

## 判断标准

用 JEV 的 **`score` 原语**，5 级量表（编号 0~4）：

| 级 | 含义 | 判定 |
|---|---|---|
| 0 | 只对当前画面做反应：夸、笑、玩梗、吐槽节奏、引用台词、提问、纠正翻译 | 放行 |
| 1 | 解释/评价**已经演过**的局势，比如谁现在落了下风 | 放行 |
| 2 | 猜测后面会怎样，或预告"有大事"但**不点名**（带 我感觉/可能/应该/盲猜 的归这级） | 放行 |
| 3 | **点名**后续的具体事件或结果：谁赢谁输、谁病了、谁跟谁在一起、下一集发生什么 | 屏蔽 |
| 4 | **直接说出**结局、角色死亡、隐藏身份、背叛、重大反转 | 屏蔽 |

判决用的是**归一化严重度** `score / 4 >= 0.6`（不是"落在 3 或 4"）——
JEV 返回的是每级的概率分布，`score` 是它的加权均值：

```
落在 2 和 3 各一半 → score = 2.5 → 屏蔽
落在 2 为主带一点 3 → score = 2.2 → 放行
```

阈值只在一处：`src/core/rules.js` 的 `threshold`。`0.55` 召回优先，`0.60` 平衡，`0.65` 精度优先。
**改阈值不需要重新调 API** —— 缓存里存的是严重度，不是判决结果。

### 实测成本与延迟

| | 每条 token | 批次 | 全片成本 | 预热（并发 8） |
|---|---|---|---|---|
| 约 6700 条弹幕的视频 | ~350 | ~40 | **$0.08** | **~9 秒** |

单次请求实测 1.5~2.3 秒（156~350 条 / 43K token）。

---

## 判定后端（厂商）

判定走的是 **TypeSafe System One 协议**。这个协议已经成了事实标准 —— 阿里云百炼的
[「决策模型」](https://help.aliyun.com/zh/model-studio/decision-model-api) 是**兼容实现**，
所以换厂商不用改核心逻辑：

| | TypeSafe 官方 | 阿里云百炼 |
| --- | --- | --- |
| 端点 | `/v1/systemone` | `/compatible-mode/v1/systemone` |
| 模型 | `jev-latest` | `decision-model-preview` |
| 请求体 | `{model, state, questions}` | **完全相同** |
| 返回 | `{choice\|noul\|score, probabilities, confidence}` | **完全相同** |
| 计费 | 只算 input token | 一样 |
| 网络 | 需可访问 `api.typesafe.ai` | **国内直连** |

`src/core/providers.js` 是唯一配置点。两家对「一次问多少个问题」的建议不同，会直接影响批量与延迟：

| | 单次问题上限 | 依据 |
| --- | --- | --- |
| TypeSafe | 500 | 官方称「加问题几乎不改变响应时间」，只受 64K token 约束 |
| 阿里百炼 | 32 | 官方文档称「延迟随问题数近线性增长，建议 ≤16」 |

上限就在 provider 定义里。**改完用 `npm run verify` 看 F1 有没有变化**：

```sh
npm run verify                                          # 当前默认后端
npm run verify -- --provider bailian --workspace ws-xxx  # 换阿里量一遍
```

### 退路：用聊天模型顶上（不需要业务空间）

决策模型在部分账号下不可用（实测某账号 `/v1/models` 返回 262 个模型，里面没有它；GLM 则提示未开通）。
这时可以退到 **聊天模型**后端：自己拼 prompt 要 JSON，一个 `sk-` key 就能用，
**不需要业务空间、不需要代理**。

代价是聊天模型是「生成」而不是「决策」：

| | TypeSafe（JEV score） | 阿里 qwen-flash（聊天） |
| --- | --- | --- |
| 原生概率分布 | 有 | **没有**，只有模型给的分数 |
| 单次 160 条延迟 | ~1.6s | ~14.5s |
| 全片 6672 条预热 | **~9s** | **~60~75s** |
| 成本 | $0.08 | 更低 |
| 需要业务空间 | 否 | 否 |
| 国内直连 | 否 | **是** |

**准确率基本持平**（29 条人工标注，同一套量表）：

| 后端 | P | R | F1 |
| --- | --- | --- | --- |
| TypeSafe（JEV score），2 次 | 0.92 / 0.85 | 0.92 / 0.92 | 0.92 / 0.88 |
| 阿里 qwen-flash，6 次 | 中位 0.88 | 中位 0.92 | **中位 0.90**（0.81~0.92，σ=0.04） |

聊天模型的**方差明显更大** —— 同一个模型、同一份输入，F1 在 0.81~0.92 之间跳。
好消息是误差偏向「多屏蔽」而不是「漏掉」：6 次平均 fp=1.8、fn=1.0。

试过的其他模型：

| 模型 | 结果 |
| --- | --- |
| `qwen-flash` | 约 87ms/条、无推理 token，**默认** |
| `qwen3.5-flash` | F1 0.83，误判更多 |
| `deepseek-v4-flash` | 召回只有 0.58，漏得厉害 |
| `ZHIPU/GLM-5.3-Flash` | 账号未开通该产品，直接 400 |
| `qwen3.8-flash` / `deepseek-v4.1-flash` | 输出 287~499 个推理 token，单条延迟 3~19 倍，分类任务上纯属浪费 |

挑模型时注意选**不带推理**的 flash 系。

### 三个后端的实测画像

| 后端 | F1（29 条标注） | 全片预热 | 需要 workspace | 国内直连 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **TypeSafe JEV** | **0.88~0.92** | **~9s** | 否 | 否 | 质量与速度都最好，但要能访问它 |
| **阿里 qwen-flash（聊天）** | **中位 0.90** | ~60~75s | **否** | **是** | 质量相当，慢一个量级 |
| **阿里决策模型** | **0.77** | ~17s | 是 | **是** | 最快，但质量明显差一档 |

**关键教训：协议兼容 ≠ 模型等价。** 阿里的决策模型虽然实现了同一个 System One 协议，
但它的**量表刻度与 JEV 不一致**——同样的弹幕，它给的分整体偏低：

```
同一条正样本：JEV 给 0.61~0.77，阿里决策模型给 0.23~0.70
同一阈值 0.60：JEV F1 0.92，阿里决策模型 F1 0.35（recall 只有 0.25）
```

所以**阈值必须能按后端单独标定**，不能全局共用一个（`providers.js` 里每个后端可设 `threshold`，
阿里决策模型实测最优是 0.4）。这也是为什么这个项目里有 `npm run verify` 这个量具 ——
换个后端就重新量一遍，别信"应该差不多"。

另外阿里决策模型的**问题数是硬限 16**（文档写"建议 ≤16，不设上限"，但接口直接 400
`questions: N exceeds the limit of 16`）。

想接第三家（火山方舟 / 智谱 / 自建 vLLM）：实现了同一个 `/systemone` 协议的，
在 `providers.js` 里加一条、把域名加进 `manifest.json` 的 `host_permissions` 即可；
纯聊天模型的加 `kind: 'chat'`。任意地址走 `optional_host_permissions`，
由用户在面板里当场授权，不默认放宽。

## 安全与隐私

**发送了什么**：待判断的弹幕文本、视频标题与简介，发往**你自己选的那个判定后端**。
**没有** Cookie、账号 ID、用户名、私信、整页 HTML。

**API Key**：只存在 `chrome.storage.local`，并调用了
`setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` 限制为仅可信上下文可读，
内容脚本也读不到。Key 不写入源码，不进安装包。

**postMessage 握手**：`window.postMessage` 是同窗口广播，页面上任何脚本（B 站自己的代码、第三方统计、
广告、任何 XSS）都能伪造消息。如果不过滤，伪造一条 `prepare` 就能让插件花用户的额度去判定整片视频。
所以隔离世界在注入时生成一个 128 位随机令牌，MAIN world 只接受携带该令牌的消息；
两个脚本都在 `document_start` 注入（早于页面自己的任何脚本），所以令牌不会被页面观察到。

**额度上限**：每日判定上限 200,000 条（约 $2~3），防止恶意页面或超长视频悄悄烧光额度。
用量显示在插件面板里。

---

## 命令行工具

不装扩展也能批量跑，适合先验证效果或离线处理。

```sh
cp .env.example .env      # 填 TYPESAFE_API_KEY

# 看会发什么、大概花多少钱（不发请求）
node src/cli/bili-filter.js BV1AzYs6bEeX --dry-run

# 真跑，导出每条弹幕的判定
node src/cli/bili-filter.js "https://www.bilibili.com/bangumi/play/ep403700" --limit 500 --out out/result.json
```

`--help` 看全部选项。缓存默认在 `.cache/bili-danmaku.json`，重复跑不消耗额度。

---

## 开发

```sh
npm test              # 47 个测试，不发真实请求
npm run build         # 构建扩展
npm run icons         # 重新生成图标（--check 只校验像素，见下）
npm run package       # 打包 zip，会校验 manifest 引用并拒绝 seed.json
npm run verify        # 在 29 条人工标注样本上量当前配置的 P/R/F1
```

发版走 tag：版本号要同步 `package.json` 与 `apps/extension/manifest.json`，
`git tag v0.2.0 && git push origin v0.2.0` 会触发 `.github/workflows/release.yml`
（先跑测试、校验版本号一致、打包，再自动发布 Release）。

改完源码要**重新 build**，CI 会检查提交的生成文件与源码是否一致。

```
src/core/                 平台无关：规则 / 判定客户端 / 厂商配置 / 批量调度 / 缓存
src/sites/                站点注册表与描述符（加新站点只动这里）
src/adapters/bilibili/    站点原语：protobuf 编解码、URL 构造、弹幕采集
src/cli/                  命令行
scripts/bundle.mjs        把 ES module 拼成经典脚本的小打包器
apps/extension/src/       两个运行时脚本的源码（会被打包器拼成经典脚本）
apps/extension/vendor/    构建时从 src/ 复制，勿手改
```

### 加一个新站点

站点差异全部收在 `src/sites/` 的描述符里，`page-runtime.js` 不含任何站点特有逻辑：

```js
export const SITES = [bilibili];   // src/sites/index.js —— 加一个就注册一个
```

改完可以用这条命令自查运行时是否干净（应该全部落在站点描述符那一段，运行时那一段为 0）：

```sh
grep -E "bilibili|SEGMENT|bili-danmaku" apps/extension/page.js
```

契约和完整步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。测试里有一个假站点
（`test/fixtures/fake-site.js`）专门用来证明"加站点不用碰通信层"。

### 一个本地测试技巧：seed.json

`npm run seed` 会把 CLI 已经判好的缓存复制成 `apps/extension/seed.json`，
扩展首次启动时灌入，于是打开视频**立刻生效、不发任何请求、不花钱**。

它只对特定视频有意义，**已在 `.gitignore` 里，且 `npm run package` 会强制排除**。

---

## 调参记录

问法选型不是拍脑袋，是实测出来的。同一份 29 条人工标注样本、同一条管线
（`npm run verify` 可复现）：

| 问法 | P | R | F1 | 失败模式 |
|---|---|---|---|---|
| `choice` 裸问题 | 0.41 | 1.00 | 0.59 | 几乎全判剧透，"精彩"都给 0.69 |
| `noul` | 0.73 | 0.92 | 0.81 | 把「分析当前局势」判成剧透 |
| **`score` 5 级 · 详细** | **0.86** | **1.00** | **0.92** | 只剩 2 个存疑误判 |

`score` 之所以更好：`noul` 把"分析当前"和"剧透未来"压成一个二值问题，模型只能给 0.5~0.6 的糊值；
`score` 逼它在有序量表上显式排序，把那条模糊边界变成一个可调的切点。

**level 描述必须写详细。** 官方文档明确说每条 level 独立评估、模型看不到编号也看不到邻居，
所以描述必须自洽且具体。实测：

| level 描述 | F1 |
|---|---|
| 5 级 · 详细（每条 ~55 token） | **0.92** |
| 5 级 · 精简（每条 ~25 token） | 0.75 |
| 4 级 · 精简 | 0.83 |

省 token 的路被堵死了。代价是每条弹幕的 question 开销从 117 → 309 token，全片成本 $0.045 → $0.081，
但延迟从 ~5 秒变 ~9 秒。**用 4 秒和 4 分钱换 F1 +0.11 很划算。**

### 一个测量陷阱

我一开始把 F1 估成 0.96，是错的。原因：**`list.so` 是抽样返回的**——同一个视频调两次，
返回的弹幕子集不一样（全量几十万条，接口每次只给 6000~7200 条）。
拿某一轮全片跑出来的语料去评标注样本，其中 10 条根本不在那轮语料里，被误算成了"漏判"。

后果不只是测量：**预热集合永远不可能完整**，真正兜底的是"播放器拉分段时按需判定"那条路，
预热只是延迟优化。架构本来就这么设计，现在有了实证理由。

---

## 踩过的坑

| 现象 | 根因 | 处理 |
|---|---|---|
| 请求 412 | B 站风控 `Origin: chrome-extension://` | 网络全下放到 MAIN world |
| 请求拿到空弹幕 | 带了浏览器 UA 但没带 Referer | 由页面来源发出，自带 Referer |
| 番剧页完全跑不通 | 番剧页**没有** `__INITIAL_STATE__` | 改走 `pgc/view/web/season?ep_id=` |
| `too many length or distance symbols` | Node fetch 已按 `content-encoding` 解压，代码又 inflate 一次 | 按 magic 判断，已解压的直接用 |
| 分 P 视频取错弹幕 | `videoData` 只有第一 P 的 cid | 按 `?p=` 取 `pages[n]` |
| 番剧时长离谱 | `/video/` 的 duration 是秒，`pgc` 是毫秒 | `normalizeDuration()` 统一 |
| 未开启插件也卡播放器 | 分段被扣 5 秒等判定 | 加握手守卫，握手后才动播放器 |
| 每批要等 18 秒 | 其实是限流重试被算进去了 | 实测单请求只有 1.5~2.3 秒 |

---

## 已知限制

- **精度不是 1.0**。阈值 0.6 时误判率大约 1/8，主要是"分析当前局势"和"揭示人物动机"这类边界表达。
  没有读心术：模型只看文本，不知道这条弹幕出现在剧情的哪个时间点。
- **预热是抽样**（见上），所以刚进视频的前几秒可能漏掉少量剧透，之后按需判定会补上。
- **番剧路径**已适配但未做大面积回归。
- **只做弹幕**，评论区没做。
- 特殊弹幕（高级弹幕、代码弹幕）不在处理范围。
- **阿里后端的准确率还没测过。** 协议兼容是确定的（用他们文档里的返回样例做了单测），
  但判决质量、批量上限的最优值都要实测。跑 `npm run verify -- --provider bailian` 就能出数。

---

## 贡献

最需要的是**新站点适配器**——见 [CONTRIBUTING.md](CONTRIBUTING.md)。
也欢迎补充人工标注样本（`scripts/verify-labeled.mjs` 里的 `LABELED` 数组），
那是唯一能把"感觉变准了"变成数字的东西。

## 声明

过滤是模型对文本的判断，可能误判或漏判。防剧透侧重明显透露、结局和点名后续事件的表达，
不读取视频画面、不建立完整剧情知识库。

扩展不收订阅费，JEV 调用使用你自己的 TypeSafe 额度。

MIT 开源。独立项目，与哔哩哔哩及 TypeSafe 无隶属关系。
