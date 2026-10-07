// 把若干 ES module 拼成一个经典脚本 —— 内容脚本不支持 import，只能拼。
// 单独抽出来是为了让测试也能用它造变体 bundle（例如塞一个假站点进去验证分派）。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 去掉模块语法。只处理本仓库用到的写法：单行 import、export 关键字、export {} 汇总。 */
export function stripModuleSyntax(source) {
  return source
    .replace(/^\s*import\s[^;]*;\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*(?:from\s*'[^']*')?\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '');
}

/**
 * @param {string} rootDir 仓库根目录
 * @param {Array<string | {inline: string, label?: string}>} entries 按依赖顺序排列；
 *   字符串是相对 rootDir 的路径，对象是直接内联的源码（测试用）
 * @returns {Promise<string>} 整体包一层 IIFE 的经典脚本，避免污染页面全局
 */
export async function composeBundle(rootDir, entries) {
  const parts = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      parts.push(`/* ---- ${entry} ---- */\n${stripModuleSyntax(await readFile(join(rootDir, entry), 'utf8'))}`);
    } else {
      parts.push(`/* ---- ${entry.label ?? 'inline'} ---- */\n${stripModuleSyntax(entry.inline)}`);
    }
  }
  return `(() => {\n${parts.join('\n\n')}\n})();\n`;
}

/** page.js 的依赖顺序：站点原语 → 站点描述符 → 注册表 → 通用运行时。 */
export const PAGE_SOURCES = [
  'src/sites/registry.js',
  'src/adapters/bilibili/protobuf.js',
  'src/adapters/bilibili/xml.js',
  'src/adapters/bilibili/urls.js',
  'src/sites/bilibili.js',
  'src/sites/index.js',
  'apps/extension/src/page-runtime.js',
];
