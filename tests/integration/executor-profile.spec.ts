import { describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import { BUILTIN_EXECUTOR_MANIFESTS, getExecutorManifest } from '../../src/server/executors/manifests';
import {
  createExecutionRun,
  createExecutorProfile,
  failExecutionRun,
  getExecutionRun,
  getExecutorProfile,
  listExecutorProfiles,
} from '../../src/server/domain/executor-profile';

describe('unified executor profiles', () => {
  it('declares all first-party adapter manifests and concurrency capabilities', () => {
    expect(BUILTIN_EXECUTOR_MANIFESTS.map((manifest) => manifest.id)).toEqual([
      'codex-cli',
      'claude-code-cli',
      'antigravity-cli',
      'pi-cli',
      'opencode-cli',
      'openai-compatible-api',
      'gemini-api',
      'custom-cli',
    ]);
    expect(getExecutorManifest('claude-code-cli').session.resume).toBe(true);
    expect(getExecutorManifest('custom-cli').concurrency).toBe('profile-serial');
  });

  it('stores credential references but rejects embedded secret values', () => {
    const { db, close } = makeTestDb();
    try {
      const profile = createExecutorProfile(db, {
        name: '共享 OpenAI',
        manifestId: 'openai-compatible-api',
        config: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
        credentialRef: { kind: 'env', reference: 'OPENAI_API_KEY' },
      });
      expect(getExecutorProfile(db, profile.id).credentialRef.reference).toBe('OPENAI_API_KEY');
      expect(listExecutorProfiles(db)).toHaveLength(1);
      expect(() => createExecutorProfile(db, {
        name: 'bad',
        manifestId: 'openai-compatible-api',
        config: { apiKey: 'sk-secret' },
      })).toThrow(/凭据值/);
    } finally {
      close();
    }
  });

  it('snapshots manifest and profile configuration into an immutable run', () => {
    const { db, close } = makeTestDb();
    try {
      const profile = createExecutorProfile(db, {
        name: 'Codex',
        manifestId: 'codex-cli',
        config: { bin: 'codex', model: 'gpt-5' },
        credentialRef: { kind: 'cli-login', reference: 'default' },
      });
      const run = createExecutionRun(db, {
        executorProfileId: profile.id,
        employeeId: 'employee-1',
        projectId: 'project-1',
        taskId: 'task-1',
      });
      const snapshot = getExecutionRun(db, run.id);
      expect(snapshot.manifestSnapshot.id).toBe('codex-cli');
      expect(snapshot.profileSnapshot.config).toEqual({ bin: 'codex', model: 'gpt-5' });
      expect(snapshot.status).toBe('created');
      const failed=failExecutionRun(db,run.id,'empty_result','adapter returned no result token=secret-value');
      expect(failed).toMatchObject({status:'failed',failureClassification:'empty_result',failureMessage:'adapter returned no result token=[REDACTED]'});
    } finally {
      close();
    }
  });
});
