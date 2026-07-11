import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, param } from './middleware';
import { BUILTIN_EXECUTOR_MANIFESTS } from '../executors/manifests';
import { bindDetectedSystemExecutor, detectSystemExecutor, testExecutorProfileConnection } from '../domain/executor-discovery';
import { bindEmployeeExecutorProfile, createExecutorProfile, listExecutorProfiles } from '../domain/executor-profile';

export const executorsRouter = Router();

executorsRouter.get('/manifests', asyncHandler(async (_req,res)=>res.json(BUILTIN_EXECUTOR_MANIFESTS)));
executorsRouter.get('/profiles', asyncHandler(async (_req,res)=>res.json(listExecutorProfiles(getDb()))));
executorsRouter.post('/profiles', asyncHandler(async (req,res)=>{const input=z.object({name:z.string().min(1),manifestId:z.string(),config:z.record(z.unknown()).optional(),credentialRef:z.object({kind:z.enum(['env','keychain','cli-login','encrypted-local']),reference:z.string().min(1)}).optional(),install:z.record(z.unknown()).optional(),concurrencyMode:z.enum(['parallel','profile-serial','global-serial']).optional()}).parse(req.body);res.status(201).json(createExecutorProfile(getDb(),input));}));
executorsRouter.put('/employees/:employeeId/profile/:executorProfileId', asyncHandler(async (req,res)=>{bindEmployeeExecutorProfile(getDb(),param(req,'employeeId'),param(req,'executorProfileId'));res.json({ok:true});}));
executorsRouter.post('/:manifestId/detect', asyncHandler(async (req,res)=>res.json(await detectSystemExecutor(param(req,'manifestId')))));
executorsRouter.post('/:manifestId/bind-system', asyncHandler(async (req,res)=>res.status(201).json(await bindDetectedSystemExecutor(getDb(),param(req,'manifestId')))));
executorsRouter.post('/profiles/:id/test', asyncHandler(async (req,res)=>res.json(await testExecutorProfileConnection(getDb(),param(req,'id')))));
