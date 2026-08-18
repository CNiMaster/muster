/**
 * 凭据库管理 API。
 * 平台级:
 *   GET    /api/credentials            列出凭据定义(支持 category/defaultsOnly 筛选)
 *   POST   /api/credentials            创建凭据定义
 *   GET    /api/credentials/:id        凭据定义详情
 *   PUT    /api/credentials/:id        更新凭据定义
 *   DELETE /api/credentials/:id        删除凭据定义
 *   PUT    /api/credentials/:id/default 设置/取消默认派发
 * (公司级覆盖路由已随公司退役 D4-1 下线：凭据解析降为 平台>员工 两级) */
import { Router } from 'express';
import { getDb } from '../db/client';
import {
  createCredentialDefinition,
  deleteCredentialDefinition,
  getCredentialDefinition,
  listCredentialDefinitions,
  setCredentialDefinitionDefault,
  updateCredentialDefinition,
} from '../domain/credential-store';
import { AppError, ErrorCode } from '../../shared/errors';
import { asyncHandler, param } from './middleware';

export const credentialsRouter = Router();

credentialsRouter.get('/', asyncHandler(async (req, res) => {
  const category = typeof req.query.category === 'string' ? (req.query.category as 'llm' | 'external-api') : undefined;
  const defaultsOnly = req.query.defaults === '1' || req.query.defaults === 'true';
  res.json(listCredentialDefinitions(getDb(), { category, defaultsOnly }));
}));

credentialsRouter.post('/', asyncHandler(async (req, res) => {
  const { name, credentialKey, kind, category, description, applicableExecutors, isDefault } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) throw new AppError(ErrorCode.VALIDATION, 'name 不能为空');
  if (typeof credentialKey !== 'string' || !credentialKey.trim()) throw new AppError(ErrorCode.VALIDATION, 'credentialKey 不能为空');
  // 校验 applicableExecutors 每个元素是合法的 provider 标识(字母/数字/连字符,不含逗号)
  const cleanExecutors = Array.isArray(applicableExecutors)
    ? applicableExecutors.filter((v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v))
    : [];
  res.status(201).json(createCredentialDefinition(getDb(), {
    name, credentialKey,
    kind: kind === 'keychain' || kind === 'cli-login' ? kind : 'env',
    category: category === 'external-api' ? 'external-api' : 'llm',
    description, applicableExecutors: cleanExecutors,
    isDefault: isDefault === true,
  }));
}));

credentialsRouter.get('/:id', asyncHandler(async (req, res) => {
  const def = getCredentialDefinition(getDb(), param(req, 'id'));
  if (!def) throw new AppError(ErrorCode.NOT_FOUND, '凭据定义不存在');
  res.json(def);
}));

credentialsRouter.put('/:id', asyncHandler(async (req, res) => {
  res.json(updateCredentialDefinition(getDb(), param(req, 'id'), req.body ?? {}));
}));

credentialsRouter.delete('/:id', asyncHandler(async (req, res) => {
  deleteCredentialDefinition(getDb(), param(req, 'id'));
  res.status(204).end();
}));

credentialsRouter.put('/:id/default', asyncHandler(async (req, res) => {
  const isDefault = req.body?.isDefault === true;
  res.json(setCredentialDefinitionDefault(getDb(), param(req, 'id'), isDefault));
}));
