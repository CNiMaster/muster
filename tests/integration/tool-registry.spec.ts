import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseToolManifest,
  scanToolManifests,
  syncToolRegistry,
  listTools,
  getTool,
  setDefaultTools,
  setToolActive,
  setToolDefault,
  dispatchDefaultToolsToCompany,
  listCompanyTools,
  readToolContent,
} from '../../src/server/domain/tool-registry';
import { makeTestDb } from './setup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsRoot = path.resolve(__dirname, '../../tools');

describe('tool registry scanning', () => {
  it('parses frontmatter from a tool manifest file', () => {
    const manifest = parseToolManifest(path.join(toolsRoot, 'speech-to-text/whisper-local.md'));
    expect(manifest).not.toBeNull();
    expect(manifest!.id).toBe('whisper-local');
    expect(manifest!.capability).toBe('speech-to-text');
    expect(manifest!.implementation).toBe('local');
    expect(manifest!.executor_kind).toBe('cli');
    expect(manifest!.maturity).toBe('stable');
  });

  it('parses api tool with credential_keys list', () => {
    const manifest = parseToolManifest(path.join(toolsRoot, 'speech-to-text/whisper-api.md'));
    expect(manifest).not.toBeNull();
    expect(manifest!.implementation).toBe('api');
    expect(manifest!.credential_keys).toContain('OPENAI_API_KEY');
  });

  it('scans the full tools/ directory and finds all bundled archives', () => {
    const scanned = scanToolManifests(toolsRoot);
    const ids = scanned.map((s) => s.manifest.id);
    expect(ids).toContain('whisper-local');
    expect(ids).toContain('whisper-api');
    expect(ids).toContain('ffmpeg');
    expect(ids).toContain('ffprobe');
    expect(ids).toContain('cosyvoice-local');
    expect(ids).toContain('elevenlabs-api');
    expect(ids).toContain('imagebind-local');
    expect(ids).toContain('clip-local');
    expect(ids).toContain('pandoc');
    expect(ids).toContain('libreoffice-headless');
    expect(ids).toContain('python-docx');
    expect(ids).toContain('python-pptx');
    expect(ids).toContain('openpyxl');
    expect(scanned.length).toBeGreaterThanOrEqual(13);
  });

  it('ignores INDEX.md', () => {
    const scanned = scanToolManifests(toolsRoot);
    expect(scanned.find((s) => s.filePath.endsWith('INDEX.md'))).toBeUndefined();
  });
});

describe('tool registry db operations', () => {
  it('syncs tools/ directory into the registry table', () => {
    const { db, close } = makeTestDb();
    try {
      const result = syncToolRegistry(db, toolsRoot);
      expect(result.added).toBeGreaterThanOrEqual(13);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);

      // 二次同步幂等:无新增
      const result2 = syncToolRegistry(db, toolsRoot);
      expect(result2.added).toBe(0);
      expect(result2.updated).toBeGreaterThanOrEqual(13);
    } finally {
      close();
    }
  });

  it('lists tools filtered by capability', () => {
    const { db, close } = makeTestDb();
    try {
      syncToolRegistry(db, toolsRoot);
      const stt = listTools(db, { capabilityId: 'speech-to-text' });
      expect(stt.length).toBe(2);
      expect(stt.every((t) => t.capabilityId === 'speech-to-text')).toBe(true);

      const localOnly = listTools(db, { capabilityId: 'speech-to-text', implementation: 'local' });
      expect(localOnly.length).toBe(1);
      expect(localOnly[0].id).toBe('whisper-local');
    } finally {
      close();
    }
  });

  it('sets default tools and dispatches to company', () => {
    const { db, close } = makeTestDb();
    try {
      syncToolRegistry(db, toolsRoot);
      setDefaultTools(db, ['whisper-local', 'ffmpeg']);

      const whisper = getTool(db, 'whisper-local');
      expect(whisper?.isDefault).toBe(true);
      const ffmpeg = getTool(db, 'ffmpeg');
      expect(ffmpeg?.isDefault).toBe(true);
      const cosvoice = getTool(db, 'cosyvoice-local');
      expect(cosvoice?.isDefault).toBe(false);

      // 创建测试公司(直接插表,绕过完整 setup)
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, ?, 'off', '', ?, ?)`)
        .run('c_test', '测试公司', new Date().toISOString(), new Date().toISOString());
      dispatchDefaultToolsToCompany(db, 'c_test');

      const companyTools = listCompanyTools(db, 'c_test');
      const dispatched = companyTools.filter((t) => t.enabled);
      expect(dispatched.map((t) => t.id).sort()).toEqual(['ffmpeg', 'whisper-local']);
    } finally {
      close();
    }
  });

  it('toggles tool active/default state', () => {
    const { db, close } = makeTestDb();
    try {
      syncToolRegistry(db, toolsRoot);
      setToolActive(db, 'whisper-local', false);
      expect(getTool(db, 'whisper-local')?.isActive).toBe(false);
      setToolDefault(db, 'whisper-local', true);
      expect(getTool(db, 'whisper-local')?.isDefault).toBe(true);
    } finally {
      close();
    }
  });

  it('reads full tool archive content', () => {
    const { db, close } = makeTestDb();
    try {
      syncToolRegistry(db, toolsRoot);
      const content = readToolContent(db, 'whisper-local');
      expect(content).not.toBeNull();
      expect(content!).toContain('# Whisper');
      expect(content!).toContain('适用能力');
    } finally {
      close();
    }
  });

  it('returns null for non-existent tool', () => {
    const { db, close } = makeTestDb();
    try {
      expect(getTool(db, 'does-not-exist')).toBeNull();
      expect(readToolContent(db, 'does-not-exist')).toBeNull();
    } finally {
      close();
    }
  });
});
