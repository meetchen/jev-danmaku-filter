// 浏览器与 Node 都能用的缓存实现。扩展端在 background 里把它落到 chrome.storage。
export class NullCache {
  get() { return undefined; }
  set() {}
  async save() {}
}

export class MapCache {
  constructor({ max = 20_000 } = {}) { this.max = max; this.map = new Map(); }
  get(key) { return this.map.get(key); }
  set(key, value) {
    this.map.set(key, { ...value, t: Date.now() });
    if (this.map.size > this.max) {
      for (const k of [...this.map.keys()].slice(0, this.map.size - this.max)) this.map.delete(k);
    }
  }
  hydrate(object) {
    for (const [key, value] of Object.entries(object || {})) {
      if (key.length === 64 && value && typeof value.c === 'string') this.map.set(key, value);
    }
  }
  toObject() { return Object.fromEntries(this.map); }
  async save() {}
}
