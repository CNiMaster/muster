import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY,
  findRegistryCandidates,
  findRegistryCandidatesForGaps,
  isOneClickInstallable,
  type RegistryEntry,
} from '../../src/server/domain/capability-registry';

describe('capability-registry（B1 策展注册表）', () => {
  it('DEFAULT_REGISTRY 非空，每条具备 id/kind/capabilityTags/vetted/installSpec', () => {
    expect(DEFAULT_REGISTRY.length).toBeGreaterThan(0);
    for (const e of DEFAULT_REGISTRY) {
      expect(e.id).toBeTruthy();
      expect(e.capabilityTags.length).toBeGreaterThan(0);
      expect(typeof e.vetted).toBe('boolean');
      expect(e.installSpec).toBeTruthy();
    }
  });

  it('findRegistryCandidates 按能力 tag 匹配，vetted 优先排序', () => {
    const reg: RegistryEntry[] = [
      { id: 'a', kind: 'cli', capabilityTags: ['speech-to-text'], title: 'B 库', description: '', vetted: false, installSpec: { hint: 'x' } },
      { id: 'b', kind: 'cli', capabilityTags: ['speech-to-text'], title: 'A 库', description: '', vetted: true, installSpec: { hint: 'y' } },
    ];
    const cands = findRegistryCandidates(reg, 'speech-to-text');
    expect(cands.map((c) => c.id)).toEqual(['b', 'a']); // vetted 在前
  });

  it('对内置清单：speech-to-text 命中 whisper-stt 且可一键装', () => {
    const cands = findRegistryCandidates(DEFAULT_REGISTRY, 'speech-to-text');
    expect(cands.length).toBeGreaterThan(0);
    const whisper = cands.find((c) => c.id === 'whisper-stt');
    expect(whisper).toBeTruthy();
    expect(isOneClickInstallable(whisper!)).toBe(true);
  });

  it('未审核条目（如 image-gen-api）不可一键装', () => {
    const image = DEFAULT_REGISTRY.find((e) => e.id === 'image-gen-api');
    expect(image?.vetted).toBe(false);
    expect(isOneClickInstallable(image!)).toBe(false);
  });

  it('无匹配返回空数组', () => {
    expect(findRegistryCandidates(DEFAULT_REGISTRY, 'nonexistent-cap')).toEqual([]);
  });

  it('findRegistryCandidatesForGaps 批量返回映射，仅含有命中的能力', () => {
    const map = findRegistryCandidatesForGaps(DEFAULT_REGISTRY, ['speech-to-text', 'nope', 'pdf-export']);
    expect(map.has('speech-to-text')).toBe(true);
    expect(map.has('pdf-export')).toBe(true);
    expect(map.has('nope')).toBe(false);
  });
});
