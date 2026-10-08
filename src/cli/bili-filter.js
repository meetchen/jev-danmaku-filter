#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fetchDanmaku } from '../adapters/bilibili/index.js';
import { SPOILER } from '../core/rules.js';
import { buildRequest } from '../core/jev.js';
import { PROVIDERS, resolveProvider } from '../core/providers.js';
import { chunkEntries, classifyTexts } from '../core/batch.js';
import { JsonCache } from '../core/cache.js';
import { estimateTokens } from '../core/tokens.js';

const PRICE_PER_MILLION = 0.042; // 美元 / 1M input token（官方公布价，输出免费）

function loadEnv(file = '.env') {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 没有 .env 就跳过 */ }
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { options._.push(token); continue; }
    const [flag, inline] = token.slice(2).split('=');
    const key = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) { options[key] = inline; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { options[key] = next; i++; }
    else options[key] = true;
  }
  return options;
}

const USAGE = `
用法：node src/cli/bili-filter.js <BV号 | av号 | 视频URL> [选项]

选项
  --limit <n>       只判断前 n 条弹幕（按播放时间）
  --batch <n>       每批条数上限（默认按 token 预算自动切分）
  --concurrency <n> 并发批次数（默认 6）
  --provider <id>   判定后端（${Object.keys(PROVIDERS).join(' / ')}，默认 typesafe）
  --workspace <id>  阿里云百炼的业务空间 ID（provider=bailian 时必填）
  --endpoint <url>  自定义判定接口地址
  --model <id>      模型名（默认取 provider 预设）
  --key <key>       判定服务的 API Key（默认读 .env 里的 TYPESAFE_API_KEY / DASHSCOPE_API_KEY）
  --cache <file>    缓存文件（默认 .cache/bili-danmaku.json）
  --no-cache        不使用缓存
  --out <file>      输出带判断结果的 JSON
  --examples <n>    示例条数（默认 15）
  --all             打印全部判断结果
  --dry-run         不发请求，只打印批次切分与 token 估算
  --verbose         打印每个分段和批次的细节
`;

const BLOCK = 'spoiler';

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  const input = options._[0];
  if (!input || options.help) { process.stdout.write(USAGE.trimStart()); return; }

  const apiKey = options.key && options.key !== true ? options.key : process.env.TYPESAFE_API_KEY;
  const limit = options.limit ? Number(options.limit) : Infinity;
  const provider = resolveProvider({
    provider: options.provider && options.provider !== true ? String(options.provider) : undefined,
    workspaceId: options.workspace && options.workspace !== true ? String(options.workspace) : undefined,
    endpoint: options.endpoint && options.endpoint !== true ? String(options.endpoint) : undefined,
    model: options.model && options.model !== true ? String(options.model) : undefined,
  });
  if (!provider.configured) throw new Error(`provider=${provider.id} 还缺配置（大概率是 --workspace）。`);
  const model = provider.model;
  const verbose = Boolean(options.verbose);

  process.stdout.write(`▸ 判定后端：${provider.label} · ${provider.endpoint} · ${model}\n`);
  process.stdout.write(`▸ 解析视频 ${input}\n`);
  const { video, items, source } = await fetchDanmaku(input, { limit: Number.isFinite(limit) ? limit : undefined, verbose });
  process.stdout.write(`  标题：${video.title}\n`);
  process.stdout.write(`  cid ${video.cid} · 时长 ${video.duration}s · 弹幕 ${items.length} 条（${source}）\n`);

  const selected = Number.isFinite(limit) ? items.slice(0, limit) : items;
  const texts = selected.map(item => item.text);
  const unique = new Set(texts);
  // 同一条文本可能在不同时间出现，取最早出现的时间作为上下文。
  const atByText = new Map();
  for (const item of selected) if (!atByText.has(item.text)) atByText.set(item.text, item.at);
  const context = { title: video.title, description: video.description, duration: video.duration };

  if (options.dryRun) {
    const entries = [...unique].map(text => ({ text, at: atByText.get(text) ?? null }));
    const chunks = chunkEntries(entries, { rule: SPOILER, model, context, maxQuestions: provider.maxQuestions });
    const first = buildRequest(chunks[0] ?? [], { rule: SPOILER, model, ...context });
    const stateTokens = estimateTokens(first.state);
    const totalTokens = chunks.reduce((sum, chunk) => sum + estimateTokens(buildRequest(chunk, { rule: SPOILER, model, ...context })), 0);
    process.stdout.write(`\n▸ 干跑：去重后 ${unique.size} 条 → ${chunks.length} 批\n`);
    process.stdout.write(`  首批 ${chunks[0]?.length ?? 0} 条，state ≈ ${stateTokens} token\n`);
    process.stdout.write(`  总量 ≈ ${totalTokens} token ≈ $${((totalTokens / 1e6) * PRICE_PER_MILLION).toFixed(5)}\n`);
    process.stdout.write(`\nstate 预览：\n${JSON.stringify(first.state, null, 2).slice(0, 1600)}\n`);
    return;
  }

  const cache = options.noCache
    ? new JsonCache('') // 不用磁盘
    : await JsonCache.open(resolve(options.cache && options.cache !== true ? String(options.cache) : '.cache/bili-danmaku.json'));
  if (options.noCache) cache.file = '';

  process.stdout.write(`\n▸ 提交 JEV 判断（模型 ${model}）\n`);
  const started = Date.now();
  const { results, stats } = await classifyTexts([...unique], {
    apiKey,
    rule: SPOILER,
    model,
    cache,
    context,
    atByText,
    maxQuestions: provider.maxQuestions,
    concurrency: options.concurrency ? Number(options.concurrency) : 6,
    endpoint: provider.endpoint,
    log: verbose ? (m => process.stderr.write(`  ${m}\n`)) : null,
    onProgress: ({ done, total }) => {
      if (done < total) process.stderr.write(`\r  批次 ${done}/${total} 完成   `);
    },
    onRetry: ({ attempt, delay, error }) => process.stderr.write(`\n  重试 ${attempt}（${Math.round(delay)}ms）：${error.message}\n`),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write('\r');

  const blockedTexts = new Set([...results].filter(([, r]) => r.choice === BLOCK).map(([text]) => text));
  const blockedCount = texts.filter(text => blockedTexts.has(text)).length;
  const cost = (stats.inputTokens / 1e6) * PRICE_PER_MILLION;

  process.stdout.write(`\n▸ 结果\n`);
  process.stdout.write(`  去重弹幕 ${stats.unique} 条（缓存命中 ${stats.cached}）→ 请求 ${stats.requested} 条，${stats.batches} 批，耗时 ${seconds}s\n`);
  process.stdout.write(`  命中剧透 ${blockedTexts.size} 种文本 / 全量 ${blockedCount} 条（${((blockedCount / Math.max(1, texts.length)) * 100).toFixed(1)}%）\n`);
  process.stdout.write(`  消耗 ≈ ${stats.inputTokens} token ≈ $${cost.toFixed(5)}\n`);

  const examples = options.examples ? Number(options.examples) : 15;
  const ranked = [...results].filter(([, r]) => r.choice === BLOCK)
    .sort((a, b) => (b[1].severity ?? 0) - (a[1].severity ?? 0)).slice(0, examples);
  if (ranked.length) {
    process.stdout.write(`\n  判定为剧透（按置信度，仅供参考，请人工抽查）：\n`);
    for (const [text, result] of ranked) {
      const score = result.severity == null ? '  -  ' : result.severity.toFixed(2);
      process.stdout.write(`    [${score}] ${text.slice(0, 80)}${result.source === 'cache' ? '  (缓存)' : ''}\n`);
    }
  }
  if (options.all) {
    process.stdout.write(`\n  全部判断：\n`);
    for (const [text, result] of [...results].sort((a, b) => a[1].choice.localeCompare(b[1].choice))) {
      process.stdout.write(`    ${result.choice === BLOCK ? '剧透' : '正常'} ${text.slice(0, 80)}\n`);
    }
  }

  if (options.out && options.out !== true) {
    const file = resolve(String(options.out));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      video: { bvid: video.bvid, cid: video.cid, title: video.title },
      model, rule: SPOILER.id,
      stats: { ...stats, blockedTexts: blockedTexts.size, blockedCount },
      items: selected.map(item => ({
        text: item.text, at: item.at, mode: item.mode,
        decision: blockedTexts.has(item.text) ? BLOCK : 'normal',
        probability: results.get(item.text)?.severity ?? null,
      })),
    }, null, 2));
    process.stdout.write(`\n▸ 已写出 ${file}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`\n✗ ${error.message}\n`);
  process.exitCode = 1;
});
