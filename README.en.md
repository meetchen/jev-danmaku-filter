# Danmaku Spoiler Filter · JEV

[中文](README.md) | English

**Keep the danmaku. Lose the spoilers.**

Uses [JEV](https://docs.typesafe.ai/) (TypeSafe System One) to decide whether a Bilibili bullet
comment spoils the plot, and filters out the ones that do. Bilibili only for now; the layout is
built so other danmaku sites can be added.

Zero dependencies · plain ESM · no build toolchain · MIT

```
剧透弹幕 · 识别剧透 51 种 · 实际隐藏 132 条 · 全片 6672 种弹幕
```

---

## Quick start

```sh
git clone https://github.com/meetchen/jev-danmaku-filter.git
cd jev-danmaku-filter
npm run build
```

Open `chrome://extensions/`, turn on **Developer mode**, click **Load unpacked**, and pick the
**`apps/extension`** directory.

Open the extension popup, paste your own [TypeSafe API key](https://console.typesafe.ai/), and click
**Save and test**. The key stays in local extension storage; it is never uploaded and never shipped
in the package.

Then open any Bilibili video page. A small badge appears in the bottom-left corner. The first visit
to a video takes a few seconds to warm up; after that every decision comes from the local cache.

## How it works

```
page.js (MAIN world)      fetches api.bilibili.com with the page's own origin,
                          and rewrites the danmaku segments the player receives
        │  postMessage (random handshake token)
content.js (isolated)     orchestrates, hides already-rendered danmaku as a fallback
        │  chrome.runtime
background.js (worker)    talks only to api.typesafe.ai, owns the cache and the budget
```

**Bilibili network access has to come from the page context.** Bilibili answers any request with
`Origin: chrome-extension://…` with **412**, so the service worker cannot reach the danmaku API at
all. All Bilibili traffic runs in the MAIN world using the page's origin, which also carries a normal
`Referer`. TypeSafe does not block extension origins, so the JEV calls stay in the background where
tabs share one cache and one budget.

**Filtering happens before the player parses.** The player receives
`/x/v2/dm/web/seg.so` — protobuf, top level `repeated DanmakuElem elem = 1`. Matching entries are
dropped whole and every other byte is preserved, so re-encoding is a lossless concatenation. Because
this happens before parsing, it covers **both DOM and Canvas danmaku** — no need to hide the whole
Canvas layer the way other approaches do. Already-rendered danmaku is hidden as a second line of
defence.

**Batching.** Danmaku is deduplicated by text (7200 → 6672 in our test episode), then ~160 entries go
into one request as `state.entries` with one `score` question each. JEV ingests the state once and
evaluates all questions in parallel, so a batch is **one HTTP request, not 160**. Batches run 8 at a
time, and results are cached by `rule version + model + text`.

## The rubric

A 5-level `score` question (levels 0–4):

| Level | Meaning | Action |
|---|---|---|
| 0 | Reacts only to what is on screen: praise, jokes, complaints, quotes, questions, translation fixes | keep |
| 1 | Explains or judges what has **already been shown** | keep |
| 2 | Speculates, or warns that something is coming without naming it (我感觉/可能/应该/盲猜) | keep |
| 3 | **Names** a specific later event: who wins, who falls ill, who ends up with whom, a later episode | hide |
| 4 | **States outright** the ending, a death, a hidden identity, a betrayal, a major twist | hide |

The decision uses the **normalised severity** `score / 4 >= 0.6`, not "did it land on 3 or 4".
JEV returns a probability for every level and `score` is their weighted mean, so an even split
between levels 2 and 3 (2.5) is hidden while a mostly-level-2 item (2.2) is kept.

The threshold lives in one place: `src/core/rules.js`. `0.55` favours recall, `0.60` balances,
`0.65` favours precision. **Changing it costs nothing** — the cache stores the severity, not the
verdict.

## Cost and latency

Measured on a ~6700-danmaku episode: **$0.08** and **~9 seconds** of warm-up at concurrency 8
(~350 tokens per entry, ~40 batches). A single request with 156–350 entries takes 1.5–2.3 s.

## Security and privacy

**What leaves your machine:** the danmaku text being judged, plus the video title and description.
No cookies, no account id, no username, no DMs, no page HTML.

**API key:** stored in `chrome.storage.local` with
`setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, so even content scripts cannot read it.
Never written into the source, never included in the package.

**postMessage handshake:** `window.postMessage` is a same-window broadcast, so any script on the page
— Bilibili's own code, analytics, ads, an XSS — can forge messages. Without a guard, one forged
`prepare` message would make the extension spend your JEV budget classifying an entire video. The
isolated world generates a 128-bit random token at injection time and the MAIN world only accepts
messages carrying it. Both scripts run at `document_start`, before any page script, so the token is
never observable by the page.

**Budget:** 200,000 judged entries per day (roughly $2–3), so a hostile page or an unusually long
video cannot silently drain your credits. Current usage is shown in the popup.

## CLI

```sh
cp .env.example .env      # put TYPESAFE_API_KEY in it
node src/cli/bili-filter.js BV1AzYs6bEeX --dry-run    # what would be sent, and the cost
node src/cli/bili-filter.js BV1AzYs6bEeX --out out/result.json
```

## Development

```sh
npm test          # 27 tests, no real API calls
npm run build     # build the extension
npm run package   # zip; validates the manifest and refuses to ship seed.json
npm run verify    # measure P/R/F1 of the current config on 29 hand-labelled danmaku
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add another danmaku site. Site differences live
entirely in the descriptors under `src/sites/`; `page-runtime.js` holds no site-specific logic, and a
fake site in the test suite proves that adding a site never touches the messaging layer.

## Tuning record

Question-type choice was measured, not guessed. Same 29 hand-labelled samples, same pipeline
(`npm run verify` reproduces it):

| Question type | P | R | F1 | Failure mode |
|---|---|---|---|---|
| `choice`, bare question | 0.41 | 1.00 | 0.59 | flags almost everything; "精彩" scored 0.69 |
| `noul` | 0.73 | 0.92 | 0.81 | treats "analysing the current situation" as a spoiler |
| **`score`, 5 detailed levels** | **0.86** | **1.00** | **0.92** | two debatable false positives left |

`noul` squeezes "analysing the present" and "revealing the future" into one binary question, so the
model can only return a mushy 0.5–0.6. `score` forces it to order the options explicitly, turning
that fuzzy boundary into a tunable cut-off.

**Level descriptions must be detailed.** The docs are explicit that every level is evaluated on its
own and the model never sees the numbers or the neighbours, so a description has to stand alone:

| Level descriptions | F1 |
|---|---|
| 5 levels, detailed (~55 tokens each) | **0.92** |
| 5 levels, terse (~25 tokens each) | 0.75 |
| 4 levels, terse | 0.83 |

Cheap levels are off the table. That doubles the per-entry question cost (117 → 309 tokens) and the
cost per episode ($0.045 → $0.081), and warm-up goes from ~5 s to ~9 s. Worth it for +0.11 F1.

**A measurement trap worth knowing.** We first estimated F1 at 0.96 and that was wrong.
`/x/v1/dm/list.so` returns a *sample*: calling it twice for the same video yields different subsets
(the episode has hundreds of thousands of danmaku; the endpoint returns 6000–7200). Scoring a
labelled set against one episode-wide run counted ten samples that were never in that run as
"misses". It also means the warm-up set can never be complete — the real guarantee is the on-demand
path that judges segments as the player requests them.

## Known limitations

- **Precision is not 1.0.** At threshold 0.6 roughly one in eight flagged items is a false positive,
  mostly analysis and motive-explaining comments. The model only sees text; it does not know where in
  the story the comment was posted.
- Warm-up is sampled, so a few spoilers can slip through in the first seconds of a video.
- Bangumi support is implemented but not broadly regression-tested.
- Danmaku only. Comments are not filtered yet.
- Advanced and code danmaku are out of scope.

## License

MIT. Independent project, not affiliated with Bilibili or TypeSafe.
