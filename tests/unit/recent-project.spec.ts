import { describe, expect, it } from 'vitest';
import { readRecentProjectId, writeRecentProjectId, type StorageLike } from '../../src/client/hooks/useRecentProject';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe('recent project storage', () => {
  it('只读取合法的项目 ID', () => {
    const storage = memoryStorage({ 'muster:last-project:v1': 'pr_abc123' });
    expect(readRecentProjectId(storage)).toBe('pr_abc123');

    storage.values.set('muster:last-project:v1', '/tmp/private-project');
    expect(readRecentProjectId(storage)).toBeNull();
  });

  it('存储不可用或读取异常时安全返回空值', () => {
    expect(readRecentProjectId(null)).toBeNull();
    expect(readRecentProjectId({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => {},
      removeItem: () => {},
    })).toBeNull();
  });

  it('写入访问项目，并可清除已经删除的项目', () => {
    const storage = memoryStorage();
    writeRecentProjectId(storage, 'pr_latest');
    expect(readRecentProjectId(storage)).toBe('pr_latest');

    writeRecentProjectId(storage, null);
    expect(readRecentProjectId(storage)).toBeNull();
  });
});
