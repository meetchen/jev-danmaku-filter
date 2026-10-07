// 问法选型是实测出来的（见 README「调参记录」），不是拍脑袋。结论：
//   choice 单问题        F1 0.81
//   noul                F1 0.81~0.86   会把「分析当前局势」也判成剧透
//   score 5 级（详细）    F1 0.96  ← 选定
//   score 5 级（精简描述）F1 0.75  ← 文档说过，每个 level 独立评估、看不到编号和邻居，
//                                    所以 level 描述必须自洽且具体，写短了精度崩掉
//   score 4 级（精简）    F1 0.83
export const RULE_VERSION = 4;

export const SPOILER = {
  id: 'spoiler',
  name: '剧透弹幕',
  type: 'score',
  options: ['spoiler', 'normal'],
  // 判决规则：归一化严重度 = score / 最高级编号，>= threshold 即屏蔽。
  // 为什么不用 score 原始值：不同级数的量表不可比，归一化后才能统一阈值。
  // 0.55 = 召回优先（R=1.00 P=0.80），0.60 = 平衡（P=0.92 R=1.00），0.65 = 精度优先。
  threshold: 0.6,
  instruction: 'Which level of state.levels describes entries[%s].text?',
  // 顺序即编号，从低到高。每条都是自洽的完整描述，不依赖相邻 level。
  levels: [
    'Only reacts to what is on screen right now: praise, laughter, a joke, a complaint about pacing or picture quality, a quoted line, a question, or a correction of the translation.',
    'Explains, judges or criticises the situation that has already been shown, for example who is currently winning or losing, or what a character is thinking, without naming anything that comes later.',
    'Guesses or speculates about what might happen, or warns that something noteworthy is coming, without naming a specific later event. Marked guesses such as 我感觉, 可能, 应该, 盲猜 belong here.',
    'Names a specific event, outcome or fact from a later part of the story: who wins or loses the contest, who falls ill, who ends up with whom, or what happens in a later episode.',
    'States outright the ending, a character death, a hidden identity, a betrayal, or a major twist.',
  ],
};

export const RULES = { spoiler: SPOILER };
