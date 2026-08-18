import type {DB} from '../db/client';
import {AppError,ErrorCode} from '../../shared/errors';
import {nowIso,shortId} from '../../shared/utils';
import {getProject} from './project';
import { emptyProjectLaunchBrief, type ProjectLaunchBrief, type ProjectLaunchDiscovery } from '../../shared/project-launch';
import { readProjectLaunchSnapshot, type ProjectLaunchState } from './project-launch';

export type ProjectTaskState='active'|'completed'|'archived';
export interface ProjectTask{id:string;projectId:string;seq:number;title:string;brief:string;state:ProjectTaskState;pinned:boolean;sortOrder:number;unread:boolean;launchState:ProjectLaunchState;launchBrief:ProjectLaunchBrief;capabilityDiscovery:ProjectLaunchDiscovery|null;launchConfirmedAt:string|null;completedAt:string|null;archivedAt:string|null;createdAt:string;updatedAt:string}
type Row={id:string;project_id:string;seq:number;title:string;brief:string;state:ProjectTaskState;pinned:number;sort_order:number;unread:number;launch_state?:string;launch_brief_json?:string;capability_discovery_json?:string;launch_confirmed_at?:string|null;completed_at:string|null;archived_at:string|null;created_at:string;updated_at:string};
const fromRow=(r:Row):ProjectTask=>{const launch=readProjectLaunchSnapshot(r);return{id:r.id,projectId:r.project_id,seq:r.seq,title:r.title,brief:r.brief,state:r.state,pinned:r.pinned===1,sortOrder:r.sort_order,unread:r.unread===1,launchState:launch.state,launchBrief:launch.brief,capabilityDiscovery:launch.discovery,launchConfirmedAt:launch.confirmedAt,completedAt:r.completed_at,archivedAt:r.archived_at,createdAt:r.created_at,updatedAt:r.updated_at};};

export function createProjectTask(db:DB,input:{projectId:string;title:string;brief?:string;launchState?:ProjectLaunchState;launchBrief?:ProjectLaunchBrief}):ProjectTask{
  getProject(db,input.projectId);const title=input.title.trim();if(!title)throw new AppError(ErrorCode.VALIDATION,'项目任务标题不能为空');
  const seq=((db.prepare('SELECT MAX(seq) m FROM project_task WHERE project_id=?').get(input.projectId) as {m:number|null})?.m??0)+1;
  const id=shortId('pt_'),now=nowIso(),launchState=input.launchState??'confirmed',launchBrief=input.launchBrief??emptyProjectLaunchBrief();
  db.prepare("INSERT INTO project_task (id,project_id,seq,title,brief,state,launch_state,launch_brief_json,capability_discovery_json,launch_confirmed_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?, ?,?,?)")
    .run(id,input.projectId,seq,title,input.brief?.trim()??'',launchState,JSON.stringify(launchBrief),'{}',launchState==='confirmed'?now:null,now,now);return getProjectTask(db,id);
}
export function getProjectTask(db:DB,id:string):ProjectTask{const row=db.prepare('SELECT * FROM project_task WHERE id=?').get(id) as Row|undefined;if(!row)throw new AppError(ErrorCode.NOT_FOUND,`项目任务不存在: ${id}`);return fromRow(row);}
export function getProjectTaskInProject(db:DB,id:string,projectId:string):ProjectTask{const task=getProjectTask(db,id);if(task.projectId!==projectId)throw new AppError(ErrorCode.VALIDATION,'项目任务不属于当前项目');return task;}
export function listProjectTasks(db:DB,projectId:string):ProjectTask[]{return(db.prepare('SELECT * FROM project_task WHERE project_id=? ORDER BY pinned DESC, sort_order ASC, seq DESC').all(projectId) as Row[]).map(fromRow);}
/** 任务顶栏：重命名任务。 */
export function renameProjectTask(db:DB,id:string,title:string,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);const t=title.trim();if(!t)throw new AppError(ErrorCode.VALIDATION,'任务标题不能为空');db.prepare('UPDATE project_task SET title=?,updated_at=? WHERE id=?').run(t,nowIso(),task.id);return getProjectTask(db,task.id);}
/** 任务顶栏：标记已读/未读（打开任务详情即读）。 */
export function setProjectTaskUnread(db:DB,id:string,unread:boolean,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);db.prepare('UPDATE project_task SET unread=? WHERE id=?').run(unread?1:0,task.id);return getProjectTask(db,task.id);}

/** 管理工作台（修订轮）：任务拖动排序——orderedIds 自上而下赋 1..N；列表序 sort_order ASC（未拖过的 0 在前=新任务靠顶，拖过的按手排）。 */
export function reorderProjectTasks(db:DB,projectId:string,orderedIds:string[]):void{getProject(db,projectId);const now=nowIso();db.transaction(()=>{orderedIds.forEach((id,idx)=>{db.prepare('UPDATE project_task SET sort_order=?,updated_at=? WHERE id=? AND project_id=?').run(idx+1,now,id,projectId);});})();}
/** 管理工作台：置顶/取消置顶（仅影响列表排序，不动执行语义）。 */
export function setProjectTaskPinned(db:DB,id:string,pinned:boolean,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);db.prepare('UPDATE project_task SET pinned=?,updated_at=? WHERE id=?').run(pinned?1:0,nowIso(),task.id);return getProjectTask(db,id);}
/**
 * 管理工作台：删除项目任务的平台记录（DB 行级联清理子任务/线程；绝不触碰项目仓库文件）。
 * 归档区「删除」入口。要求先归档（终态语义干净），避免删掉进行中的工作。
 */
export function deleteProjectTaskRecord(db:DB,id:string,projectId?:string):void{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);if(task.state!=='archived')throw new AppError(ErrorCode.CONFLICT,'仅归档后的项目任务可删除记录');db.prepare('DELETE FROM project_task WHERE id=?').run(task.id);}
export function assertProjectTaskActive(db:DB,id:string,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);if(task.state==='archived')throw new AppError(ErrorCode.CONFLICT,'项目任务已归档，不能继续派工');return task;}
export function completeProjectTask(db:DB,id:string,projectId?:string):ProjectTask{const task=assertProjectTaskActive(db,id,projectId);const now=nowIso();db.prepare("UPDATE project_task SET state='completed',completed_at=?,updated_at=? WHERE id=?").run(now,now,task.id);return getProjectTask(db,id);}
export function archiveProjectTask(db:DB,id:string,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);if(task.state==='archived')return task;const now=nowIso();db.transaction(()=>{db.prepare("UPDATE task SET state='cancelled',lease_owner_thread_id=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=? WHERE project_task_id=? AND state NOT IN ('completed','failed','cancelled')").run(now,id);db.prepare("UPDATE project_task_thread SET state='archived',updated_at=? WHERE project_task_id=?").run(now,id);db.prepare("UPDATE project_task SET state='archived',archived_at=?,updated_at=? WHERE id=?").run(now,now,id);})();return getProjectTask(db,id);}
/** 管理工作台批3：归档还原（归档页「取消归档」）——回到 active，清归档时间戳。 */
export function restoreProjectTask(db:DB,id:string,projectId?:string):ProjectTask{const task=projectId?getProjectTaskInProject(db,id,projectId):getProjectTask(db,id);if(task.state!=='archived')return task;const now=nowIso();db.prepare("UPDATE project_task SET state='active',archived_at=NULL,updated_at=? WHERE id=?").run(now,task.id);return getProjectTask(db,task.id);}
