import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTestDb } from './setup';
import { createExecutorInstallPlan, detectExecutor, executeExecutorInstallPlan, getExecutorInstall, launchExecutorLogin } from '../../src/server/domain/executor-install';

describe('self-service executor installation for a new Mac', () => {
  it('creates a reviewable private installation plan without changing the machine', () => {
    const { db, close } = makeTestDb();
    const homeDir = mkdtempSync(join(tmpdir(), 'muster-install-'));
    try {
      const plan = createExecutorInstallPlan(db, { manifestId: 'codex-cli', channel: 'latest', musterHome: homeDir, platform: 'darwin', arch: 'arm64' });
      expect(plan.packageName).toBe('@openai/codex');
      expect(plan.targetDir).toBe(join(homeDir, 'runtimes', 'codex-cli', 'latest'));
      expect(plan.officialSource).toContain('openai/codex');
      expect(plan.confirmationToken).toMatch(/^install_/);
      expect(existsSync(plan.targetDir)).toBe(false);
      expect(getExecutorInstall(db, plan.id).status).toBe('planned');
    } finally { close(); rmSync(homeDir, { recursive: true, force: true }); }
  });

  it('requires the exact confirmation token and verifies the installed binary', async () => {
    const { db, close } = makeTestDb();
    const homeDir = mkdtempSync(join(tmpdir(), 'muster-install-'));
    try {
      const plan = createExecutorInstallPlan(db, { manifestId: 'gemini-cli', channel: 'stable', musterHome: homeDir, platform: 'darwin', arch: 'arm64' });
      await expect(executeExecutorInstallPlan(db, plan.id, 'wrong', { run: vi.fn() })).rejects.toThrow(/确认/);
      const run = vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === '--version') return { stdout: '0.25.0', stderr: '', exitCode: 0 };
        const prefix = args[args.indexOf('--prefix') + 1]!;
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(prefix, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(join(prefix, 'node_modules', '.bin', 'gemini'), '#!/bin/sh\n');
        return { stdout: '0.25.0', stderr: '', exitCode: 0 };
      });
      const installed = await executeExecutorInstallPlan(db, plan.id, plan.confirmationToken, { run });
      expect(installed.status).toBe('installed');
      expect(installed.executorProfileId).toMatch(/^ep_/);
      expect(installed.binaryPath).toBe(join(plan.targetDir, 'node_modules', '.bin', 'gemini'));
      expect(run).toHaveBeenCalledTimes(2);
      expect(readFileSync(installed.binaryPath!, 'utf8')).toContain('#!/bin/sh');
    } finally { close(); rmSync(homeDir, { recursive: true, force: true }); }
  });

  it('detects an existing system CLI without taking ownership of it', async () => {
    const result = await detectExecutor('claude-code-cli', { run: vi.fn(async () => ({ stdout: '2.1.89', stderr: '', exitCode: 0 })), which: vi.fn(async () => '/usr/local/bin/claude') });
    expect(result).toEqual(expect.objectContaining({ found: true, version: '2.1.89', path: '/usr/local/bin/claude', managed: false }));
  });

  it('opens the official CLI login flow without collecting a password', async () => {
    const { db, close } = makeTestDb();
    const homeDir = mkdtempSync(join(tmpdir(), 'muster-install-'));
    try {
      const plan = createExecutorInstallPlan(db, { manifestId: 'codex-cli', channel: 'stable', musterHome: homeDir, platform: 'darwin', arch: 'arm64' });
      db.prepare("UPDATE executor_install SET status='installed', binary_path=? WHERE id=?").run('/safe/codex', plan.id);
      const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
      const result = await launchExecutorLogin(db, plan.id, { run });
      expect(result.launched).toBe(true);
      expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Terminal', result.launcherPath]);
      expect(readFileSync(result.launcherPath, 'utf8')).toContain("'/safe/codex' 'login'");
    } finally { close(); rmSync(homeDir, { recursive: true, force: true }); }
  });
});
