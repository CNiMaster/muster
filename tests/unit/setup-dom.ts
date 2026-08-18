import '@testing-library/jest-dom/vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 测试库隔离（结构性兜底）：任何测试里裸调 getDb()（未显式传 dbPath/setDbForTest）
 * 都会经 SERVER_CONFIG 落到默认 ~/.muster/muster.db——历史上冒烟垃圾公司与
 * 2026-08-18 的误迁移事故都源于此。setupFiles 在所有测试模块 import 之前执行，
 * 这里给 MUSTER_HOME 兜底一个临时目录，使默认路径永远指向一次性沙箱；
 * 测试自己显式设置 MUSTER_HOME 的行为不受影响（后者覆盖本值）。
 */
if (!process.env.MUSTER_HOME) {
  process.env.MUSTER_HOME = mkdtempSync(path.join(os.tmpdir(), 'muster-test-home-'));
}

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
