import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, param } from './middleware';
import { bindEmployeePermissionPolicy, createPermissionPolicy, listPendingApprovals, listPermissionPolicies, recordApprovalDecision, requestApproval, savePermissionRule } from '../domain/permission';
import { approvalBroker } from '../domain/approval-broker';

export const permissionsRouter = Router();
const strategy = z.enum(['ask-always','ask-by-rule','no-approval','deny']);
const scope = z.enum(['task','project','workspace','selected-directories','device']);

permissionsRouter.get('/policies', asyncHandler(async (_req,res)=>res.json(listPermissionPolicies(getDb()))));
permissionsRouter.post('/policies', asyncHandler(async (req,res)=>{ const input=z.object({name:z.string().min(1),approvalStrategy:strategy,scope,selectedDirectories:z.array(z.string()).optional()}).parse(req.body); res.status(201).json(createPermissionPolicy(getDb(),input)); }));
permissionsRouter.post('/policies/:id/rules', asyncHandler(async (req,res)=>{ const input=z.object({effect:z.enum(['allow','deny']),action:z.string().optional(),commandPattern:z.string().optional(),pathPrefix:z.string().optional(),fileExtension:z.string().optional(),employeeId:z.string().optional(),companyId:z.string().optional(),projectId:z.string().optional(),taskId:z.string().optional(),network:z.boolean().optional(),subprocess:z.boolean().optional(),expiresAt:z.string().optional()}).parse(req.body); res.status(201).json({id:savePermissionRule(getDb(),param(req,'id'),input)}); }));
permissionsRouter.get('/approvals', asyncHandler(async (_req,res)=>res.json(listPendingApprovals(getDb()))));
permissionsRouter.post('/approvals', asyncHandler(async (req,res)=>{ const input=z.object({policyId:z.string(),employeeId:z.string(),taskId:z.string(),action:z.string(),command:z.string().optional(),path:z.string().optional(),risk:z.string().optional()}).parse(req.body); res.status(201).json(requestApproval(getDb(),input)); }));
permissionsRouter.post('/approvals/:id/decision', asyncHandler(async (req,res)=>{ const input=z.object({decision:z.enum(['deny','allow-once','allow-command','allow-directory','custom-rule']),rule:z.any().optional()}).parse(req.body);const id=param(req,'id'); recordApprovalDecision(getDb(),id,input);approvalBroker.resolve(id,input.decision==='deny'?'deny':'allow'); res.json({ok:true}); }));
permissionsRouter.put('/employees/:employeeId/policy/:policyId', asyncHandler(async (req,res)=>{ bindEmployeePermissionPolicy(getDb(),param(req,'employeeId'),param(req,'policyId')); res.json({ok:true}); }));
