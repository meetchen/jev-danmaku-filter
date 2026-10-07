import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export { NullCache, MapCache } from './memory.js';

// Node / CLI 用：把缓存落到磁盘。键是"文本摘要"，值只存判断结论。
export class JsonCache {
  constructor(file, { max = 200_000 } = {}) {
    this.file = file;
    this.max = max;
    this.map = new Map();
    this.dirty = false;
  }

  static async open(file, options) {
    const cache = new JsonCache(file, options);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      for (const [key, value] of Object.entries(raw)) {
        if (key.length === 64 && value && typeof value.c === 'string') cache.map.set(key, value);
      }
    } catch { /* 首次运行或缓存损坏都不算错误 */ }
    return cache;
  }

  get(key) { return this.map.get(key); }

  set(key, value) {
    this.map.set(key, { ...value, t: Date.now() });
    this.dirty = true;
    if (this.map.size > this.max) {
      for (const k of [...this.map.keys()].slice(0, this.map.size - this.max)) this.map.delete(k);
    }
  }

  async save() {
    if (!this.dirty || !this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.map)));
    await rename(tmp, this.file);
    this.dirty = false;
  }
}
