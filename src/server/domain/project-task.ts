import type {DB} from '../db/client';
import {AppError,ErrorCode} from '../../shared/errors';
import {nowIso,shortId} from '../../shared/utils';
import {getProject} from './project';

export type ProjectTaskState='active'|'completed'|'archived';
export interface ProjectTask{id:string;projectId:string;seq:number;title:string;brief:string;state:ProjectTaskState;completedAt:string|null;archivedAt:string|null;createdAt:string;updatedAt:string}
type Row={id:string;project_id:string;seq:number;title:string;brief:string;state:ProjectTaskState;completed_at:string|null;archived_at:string|null;created_at:string;updated_at:string};
const fromRow=(r:Row):ProjectTask=>({id:r.id,projectId:r.project_id,seq:r.seq,title:r.title,brief:r.brief,state:r.state,completedAt:r.completed_at,archivedAt:r.archived_at,createdAt:r.created_at,updatedAt:r.updated_at});

export function createProjectTask(db:DB,input:{projectId:string;title:string;brief?:string}):ProjectTask{
  getProject(db,input.projectId);const title=input.title.trim();if(!title)throw new AppError(ErrorCode.VALIDATION,'项目任务标题不能为空');
  const seq=((db.prepare('SELECT MAX(seq) m FROM project_task WHERE project_id=?').get(input.projectId) as {m:number|null})?.m??0)+1;
  const id=shortId('pt_'),now=nowIso();db.prepare('INSERT INTO project_task (id,project_id,seq,title,brief,state,created_at,updated_at) VALUES (?,?,?,?,?,\'active\',?,?)').run(id,input.projectId,seq,title,input.brief?.trim()??'',now,now);return getProjectTask(db,id);
}
export function getProjectTask(db:DB,id:string):ProjectTask{const row=db.prepare('SELECT * FROM project_task WHERE id=?').get(id) as Row|undefined;if(!row)throw new AppError(ErrorCode.NOT_FOUND,`项目任务不存在: ${id}`);return fromRow(row);}
export function getProjectTaskInProject(db:DB,id:string,projectId:string):ProjectTask{const task=getProjectTask(db,id);if(task.projectId!==projectId)throw new AppError(ErrorCode.VALIDATION,'项目任务不属于当前项目');return task;}
export function listProjectTasks(db:DB,projectId:string):ProjectTask[]{return(db.prepare('SELECT * FROM project_task WHERE project_id=? ORDER BY seq DESC').all(projectId) as Row[]).map(fromRow);}
export function assertProjectTaskActive(db:DB,id:string,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);if(task.state==='archived')throw new AppError(ErrorCode.CONFLICT,'项目任务已归档，不能继续派工');return task;}
export function completeProjectTask(db:DB,id:string,projectId?:string):ProjectTask{const task=assertProjectTaskActive(db,id,projectId);const now=nowIso();db.prepare("UPDATE project_task SET state='completed',completed_at=?,updated_at=? WHERE id=?").run(now,now,task.id);return getProjectTask(db,id);}
export function archiveProjectTask(db:DB,id:string,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);if(task.state==='archived')return task;const now=nowIso();db.transaction(()=>{db.prepare("UPDATE task SET state='cancelled',lease_owner_thread_id=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=? WHERE project_task_id=? AND state NOT IN ('completed','failed','cancelled')").run(now,id);db.prepare("UPDATE project_task_thread SET state='archived',updated_at=? WHERE project_task_id=?").run(now,id);db.prepare("UPDATE project_task SET state='archived',archived_at=?,updated_at=? WHERE id=?").run(now,now,id);})();return getProjectTask(db,id);}
