import type { DB } from '../db/client';
import type { EmployeeRuntimeDTO } from '../../shared/types';
import { getAgentProfile, listProfileEmployments } from './agent-profile';
import { getWorkbench } from './workbench';

interface RuntimeRow {
  employee_id: string;
  role: string;
  project_id: string;
  project_name: string;
  thread_id: string;
  project_task_id: string;
  project_task_title: string;
  project_task_state: 'active' | 'completed' | 'archived';
  thread_state: string;
  vendor_session_id: string | null;
  previous_vendor_session_id: string | null;
  run_count: number;
  work_order_count: number;
  compaction_count: number;
  transcript_bytes: number;
  updated_at: string;
}

export function getEmployeeRuntime(db: DB, profileId: string): EmployeeRuntimeDTO {
  getAgentProfile(db, profileId);
  const employments = listProfileEmployments(db, profileId);
  const rows = db.prepare(`
    SELECT ce.id employee_id, ce.role,
      p.id project_id, p.name project_name, ptt.id thread_id,
      pt.id project_task_id, pt.title project_task_title, pt.state project_task_state,
      ptt.state thread_state, ptt.vendor_session_id, ptt.previous_vendor_session_id,
      ptt.run_count, ptt.compaction_count, ptt.transcript_bytes, ptt.updated_at,
      COUNT(DISTINCT t.id) work_order_count
    FROM company_employee ce
    JOIN project_task_thread ptt ON ptt.employee_id=ce.legacy_agent_id
    JOIN project_task pt ON pt.id=ptt.project_task_id
    JOIN project p ON p.id=pt.project_id
    LEFT JOIN task t ON t.assignee_task_thread_id=ptt.id
    WHERE ce.profile_id=?
    GROUP BY ptt.id
    ORDER BY ce.created_at, p.updated_at DESC, ptt.updated_at DESC
  `).all(profileId) as RuntimeRow[];

  const employmentDtos = employments.map((employment) => {
    const employmentRows = rows.filter((row) => row.employee_id === employment.id);
    const projectIds = [...new Set(employmentRows.map((row) => row.project_id))];
    return {
      employeeId: employment.id,
      role: employment.role,
      projects: projectIds.map((projectId) => {
        const projectRows = employmentRows.filter((row) => row.project_id === projectId);
        const artifactCount = (db.prepare(`
          SELECT COUNT(DISTINCT a.id) count FROM artifact a
          LEFT JOIN task t ON t.id=a.created_task_id
          WHERE a.project_id=? AND (a.owner_agent_id=? OR t.assignee_agent_id=?)
        `).get(projectId, employment.legacyAgentId, employment.legacyAgentId) as { count: number }).count;
        return {
          projectId,
          projectName: projectRows[0].project_name,
          threads: projectRows.map((row) => ({
            id: row.thread_id,
            projectTaskId: row.project_task_id,
            projectTaskTitle: row.project_task_title,
            projectTaskState: row.project_task_state,
            state: row.thread_state,
            vendorSessionState: row.vendor_session_id ? 'active' as const : row.previous_vendor_session_id ? 'replaced' as const : 'not-created' as const,
            runCount: row.run_count,
            workOrderCount: row.work_order_count,
            compactionCount: row.compaction_count,
            transcriptBytes: row.transcript_bytes,
            updatedAt: row.updated_at,
          })),
          artifactCount,
          lastActivityAt: projectRows[0]?.updated_at ?? null,
        };
      }),
    };
  });
  return {
    profileId,
    totals: {
      employments: employments.length,
      projects: new Set(rows.map((row) => row.project_id)).size,
      threads: rows.length,
      workOrders: rows.reduce((sum, row) => sum + row.work_order_count, 0),
      artifacts: employmentDtos.reduce((sum, employment) => sum + employment.projects.reduce((projectSum, project) => projectSum + project.artifactCount, 0), 0),
    },
    employments: employmentDtos,
  };
}
