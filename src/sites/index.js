import { bilibili } from './bilibili.js';
import { createRegistry } from './registry.js';

/**
 * 站点注册表。加新站点就在这个数组里追加一个描述符，形状见 ./contract.js。
 * 顺序即优先级：先匹配到的胜出。
 */
export const SITES = [bilibili];

/** 找到接管当前页面的站点；没有就返回 null，调用方应当完全不干预页面。 */
export const findSite = createRegistry(SITES).find;
