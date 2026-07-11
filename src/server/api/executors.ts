import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { SERVER_CONFIG } from '../env';
import { asyncHandler, param } from './middleware';
import { BUILTIN_EXECUTOR_MANIFESTS } from '../executors/manifests';
import { createExecutorInstallPlan, detectExecutor, executeExecutorInstallPlan, getExecutorInstall, launchExecutorLogin, rollbackExecutorInstall } from '../domain/executor-install';
import { bindEmployeeExecutorProfile, createExecutorProfile, listExecutorProfiles } from '../domain/executor-profile';

export const executorsRouter = Router();

executorsRouter.get('/manifests', asyncHandler(async (_req,res)=>res.json(BUILTIN_EXECUTOR_MANIFESTS)));
executorsRouter.get('/profiles', asyncHandler(async (_req,res)=>res.json(listExecutorProfiles(getDb()))));
executorsRouter.post('/profiles', asyncHandler(async (req,res)=>{const input=z.object({name:z.string().min(1),manifestId:z.string(),config:z.record(z.unknown()).optional(),credentialRef:z.object({kind:z.enum(['env','keychain','cli-login','encrypted-local']),reference:z.string().min(1)}).optional(),install:z.record(z.unknown()).optional(),concurrencyMode:z.enum(['parallel','profile-serial','global-serial']).optional()}).parse(req.body);res.status(201).json(createExecutorProfile(getDb(),input));}));
executorsRouter.put('/employees/:employeeId/profile/:executorProfileId', asyncHandler(async (req,res)=>{bindEmployeeExecutorProfile(getDb(),param(req,'employeeId'),param(req,'executorProfileId'));res.json({ok:true});}));
executorsRouter.post('/:manifestId/detect', asyncHandler(async (req,res)=>res.json(await detectExecutor(param(req,'manifestId')))));
executorsRouter.post('/:manifestId/install-plan', asyncHandler(async (req,res)=>{const {channel}=z.object({channel:z.string().min(1).default('stable')}).parse(req.body??{});res.status(201).json(createExecutorInstallPlan(getDb(),{manifestId:param(req,'manifestId'),channel,musterHome:SERVER_CONFIG.musterDir}));}));
executorsRouter.get('/installs/:id', asyncHandler(async (req,res)=>res.json(getExecutorInstall(getDb(),param(req,'id')))));
executorsRouter.post('/installs/:id/execute', asyncHandler(async (req,res)=>{const {confirmationToken}=z.object({confirmationToken:z.string().min(1)}).parse(req.body);res.json(await executeExecutorInstallPlan(getDb(),param(req,'id'),confirmationToken));}));
executorsRouter.post('/installs/:id/rollback', asyncHandler(async (req,res)=>res.json(rollbackExecutorInstall(getDb(),param(req,'id')))));
executorsRouter.post('/installs/:id/login', asyncHandler(async (req,res)=>res.json(await launchExecutorLogin(getDb(),param(req,'id')))));
