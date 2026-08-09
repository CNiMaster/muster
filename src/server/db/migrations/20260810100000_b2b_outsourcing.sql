-- B2B 跨组织任务委派（外包）契约表。
-- 设计见 docs/superpowers/specs/2026-08-10-b2b-outsourcing-design.md。
--
-- 「公司」是软件内的本地组织概念，非真实企业实体。本表记录甲方（source）向乙方（target）
-- 委派任务的全生命周期：发起到接受、执行、交付、验收（含返工）、完成/终止。
--
-- 文件交付模型：乙方承接任务的 worktree 基于甲方 source_project 的 git repo 切出，
-- publish 目标指向甲方 rootDir 的 deliverable_dir 子目录（复用三方合并管线）。
-- readonly_refs_json 记录授予乙方只读的甲方资料路径，运行时经 --add-dir 授权。
CREATE TABLE IF NOT EXISTS outsourcing_contract (
  id                          TEXT PRIMARY KEY,
  source_company_id           TEXT NOT NULL REFERENCES company(id),
  target_company_id           TEXT NOT NULL REFERENCES company(id),
  source_project_id           TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_task_id              TEXT REFERENCES task(id) ON DELETE SET NULL,
  outsourced_task_id          TEXT REFERENCES task(id) ON DELETE SET NULL,
  title                       TEXT NOT NULL,
  brief                       TEXT NOT NULL,
  acceptance_criteria_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_criteria_json)),
  required_capability_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_capability_ids_json)),
  deliverable_dir             TEXT,
  readonly_refs_json          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(readonly_refs_json)),
  state                       TEXT NOT NULL DEFAULT 'pending'
                                CHECK (state IN ('pending','accepted','in_progress','delivered','reviewing','changes_requested','completed','rejected','cancelled')),
  vendor_liaison_agent_id     TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  dispatcher_agent_id         TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  feedback_json               TEXT,
  revision_round              INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outsourcing_source ON outsourcing_contract(source_company_id, state);
CREATE INDEX IF NOT EXISTS idx_outsourcing_target ON outsourcing_contract(target_company_id, state);
CREATE INDEX IF NOT EXISTS idx_outsourcing_outsourced_task ON outsourcing_contract(outsourced_task_id);

-- task 表增 outsourcing_contract_id 列：标记本 task 是某个外包契约的承接任务。
-- engine.ts 据此识别 outsourced 任务，切换 worktree 源 repo 与 publish 目标。
-- 默认 NULL（普通任务不受影响，零回归）。
ALTER TABLE task ADD COLUMN outsourcing_contract_id TEXT REFERENCES outsourcing_contract(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_task_outsourcing ON task(outsourcing_contract_id) WHERE outsourcing_contract_id IS NOT NULL;
