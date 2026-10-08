#!/usr/bin/env node
// 在人工标注样本上直接量当前配置的 P/R/F1。
// 注意：不要用全片跑出来的语料去评这批样本 —— list.so 每次返回的弹幕子集不同，
// 样本可能压根不在那一轮的语料里，会把"没抽到"误算成"漏判"。
import { readFileSync } from 'node:fs';
import { classifyTexts } from '../src/core/batch.js';
import { SPOILER } from '../src/core/rules.js';
import { NullCache } from '../src/core/memory.js';
import { resolveProvider } from '../src/core/providers.js';

export const LABELED = [
  ['下周没葛西啥事了，他已经出局了',1],['然后两个人被巨川暴打',1],['最后一定是大河内帮了财前',1],
  ['彩铅会为自己的傲慢而得到惩罚',1],['大概率会有肺癌的',1],['后面的书：食道癌外壳',1],
  ['财前是必成功的毕竟后面还是十多集呢',1],['不管谁胜利，东都将失败',1],['岳父后面碰到大门蜜瓜也收到手软',1],
  ['应该落选了，后面又上位了，猜想而已',1],['很明显，最后一个就是东教授投的弃权票',1],['然后菊川发现东教授连外科的人都掌控不了',1],
  ['精彩',0],['手好看',0],['真实',0],['大河内的字也太好看了',0],['前方高能片段！',0],['名场面预警',0],
  ['这里翻译有问题，不是问佐知子身体哪里不舒服，而是问东教授',0],
  ['东的老婆督促他是为了帮他，东自己不作的话他本来会安稳退休有个好弟子的',0],
  ['船尾的真实目的是把浪速医院的人都拉成自己的手下',0],['我感觉东是想让财前低头',0],
  ['看个剧咋感觉那么累呢（闭目',0],['别剧透 谢谢',0],['笑死了',0],['这集节奏真慢',0],
  ['长得好像啊是我的错觉吗',0],['东教授已经输了',0],['其实教授回心转意了，想谈谈，但已经没有谈的可能了',0],
];

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const provider = resolveProvider({
  provider: arg('provider'), workspaceId: arg('workspace'), endpoint: arg('endpoint'), model: arg('model'),
});
if (!provider.configured) {
  console.error(`provider=${provider.id} 还缺配置（多半是 --workspace）。`);
  process.exit(1);
}
// 按 provider 读它自己的环境变量。原来是一个正则同时匹配两个名字，
// .env 里两条 key 都有时会抓到靠前的那条 —— 必然拿 TypeSafe 的 key 去打阿里。
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const fromEnv = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const apiKey = (arg('key') || fromEnv(provider.envKey) || '').trim();
if (!apiKey) { console.error(`没找到 API Key（.env 里的 ${provider.envKey}）。`); process.exit(1); }
console.error(`判定后端：${provider.label} · ${provider.endpoint} · ${provider.model}\n`);

// 三种问法，用同一套规则语义，端到端跑同一条管线
const VARIANTS = {
  'choice 单问题': {
    id: 'v-choice', type: 'choice', options: ['spoiler', 'normal'], threshold: 0.5,
    task: 'Does entries[0].text spoil a future plot point for a first-time viewer?',
    criteria: { spoiler: 'The comment tells the viewer a fact from later in the story.', normal: 'The comment only reacts to, explains or speculates about what is on screen.' },
  },
  'noul': {
    id: 'v-noul', type: 'noul', options: ['spoiler', 'normal'], threshold: 0.55,
    question: 'Would entries[%s].text tell a first-time viewer something about the story that has not been shown yet at this point? Answer 1 if it reveals a future event, outcome, death, illness, relationship, identity or betrayal. Answer 0 for reactions to the current scene, analysis of the current situation, jokes, praise, complaints, questions, and clearly-marked guesses.',
  },
  'score 5 级（当前）': SPOILER,
};

console.log('每条文本的严重度（0~1），❌ = 判错\n');
const summary = [];
// 聊天后端只有量表可问；choice/noul 是 System One 专有的原语，跳过并说明。
const variants = Object.entries(VARIANTS)
  .filter(([, rule]) => provider.kind !== 'chat' || Array.isArray(rule.levels));
if (variants.length < Object.keys(VARIANTS).length) {
  const skipped = Object.keys(VARIANTS).length - variants.length;
  console.error(`（聊天后端不含 typed 原语，跳过 ${skipped} 个 choice/noul 变体）\n`);
}

for (const [name, rule] of variants) {
  const { results } = await classifyTexts(LABELED.map(([text]) => text), {
    apiKey, rule, cache: new NullCache(), backend: provider,
    context: { title: '白色巨塔 · 第9集', description: '' }, concurrency: 4,
  });
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const misses = [];
  for (const [text, expected] of LABELED) {
    const result = results.get(text);
    const predicted = result.choice === 'spoiler' ? 1 : 0;
    if (predicted && expected) tp++; else if (predicted && !expected) fp++; else if (!predicted && expected) fn++; else tn++;
    if (predicted !== expected) misses.push(`      ${expected ? '漏判' : '误判'} sev=${(result.severity ?? 0).toFixed(2)}  ${text.slice(0, 60)}`);
  }
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
  const f1 = 2 * precision * recall / (precision + recall || 1);
  summary.push({ name, precision, recall, f1, tp, fp, fn, tn, misses });
}

for (const s of summary) {
  console.log(`${s.name}  P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} F1=${s.f1.toFixed(2)}  (tp${s.tp}/fp${s.fp}/fn${s.fn}/tn${s.tn})`);
  for (const m of s.misses) console.log(m);
  console.log();
}
