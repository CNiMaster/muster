import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, param } from './middleware';
import { bindCompanyEmployeesPermission, bindEmployeePermissionPolicy, createPermissionPolicy, listApprovalQueue, listPermissionPolicies, recordApprovalDecision, requestApproval, savePermissionRule } from '../domain/permission';
import { approvalBroker } from '../domain/approval-broker';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';

export const permissionsRouter = Router();
const strategy = z.enum(['ask-always','ask-by-rule','no-approval','deny']);
const scope = z.enum(['task','project','workspace','selected-directories','device']);

permissionsRouter.get('/policies', asyncHandler(async (_req,res)=>res.json(listPermissionPolicies(getDb()))));
permissionsRouter.post('/policies', asyncHandler(async (req,res)=>{ const input=z.object({name:z.string().min(1),approvalStrategy:strategy,scope,selectedDirectories:z.array(z.string()).optional()}).parse(req.body); res.status(201).json(createPermissionPolicy(getDb(),input)); }));
permissionsRouter.post('/policies/:id/rules', asyncHandler(async (req,res)=>{ const input=z.object({effect:z.enum(['allow','deny']),action:z.string().optional(),commandPattern:z.string().optional(),pathPrefix:z.string().optional(),fileExtension:z.string().optional(),employeeId:z.string().optional(),companyId:z.string().optional(),projectId:z.string().optional(),taskId:z.string().optional(),network:z.boolean().optional(),subprocess:z.boolean().optional(),expiresAt:z.string().optional()}).parse(req.body); res.status(201).json({id:savePermissionRule(getDb(),param(req,'id'),input)}); }));
permissionsRouter.get('/approvals', asyncHandler(async (_req,res)=>res.json(listApprovalQueue(getDb(),(id)=>approvalBroker.hasWaiter(id)))));
permissionsRouter.post('/approvals', asyncHandler(async (req,res)=>{ const input=z.object({policyId:z.string(),employeeId:z.string(),taskId:z.string(),action:z.string(),command:z.string().optional(),path:z.string().optional(),risk:z.string().optional()}).parse(req.body); res.status(201).json(requestApproval(getDb(),input)); }));
permissionsRouter.post('/approvals/:id/decision', asyncHandler(async (req,res)=>{ const input=z.object({decision:z.enum(['deny','allow-once','allow-command','allow-directory','custom-rule']),rule:z.any().optional()}).parse(req.body);const id=param(req,'id'),db=getDb();const row=db.prepare(`SELECT pa.task_id taskId,t.project_id projectId,t.project_task_id projectTaskId,p.company_id companyId FROM permission_approval pa JOIN task t ON t.id=pa.task_id JOIN project p ON p.id=t.project_id WHERE pa.id=?`).get(id) as {taskId:string;projectId:string;projectTaskId:string;companyId:string};const online=approvalBroker.hasWaiter(id);recordApprovalDecision(db,id,input,{resumeTask:!online});approvalBroker.resolve(id,input.decision==='deny'?'deny':'allow');realtime.publish(makeLifecycleEvent('approval.decided',{approvalId:id,decision:input.decision,taskId:row.taskId},{companyId:row.companyId,projectId:row.projectId,taskId:row.taskId})); res.json({ok:true}); }));
permissionsRouter.put('/employees/:employeeId/policy/:policyId', asyncHandler(async (req,res)=>{ bindEmployeePermissionPolicy(getDb(),param(req,'employeeId'),param(req,'policyId')); res.json({ok:true}); }));
/** 按公司批量绑定权限策略到所有员工（要求公司下班）。 */
permissionsRouter.post('/companies/:companyId/binding', asyncHandler(async (req,res)=>{ const input=z.object({policyId:z.string().min(1)}).parse(req.body); const result=bindCompanyEmployeesPermission(getDb(),param(req,'companyId'),input.policyId); res.json(result); }));
