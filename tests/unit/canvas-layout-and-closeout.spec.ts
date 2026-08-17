import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, setDbForTest, closeDb, DB } from '../../src/server/db/client';
import { makeTestDb, TestDb } from '../integration/setup';
import {
  saveCanvasLayout,
  getCanvasLayout,
  hasCycleInEdges,
} from '../../src/server/domain/canvas-layout';
import {
  generateTaskCloseoutSummary,
  getTaskCloseoutSummary,
} from '../../src/server/domain/task-closeout';
import { createTask } from '../../src/server/domain/task';
import { createCompany } from '../../src/server/domain/company';
import { createProject } from '../../src/server/domain/project';
import { clonePersonaAsUser, updateUserCustomConfig } from '../../src/server/domain/agent-profile';

describe('Canvas Layout Sidecar & Codex Task Closeout (Phase 3)', () => {
  let testDb: TestDb;
  let db: DB;

  beforeEach(() => {
    testDb = makeTestDb();
    db = testDb.db;
    setDbForTest(db);
  });

  afterEach(() => {
    testDb.close();
    closeDb();
  });

  describe('Canvas Layout & DAG Anti-cycle Guard', () => {
    it('detects cycles correctly in directed graph edges', () => {
      // 1. Valid linear DAG
      expect(hasCycleInEdges([
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
      ])).toBe(false);

      // 2. Valid Diamond DAG
      expect(hasCycleInEdges([
        { source: 'A', target: 'B' },
        { source: 'A', target: 'C' },
        { source: 'B', target: 'D' },
        { source: 'C', target: 'D' },
      ])).toBe(false);

      // 3. Self-loop
      expect(hasCycleInEdges([
        { source: 'A', target: 'A' },
      ])).toBe(true);

      // 4. Circular loop (A -> B -> C -> A)
      expect(hasCycleInEdges([
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'A' },
      ])).toBe(true);
    });

    it('saves canvas layout and increments version, rejects saving cyclic layout', () => {
      const db = getDb();
      const canvasKey = 'blueprint:bp_test_123';

      const validLayout = {
        nodes: [
          { id: 'stage_1', position: { x: 100, y: 100 } },
          { id: 'stage_2', position: { x: 100, y: 300 } },
        ],
        edges: [
          { id: 'e1', source: 'stage_1', target: 'stage_2' },
        ],
      };

      const saved1 = saveCanvasLayout(db, canvasKey, validLayout);
      expect(saved1.version).toBe(1);
      expect(saved1.layout.nodes.length).toBe(2);

      const loaded = getCanvasLayout(db, canvasKey);
      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(1);

      // Update layout -> version 2
      const saved2 = saveCanvasLayout(db, canvasKey, {
        ...validLayout,
        nodes: [...validLayout.nodes, { id: 'stage_3', position: { x: 100, y: 500 } }],
        edges: [...validLayout.edges, { id: 'e2', source: 'stage_2', target: 'stage_3' }],
      });
      expect(saved2.version).toBe(2);
      expect(saved2.layout.nodes.length).toBe(3);

      // Attempt to save cyclic layout -> throws validation error
      expect(() => {
        saveCanvasLayout(db, canvasKey, {
          nodes: saved2.layout.nodes,
          edges: [
            ...saved2.layout.edges,
            { id: 'e_cycle', source: 'stage_3', target: 'stage_1' },
          ],
        });
      }).toThrow(/循环依赖/);
    });
  });

  describe('Task Closeout 8-Section Summary Generation', () => {
    it('generates 8-section closeout summary and detects user talent positive evolution', () => {
      const db = getDb();
      const company = createCompany(db, { name: `Closeout Co ${Date.now()}` });
      const project = createProject(db, { companyId: company.id, name: 'Closeout Project' });

      const rawTalent = clonePersonaAsUser(db, 'frontend/engineering-frontend-developer', 'Master React Builder');
      const userTalent = updateUserCustomConfig(db, rawTalent.id, {
        customModel: 'claude-3-7-sonnet',
        isAutoDispatch: 1,
      });

      const task = createTask(db, {
        projectId: project.id,
        title: 'Develop high-performance navigation navbar',
        acceptanceCriteria: [
          { id: 'crit_1', criterion: 'Zero layout shift' },
          { id: 'crit_2', criterion: '100% TypeScript typed' },
        ],
        inputProtocol: {
          blueprintMatched: 'bp_react_nav',
          blueprintLabel: 'React·Navigation',
          staffingMode: 'user_override',
          userTalentOverride: {
            profileId: userTalent.id,
            displayName: userTalent.displayName,
            customModel: userTalent.customModel,
          },
        },
      });

      // Mark task completed
      db.prepare("UPDATE task SET state='completed', rework_count=0 WHERE id=?").run(task.id);

      const closeout = generateTaskCloseoutSummary(db, task.id);
      expect(closeout.taskId).toBe(task.id);
      expect(closeout.isUserOverride).toBe(true);

      // Section 1: Objective
      expect(closeout.sections.objective.title).toBe(task.title);
      expect(closeout.sections.objective.acceptanceCriteria.length).toBe(2);

      // Section 2: Staffing
      expect(closeout.sections.blueprintAndStaffing.staffingMode).toBe('user_override');
      expect(closeout.sections.blueprintAndStaffing.userTalentOverride?.displayName).toBe('Master React Builder');

      // Section 5: Acceptance
      expect(closeout.sections.acceptanceResults.passed).toBe(2);

      // Section 7: Reflection & Evolution
      expect(closeout.sections.reflectionAndEvolution.isPositiveEvolution).toBe(true);
      expect(closeout.sections.reflectionAndEvolution.reflectionNote).toContain('正向吸收');

      // Markdown output
      expect(closeout.closeoutMarkdown).toContain('# 任务归档与速读简报');
      expect(closeout.closeoutMarkdown).toContain('🟢 自有人才顶替（Master React Builder）');
      expect(closeout.closeoutMarkdown).toContain('claude-3-7-sonnet');

      // Persistence check
      const fetched = getTaskCloseoutSummary(db, task.id);
      expect(fetched?.id).toBe(closeout.id);
    });
  });
});
