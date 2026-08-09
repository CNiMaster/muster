import '@testing-library/jest-dom/vitest';

/**
 * Node >= 22.4 在 globalThis 上挂了实验性 localStorage getter（未传 --localstorage-file 时
 * 返回 undefined），而 vitest 的 jsdom 全局填充（getWindowKeys 白名单）不会覆盖 Node 已有
 * 的同名 key，导致测试里裸 `localStorage` 为 undefined。这里统一注入内存版 Storage mock，
 * node / jsdom 两环境行为一致、确定性。
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
if (typeof window !== 'undefined' && window !== globalThis) {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}
