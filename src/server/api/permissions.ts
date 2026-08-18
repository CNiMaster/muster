import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, param, companyIdOf } from './middleware';
import { bindCompanyEmployeesPermission, bindEmployeePermissionPolicy, createPermissionPolicy, listApprovalQueue, listPermissionPolicies, recordApprovalDecision, requestApproval, savePermissionRule } from '../domain/permission';
import { approvalBroker } from '../domain/approval-broker';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';

export const permissionsRouter = Router();
const strategy = z.enum(['ask-always','ask-by-rule','no-approval','deny']);
const scope = z.enum(['task','project','workspace','selected-directories','device']);

permissionsRouter.get('/policies', asyncHandler(async (_req,res)=>res.json(listPermissionPolicies(getDb()))));
permissionsRouter.post('/policies', asyncHandler(async (req,res)=>{ const input=z.object({name:z.string().min(1),approvalStrategy:strategy,scope,selectedDirectories:z.array(z.string()).optional()}).parse(req.body); res.status(201).json(createPermissionPolicy(getDb(),input)); }));
permissionsRouter.post('/policies/:id/rules', asyncHandler(async (req,res)=>{ const input=z.object({effect:z.enum(['allow','deny']),action:z.string().optional(),commandPattern:z.string().optional(),pathPrefix:z.string().optional(),fileExtension:z.string().optional(),employeeId:z.string().optional(),projectId:z.string().optional(),taskId:z.string().optional(),network:z.boolean().optional(),subprocess:z.boolean().optional(),expiresAt:z.string().optional()}).parse(req.body); res.status(201).json({id:savePermissionRule(getDb(),param(req,'id'),input)}); }));
permissionsRouter.get('/approvals', asyncHandler(async (_req,res)=>res.json(listApprovalQueue(getDb(),(id)=>approvalBroker.hasWaiter(id)))));
permissionsRouter.post('/approvals', asyncHandler(async (req,res)=>{ const input=z.object({policyId:z.string(),employeeId:z.string(),taskId:z.string(),action:z.string(),command:z.string().optional(),path:z.string().optional(),risk:z.string().optional()}).parse(req.body); res.status(201).json(requestApproval(getDb(),input)); }));
permissionsRouter.post('/approvals/:id/decision', asyncHandler(async (req,res)=>{ const input=z.object({decision:z.enum(['deny','allow-once','allow-command','allow-directory','custom-rule']),rule:z.any().optional()}).parse(req.body);const id=param(req,'id'),db=getDb();const row=db.prepare(`SELECT pa.task_id taskId,t.project_id projectId,t.project_task_id projectTaskId FROM permission_approval pa JOIN task t ON t.id=pa.task_id WHERE pa.id=?`).get(id) as {taskId:string;projectId:string;projectTaskId:string};const online=approvalBroker.hasWaiter(id);recordApprovalDecision(db,id,input,{resumeTask:!online});approvalBroker.resolve(id,input.decision==='deny'?'deny':'allow');realtime.publish(makeLifecycleEvent('approval.decided',{approvalId:id,decision:input.decision,taskId:row.taskId},{projectId:row.projectId,taskId:row.taskId})); res.json({ok:true}); }));
permissionsRouter.put('/employees/:employeeId/policy/:policyId', asyncHandler(async (req,res)=>{ bindEmployeePermissionPolicy(getDb(),param(req,'employeeId'),param(req,'policyId')); res.json({ok:true}); }));
/** 按工作台批量绑定权限策略到所有员工（要求工作台下班）—— 公司退役批次A双挂（旧 /companies/:companyId/binding 与新 /binding）。 */
const companyBindingHandler = asyncHandler(async (req, res) => {
  const input = z.object({ policyId: z.string().min(1) }).parse(req.body);
  const result = bindCompanyEmployeesPermission(getDb(), input.policyId);
  res.json(result);
});
permissionsRouter.post('/binding', companyBindingHandler);

/**
 * 批量审批：列出 pending 审批（含 AI 字段），AI 分类为"建议批量通过"/"有风险逐条审"。
 * 用于公司级/永久通过的人工批量处理（AI 判 safe 但需人工升级的高级别规则）。
 */
permissionsRouter.get('/approvals/batch-review', asyncHandler(async (_req,res)=>{
  const db=getDb();
  const rows=db.prepare(`SELECT pa.id,pa.action,pa.command,pa.path,pa.ai_verdict,pa.ai_suggestion,pa.ai_reason,pa.ai_confidence,pa.safety_category,pa.highest_safe_level,pa.created_at,pa.policy_id,t.title taskTitle,e.name employeeName FROM permission_approval pa LEFT JOIN task t ON t.id=pa.task_id LEFT JOIN company_employee e ON e.id=pa.employee_id WHERE pa.status='pending' ORDER BY pa.created_at DESC`).all() as Array<Record<string,unknown>>;
  // 按 highest_safe_level 分组：company_scope/permanent 的进入"建议批量通过"
  const suggestBatch=rows.filter(r=>r.highest_safe_level==='company_scope'||r.highest_safe_level==='permanent');
  const needsManual=rows.filter(r=>!r.highest_safe_level||r.highest_safe_level==='execute_once'||r.highest_safe_level==='project_scope');
  res.json({suggestBatch,needsManual,total:rows.length});
}));

/** 批量决策：一键通过"建议批量通过"组的多个审批（建对应级别规则）。 */
permissionsRouter.post('/approvals/batch-decision', asyncHandler(async (req,res)=>{
  const input=z.object({approvalIds:z.array(z.string()).min(1),decision:z.enum(['allow-command','allow-directory','deny'])}).parse(req.body);
  const db=getDb();
  const results:Array<{id:string;ok:boolean;error?:string}>=[];
  for(const id of input.approvalIds){
    try{
      recordApprovalDecision(db,id,{decision:input.decision},{resumeTask:false});
      approvalBroker.resolve(id,input.decision==='deny'?'deny':'allow');
      results.push({id,ok:true});
    }catch(e){results.push({id,ok:false,error:(e as Error).message});}
  }
  res.json({results});
}));
