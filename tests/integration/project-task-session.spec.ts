import {describe,expect,it} from 'vitest';
import {makeTestDb} from './setup';
import {createCompany} from '../../src/server/domain/company';
import {createProject} from '../../src/server/domain/project';
import {createAgent} from '../../src/server/domain/agent';
import {createProjectTask,archiveProjectTask,completeProjectTask,listProjectTasks} from '../../src/server/domain/project-task';
import {ensureProjectTaskThread,setProjectTaskThreadSession} from '../../src/server/domain/project-task-thread';
import {createTask} from '../../src/server/domain/task';

describe('project task context boundary',()=>{
  it('creates employee vendor sessions lazily per user-created project task',()=>{
    const{db,close}=makeTestDb();try{
      const company=createCompany(db,{name:'公司'});
      const employee=createAgent(db,{companyId:company.id,name:'员工',role:'developer'});
      const project=createProject(db,{companyId:company.id,name:'项目',rootDir:'/tmp/project'});
      const first=createProjectTask(db,{projectId:project.id,title:'功能一'});
      const second=createProjectTask(db,{projectId:project.id,title:'功能二'});
      expect(db.prepare('SELECT COUNT(*) n FROM project_task_thread').get()).toEqual({n:0});
      const thread=ensureProjectTaskThread(db,{projectTaskId:first.id,employeeId:employee.id,executorProfileId:null});
      expect(ensureProjectTaskThread(db,{projectTaskId:first.id,employeeId:employee.id,executorProfileId:null}).id).toBe(thread.id);
      expect(ensureProjectTaskThread(db,{projectTaskId:second.id,employeeId:employee.id,executorProfileId:null}).id).not.toBe(thread.id);
      expect(setProjectTaskThreadSession(db,thread.id,'vendor-session').vendorSessionId).toBe('vendor-session');
    }finally{close();}
  });

  it('associates employee work orders and refuses new work after archive',()=>{
    const{db,close}=makeTestDb();try{
      const company=createCompany(db,{name:'公司'});
      const employee=createAgent(db,{companyId:company.id,name:'员工',role:'developer'});
      const project=createProject(db,{companyId:company.id,name:'项目',rootDir:'/tmp/project'});
      const projectTask=createProjectTask(db,{projectId:project.id,title:'用户任务'});
      const work=createTask(db,{projectId:project.id,projectTaskId:projectTask.id,assigneeAgentId:employee.id,title:'内部工作单'});
      expect(work.projectTaskId).toBe(projectTask.id);
      archiveProjectTask(db,projectTask.id);
      expect(()=>createTask(db,{projectId:project.id,projectTaskId:projectTask.id,title:'不允许'})).toThrow(/归档/);
      expect(()=>ensureProjectTaskThread(db,{projectTaskId:projectTask.id,employeeId:employee.id,executorProfileId:null})).toThrow(/归档/);
      expect(listProjectTasks(db,project.id)[0]?.state).toBe('archived');
    }finally{close();}
  });

  it('creates a compatibility project task for legacy root work orders',()=>{
    const{db,close}=makeTestDb();try{
      const company=createCompany(db,{name:'公司'});
      const project=createProject(db,{companyId:company.id,name:'项目',rootDir:'/tmp/project'});
      const root=createTask(db,{projectId:project.id,title:'旧根任务'});
      const child=createTask(db,{projectId:project.id,parentTaskId:root.id,title:'旧子任务'});
      expect(root.projectTaskId).toBeTruthy();
      expect(child.projectTaskId).toBe(root.projectTaskId);
      expect(listProjectTasks(db,project.id)).toHaveLength(1);
    }finally{close();}
  });

  it('refuses to complete or archive a project task through another project boundary',()=>{
    const{db,close}=makeTestDb();try{
      const company=createCompany(db,{name:'公司'});
      const first=createProject(db,{companyId:company.id,name:'项目一',rootDir:'/tmp/project-one'});
      const second=createProject(db,{companyId:company.id,name:'项目二',rootDir:'/tmp/project-two'});
      const projectTask=createProjectTask(db,{projectId:second.id,title:'项目二任务'});
      expect(()=>completeProjectTask(db,projectTask.id,first.id)).toThrow(/不属于当前项目/);
      expect(()=>archiveProjectTask(db,projectTask.id,first.id)).toThrow(/不属于当前项目/);
      expect(listProjectTasks(db,second.id)[0]?.state).toBe('active');
    }finally{close();}
  });
});
