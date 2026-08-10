-- 项目 Playbook（阶段六任务 6.2）：
-- 项目创建时可选工作模式（不同阶段定义/成果类型/审批节点）。
-- 用项目元数据承载，不新建大表；playbook 目录定义在 src/server/domain/playbooks.ts。
ALTER TABLE project ADD COLUMN playbook_id TEXT;
