-- safety: destructive
-- 前置数据修复（公司退役批次 D 收尾前置）：清理孤儿行——引用的父行已删除的残留子行。
-- runMigrations 每文件事务后跑全库 PRAGMA foreign_key_check，存量违规会拦下后续迁移（fail-closed 拒启动），
-- 故本批 rebuild 迁移（20260830100000）之前必须先清。干净库（如测试内存库）全部为 no-op；
-- 主库执行前 runner 自动生成 pre-migration 快照兜底，可整体回滚。
DELETE FROM knowledge_base
  WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM project);
DELETE FROM project_dir
  WHERE project_id NOT IN (SELECT id FROM project);
DELETE FROM project_task
  WHERE project_id NOT IN (SELECT id FROM project);
DELETE FROM memory_version
  WHERE entry_id NOT IN (SELECT id FROM memory_entry);
DELETE FROM memory_version
  WHERE source_candidate_id IS NOT NULL AND source_candidate_id NOT IN (SELECT id FROM memory_candidate);
DELETE FROM memory_injection
  WHERE task_id NOT IN (SELECT id FROM task);
DELETE FROM memory_injection
  WHERE entry_id NOT IN (SELECT id FROM memory_entry);
DELETE FROM agent_profile_base
  WHERE profile_id NOT IN (SELECT id FROM agent_profile);
DELETE FROM company_employee
  WHERE legacy_agent_id NOT IN (SELECT id FROM agent_definition);
