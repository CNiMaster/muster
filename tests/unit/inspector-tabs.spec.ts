import { describe, expect, it } from 'vitest';
import {
  RT_MAX_TABS,
  activeAfterClose,
  appendRt,
  normalizeRtActive,
  parseRtParam,
  rtId,
  rtLabel,
  serializeRt,
} from '../../src/client/components/workbench/inspector-tabs';

describe('inspector-tabs 纯函数', () => {
  it('解析三类标签并解码 doc 路径', () => {
    const raw = 'doc:' + encodeURIComponent('docs/调研报告.md') + '|plan:live|tool:knowledge';
    expect(parseRtParam(raw)).toEqual([
      { kind: 'doc', path: 'docs/调研报告.md' },
      { kind: 'plan', name: 'live' },
      { kind: 'tool', tool: 'knowledge' },
    ]);
  });

  it('容错：未知 kind/空段/坏编码/非法工具一律丢弃', () => {
    const bad = 'widget:x||doc:%zz|tool:notakey|no-separator';
    expect(parseRtParam(bad)).toEqual([]);
    expect(parseRtParam(null)).toEqual([]);
    expect(parseRtParam('')).toEqual([]);
  });

  it('去重保首现位置；超上限丢最旧', () => {
    const dup = parseRtParam('tool:tasks|plan:live|tool:tasks');
    expect(dup.map(rtId)).toEqual(['tool:tasks', 'plan:live']);
    const many = Array.from({ length: RT_MAX_TABS + 3 }, (_, i) => `doc:f${i}.md`);
    const parsed = parseRtParam(many.join('|'));
    expect(parsed).toHaveLength(RT_MAX_TABS);
    // 最旧的 f0/f1/f2 被丢，保最新
    expect(parsed[0].kind === 'doc' && parsed[0].path).toBe('f3.md');
  });

  it('序列化与解析互逆', () => {
    const entries = [
      { kind: 'doc' as const, path: 'a b/报 告.md' },
      { kind: 'plan' as const, name: 'live' },
      { kind: 'tool' as const, tool: 'artifacts' as const },
    ];
    expect(parseRtParam(serializeRt(entries))).toEqual(entries);
  });

  it('活动指针归一化：ctx 哨兵直通；指向不存在标签时回落现场(null)', () => {
    const entries = parseRtParam('plan:live');
    expect(normalizeRtActive('plan:live', entries)).toBe('plan:live');
    expect(normalizeRtActive('ctx', entries)).toBe('ctx');
    expect(normalizeRtActive('doc:ghost', entries)).toBeNull();
    expect(normalizeRtActive(null, entries)).toBeNull();
  });

  it('关闭语义：关非活动签不动；关活动签激活前一张；关第一张回现场', () => {
    const entries = [
      { kind: 'doc' as const, path: 'a.md' },
      { kind: 'plan' as const, name: 'live' },
      { kind: 'tool' as const, tool: 'tasks' as const },
    ];
    const [aId, pId] = [rtId(entries[0]), rtId(entries[1])];
    expect(activeAfterClose(entries, pId, aId)).toBe(aId);        // 关中间的，活动仍是别的签 → 不动
    expect(activeAfterClose(entries, pId, pId)).toBe(aId);        // 关活动签 → 激活前一张 doc:a.md
    expect(activeAfterClose([entries[0]], aId, aId)).toBeNull();  // 关唯一签 → 回现场
  });

  it('显示名：doc 取文件名、plan 固定、tool 用中文表', () => {
    expect(rtLabel({ kind: 'doc', path: 'docs/深层/调研报告.md' })).toBe('调研报告.md');
    expect(rtLabel({ kind: 'plan', name: 'live' })).toBe('工作现场');
    expect(rtLabel({ kind: 'tool', tool: 'merges' })).toBe('待合并成果');
  });

  it('全局工具键：archive/side/approvals 三键可解析（2026-08-27 审批收件箱进右栏）', () => {
    const entries = parseRtParam('g:archive|g:side|g:approvals');
    expect(entries.map(rtId)).toEqual(['g:archive', 'g:side', 'g:approvals']);
    expect(rtLabel(entries[2]!)).toBe('审批');
    expect(parseRtParam('g:ghost')).toEqual([]); // 非法全局键丢弃
    expect(serializeRt([{ kind: 'globalTool', key: 'approvals' }])).toBe('g:approvals');
  });

  it('appendRt：追加去重并按上限截最旧（写入口共用）', () => {
    const full = Array.from({ length: RT_MAX_TABS }, (_, i) => ({ kind: 'doc' as const, path: `f${i}.md` }));
    const appended = appendRt(full, { kind: 'doc', path: 'new.md' });
    expect(appended).toHaveLength(RT_MAX_TABS);
    expect(appended[appended.length - 1]).toEqual({ kind: 'doc', path: 'new.md' });
    expect(appended[0]).toEqual({ kind: 'doc', path: 'f1.md' }); // f0 被截
    // 已存在的 id 追加 = 挪到末尾不增员
    const moved = appendRt(full, { kind: 'doc', path: 'f0.md' });
    expect(moved).toHaveLength(RT_MAX_TABS);
    expect(moved[moved.length - 1]).toEqual({ kind: 'doc', path: 'f0.md' });
  });
});
