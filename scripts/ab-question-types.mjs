#!/usr/bin/env node
// 对照实验：同一份样本上比较 noul / score / 组合三种问法。
// 用法：node scripts/ab-question-types.mjs [--sample 134] [--normals 100]
import { readFileSync } from 'node:fs';
import { estimateTokens } from '../src/core/tokens.js';

const key = readFileSync('.env', 'utf8').match(/TYPESAFE_API_KEY=(.*)/)[1].trim();
const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};

// ---- 人工标注样本（1 = 应屏蔽）----
const LABELED = [
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

const NOUL_Q = 'Would entries[%s].text tell a first-time viewer something about the story that has not been shown yet at this point?'
  + ' Answer 1 if it reveals a future event, outcome, death, illness, relationship, identity or betrayal.'
  + ' Answer 0 for reactions to the current scene, analysis of the current situation, jokes, praise, complaints, questions, and clearly-marked guesses.';

// 每个 level 独立评估，看不到编号和邻居，所以描述必须自洽。
const LEVELS = [
  'Only reacts to what is on screen right now: praise, laughter, a joke, a complaint about pacing or picture quality, a quoted line, a question, or a correction of the translation.',
  'Explains, judges or criticises the situation that has already been shown, for example who is currently winning or losing, or what a character is thinking, without naming anything that comes later.',
  'Guesses or speculates about what might happen, or warns that something noteworthy is coming, without naming a specific later event. Marked guesses such as 我感觉, 可能, 应该, 盲猜 belong here.',
  'Names a specific event, outcome or fact from a later part of the story: who wins or loses the contest, who falls ill, who ends up with whom, or what happens in a later episode.',
  'States outright the ending, a character death, a hidden identity, a betrayal, or a major twist.',
];
const SCORE_Q = 'Which level of state.levels describes entries[%s].text?';

const corpusItems = loadCorpus();
const corpus = [...new Set(corpusItems.map(i => i.text))];
const alreadyBlocked = [...new Set(corpusItems.filter(i => i.decision === 'spoiler').map(i => i.text))];
const normals = corpus.filter(t => !alreadyBlocked.includes(t));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const texts = [...new Set([
  ...LABELED.map(l => l[0]),
  ...alreadyBlocked.slice(0, getArg('sample', 134)),
  ...shuffle(normals).slice(0, getArg('normals', 100)),
])];
const labels = new Map(LABELED);

// 按 token 预算切批
const perEntry = 40 + estimateTokens(NOUL_Q) + estimateTokens(SCORE_Q) + LEVELS.reduce((s, l) => s + estimateTokens(l), 0);
const BATCH = Math.max(20, Math.floor(55_000 / perEntry));
const chunks = [];
for (let i = 0; i < texts.length; i += BATCH) chunks.push(texts.slice(i, i + BATCH));
console.error(`样本 ${texts.length} 条 → ${chunks.length} 批 × ≈${BATCH}（单条约 ${perEntry} token）`);

const rows = new Map();
for (const [n, chunk] of chunks.entries()) {
  const questions = {};
  chunk.forEach((_, i) => {
    questions[`n${i}`] = { type: 'noul', instructions: NOUL_Q.replace('%s', i) };
    questions[`s${i}`] = { type: 'score', instructions: SCORE_Q.replace('%s', i), criteria: LEVELS };
  });
  const body = {
    model: 'jev-latest',
    state: { task: 'Judge each entry.', video: { title: '白色巨塔 · 第9集', description: '' },
      levels: LEVELS.map((l, i) => ({ level: i, description: l })),
      entries: chunk.map((text, i) => ({ i, text })) },
    questions,
  };
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.answers) { console.error('API 错误:', JSON.stringify(json).slice(0, 300)); process.exit(1); }
  chunk.forEach((text, i) => {
    const noul = json.answers[`n${i}`]?.noul ?? 0;
    const probs = json.answers[`s${i}`]?.probabilities ?? {};
    const high = (probs['3'] ?? 0) + (probs['4'] ?? 0);      // 落到 level 3 或 4 的概率
    const score = json.answers[`s${i}`]?.score ?? 0;
    rows.set(text, { noul, high, score, mean: score / (LEVELS.length - 1) });
  });
  console.error(`  批 ${n + 1}/${chunks.length} 完成`);
}

const metrics = (scoreOf, threshold) => {
  let tp = 0, fp = 0, fn = 0;
  for (const [text, expected] of labels) {
    const predicted = scoreOf(rows.get(text)) >= threshold ? 1 : 0;
    if (predicted && expected) tp++; else if (predicted && !expected) fp++; else if (!predicted && expected) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { precision, recall, f1: 2 * precision * recall / (precision + recall || 1), tp, fp, fn };
};

const methods = {
  'noul（现状）': r => r.noul,
  'score P(≥3)': r => r.high,
  'score 归一化均值': r => r.mean,
  'combo noul×P(≥3)': r => Math.sqrt(r.noul * r.high),
};
console.log(`\n人工标注样本 ${labels.size} 条（正 ${[...labels.values()].filter(Boolean).length} / 负 ${[...labels.values()].filter(v => !v).length}）\n`);
for (const [name, fn] of Object.entries(methods)) {
  const line = [0.4, 0.5, 0.6].map(t => { const m = metrics(fn, t); return `thr${t} P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)}`; });
  console.log(`${name.padEnd(20)} ${line.join(' | ')}`);
}

const blockedNow = new Set(alreadyBlocked);
const byNoul = new Set([...rows].filter(([, r]) => r.noul >= 0.55).map(([t]) => t));
const byScore = new Set([...rows].filter(([, r]) => r.high >= 0.5).map(([t]) => t));
const onlyScore = [...byScore].filter(t => !byNoul.has(t));
const onlyNoul = [...byNoul].filter(t => !byScore.has(t));
console.log(`\n当前阈值下：noul 命中 ${byNoul.size} 条，score 命中 ${byScore.size} 条，两者分歧 ${onlyScore.length + onlyNoul.length} 条`);
console.log(`\n=== 只有 score 认为是剧透的（noul 漏掉，可能是真阳）===`);
for (const text of onlyScore.slice(0, 25)) console.log(`  noul=${rows.get(text).noul.toFixed(2)} P(≥3)=${rows.get(text).high.toFixed(2)}  ${text.slice(0, 78)}`);
console.log(`\n=== 只有 noul 认为是剧透的（score 放行，可能是 noul 的误判）===`);
for (const text of onlyNoul.slice(0, 25)) console.log(`  noul=${rows.get(text).noul.toFixed(2)} P(≥3)=${rows.get(text).high.toFixed(2)}  ${text.slice(0, 78)}`);
