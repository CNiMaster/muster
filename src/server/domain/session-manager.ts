import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { getProjectTaskThread, type ProjectTaskThread } from './project-task-thread';

export type SessionAction = 'none' | 'compact' | 'rotate';
export type RecoveryAction = 'retry' | 'compact' | 'rotate' | 'stop';

interface SessionManagerOptions {
  softRunCount?: number;
  hardRunCount?: number;
  softTranscriptBytes?: number;
  hardTranscriptBytes?: number;
}

export class SessionManager {
  constructor(private db: DB, private options: SessionManagerOptions = {}) {}

  recordRun(threadId: string, input: {
    transcriptBytes: number;
    inputTokens?: number;
    outputTokens?: number;
    contextWindow?: number;
    handoff: Record<string, unknown>;
  }): { action: SessionAction; thread: ProjectTaskThread } {
    const thread = getProjectTaskThread(this.db, threadId);
    const runCount = thread.runCount + 1;
    const bytes = thread.transcriptBytes + Math.max(0, input.transcriptBytes);
    const softRuns = this.options.softRunCount ?? 30;
    const hardRuns = this.options.hardRunCount ?? 45;
    const softBytes = this.options.softTranscriptBytes ?? 2 * 1024 * 1024;
    const hardBytes = this.options.hardTranscriptBytes ?? 3 * 1024 * 1024;
    const tokens = (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
    const tokenRatio = input.contextWindow && input.contextWindow > 0 ? tokens / input.contextWindow : 0;
    const action: SessionAction = runCount >= hardRuns || bytes >= hardBytes || tokenRatio >= 0.9
      ? 'rotate'
      : runCount >= softRuns || bytes >= softBytes || tokenRatio >= 0.75
        ? 'compact'
        : 'none';
    const now = nowIso();

    if (action === 'rotate') {
      this.db.prepare("UPDATE project_task_thread SET previous_vendor_session_id=vendor_session_id,vendor_session_id=NULL,run_count=0,transcript_bytes=0,handoff_json=?,health_json='{}',updated_at=? WHERE id=?")
        .run(JSON.stringify(input.handoff), now, threadId);
    } else {
      this.db.prepare('UPDATE project_task_thread SET run_count=?,transcript_bytes=?,handoff_json=?,updated_at=? WHERE id=?')
        .run(runCount, bytes, JSON.stringify(input.handoff), now, threadId);
    }
    return { action, thread: getProjectTaskThread(this.db, threadId) };
  }

  markCompacted(threadId: string): ProjectTaskThread {
    const now = nowIso();
    this.db.prepare("UPDATE project_task_thread SET run_count=0,transcript_bytes=0,compaction_count=compaction_count+1,last_compaction_at=?,health_json='{}',updated_at=? WHERE id=?")
      .run(now, now, threadId);
    return getProjectTaskThread(this.db, threadId);
  }

  rotate(threadId: string, handoff: Record<string, unknown>): ProjectTaskThread {
    const now = nowIso();
    this.db.prepare("UPDATE project_task_thread SET previous_vendor_session_id=vendor_session_id,vendor_session_id=NULL,run_count=0,transcript_bytes=0,handoff_json=?,health_json='{}',updated_at=? WHERE id=?")
      .run(JSON.stringify(handoff), now, threadId);
    return getProjectTaskThread(this.db, threadId);
  }

  nextRecovery(threadId: string, compactSupported: boolean): RecoveryAction {
    const thread = getProjectTaskThread(this.db, threadId);
    const attempts = Number(thread.health.recoveryAttempts ?? 0) + 1;
    const action: RecoveryAction = attempts === 1
      ? 'retry'
      : attempts === 2
        ? compactSupported ? 'compact' : 'rotate'
        : attempts === 3 ? 'rotate' : 'stop';
    this.db.prepare('UPDATE project_task_thread SET health_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...thread.health, recoveryAttempts: attempts, lastRecoveryAction: action }), nowIso(), threadId);
    return action;
  }
}
