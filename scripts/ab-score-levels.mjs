#!/usr/bin/env node
// 第二组对照：同样是 score，测「level 描述写多细」对精度的影响。
// level 描述会被模型逐条独立评估，看不到编号也看不到邻居，所以写短了有可能掉精度。
import { readFileSync } from 'node:fs';

const key = readFileSync('.env', 'utf8').match(/TYPESAFE_API_KEY=(.*)/)[1].trim();

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
  ['长得好像啊是我的错觉吗',0],['东教授已经输了',0],['其实教授心转意了，想谈谈，但已经没有谈的可能了',0],
];

const V = {
  '5级·详细': [
    'Only reacts to what is on screen right now: praise, laughter, a joke, a complaint about pacing or picture quality, a quoted line, a question, or a correction of the translation.',
    'Explains, judges or criticises the situation that has already been shown, for example who is currently winning or losing, or what a character is thinking, without naming anything that comes later.',
    'Guesses or speculates about what might happen, or warns that something noteworthy is coming, without naming a specific later event. Marked guesses such as 我感觉, 可能, 应该, 盲猜 belong here.',
    'Names a specific event, outcome or fact from a later part of the story: who wins or loses the contest, who falls ill, who ends up with whom, or what happens in a later episode.',
    'States outright the ending, a character death, a hidden identity, a betrayal, or a major twist.',
  ],
  '5级·精简': [
    'A reaction to the scene on screen right now: praise, laughter, a joke, a quote, a question.',
    'An explanation, judgment or criticism of what has already been shown, or a clearly-marked guess about what might happen.',
    'A vague warning or emotional hint that something notable is coming, without naming it.',
    'A named event or outcome from later in the story: who wins or loses, who falls ill, or what happens in a later episode.',
    'The ending, a death, a hidden identity, a betrayal or a major twist, stated outright.',
  ],
  '4级·精简': [
    'A reaction to the scene on screen right now: praise, laughter, a joke, a quote, a question.',
    'An explanation, judgment or criticism of what has already been shown, or a clearly-marked guess about what might happen.',
    'A vague warning or emotional hint that something notable is coming, without naming it.',
    'A named later event, or the ending, a death or a twist stated outright.',
  ],
};

const corpus = loadCorpus();
const blocked = [...new Set(corpus.filter(i => i.decision === 'spoiler').map(i => i.text))];
const normals = [...new Set(corpus.filter(i => i.decision !== 'spoiler').map(i => i.text))];
const texts = [...new Set([...LABELED.map(l => l[0]), ...blocked, ...normals.slice(0, 120)])];
const labels = new Map(LABELED);
console.error(`样本 ${texts.length} 条，人工标注 ${labels.size} 条`);

const results = {};
for (const [name, levels] of Object.entries(V)) {
  results[name] = new Map();
  const BATCH = 100;
  for (let start = 0; start < texts.length; start += BATCH) {
    const chunk = texts.slice(start, start + BATCH);
    const questions = {};
    chunk.forEach((_, i) => { questions[`s${i}`] = { type: 'score', instructions: `Which level of state.levels describes entries[${i}].text?`, criteria: levels }; });
    const body = { model: 'jev-latest',
      state: { task: 'Judge each entry.', levels: levels.map((d, i) => ({ level: i, description: d })), entries: chunk.map((text, i) => ({ i, text })) },
      questions };
    const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const json = await response.json();
    if (!json.answers) { console.error(name, 'API 错误', JSON.stringify(json).slice(0, 200)); continue; }
    const top = levels.length - 1;
    chunk.forEach((text, i) => {
      const a = json.answers[`s${i}`];
      results[name].set(text, { mean: a.score / top, score: a.score });
    });
    await new Promise(r => setTimeout(r, 200));
  }
  console.error(`  ${name} 完成`);
}

const metric = (map, threshold) => {
  let tp = 0, fp = 0, fn = 0;
  for (const [text, expected] of labels) {
    const predicted = (map.get(text)?.mean ?? 0) >= threshold ? 1 : 0;
    if (predicted && expected) tp++; else if (predicted && !expected) fp++; else if (!predicted && expected) fn++;
  }
  const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
  return `P=${p.toFixed(2)} R=${r.toFixed(2)} F1=${(2 * p * r / (p + r || 1)).toFixed(2)} (tp${tp}/fp${fp}/fn${fn})`;
};

console.log('\n用「归一化均值 = score / 最高级编号」做判决：');
for (const [name, map] of Object.entries(results)) {
  console.log(`\n${name}  全片会屏蔽 ${[...map.values()].filter(v => v.mean >= 0.5).length} 条`);
  for (const t of [0.5, 0.55, 0.6, 0.65]) console.log(`  thr${t}: ${metric(map, t)}`);
}
console.log('\n各方案在阈值 0.6 下的分歧（相对 5级·详细）：');
const base = results['5级·详细'];
for (const name of ['5级·精简', '4级·精简']) {
  const diff = texts.filter(t => ((base.get(t)?.mean ?? 0) >= 0.6) !== ((results[name].get(t)?.mean ?? 0) >= 0.6));
  console.log(`\n${name}: 与基准不一致 ${diff.length} 条`);
  for (const t of diff.slice(0, 12)) console.log(`  详${(base.get(t)?.mean ?? 0).toFixed(2)}/简${(results[name].get(t)?.mean ?? 0).toFixed(2)}  ${t.slice(0, 70)}`);
}
