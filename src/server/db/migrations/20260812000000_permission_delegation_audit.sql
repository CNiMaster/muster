-- 批次 B：权限委托链 + 产物写入审计。
-- 设计见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第三节。
--
-- 权限委托链：员工操作超出权限时，系统自动找其直接负责人（relationship org 边）审批，
-- 不用人逐个批。下级申请权限变更（临时/项目/永久 + 原因），上级批，变更记录留资料内。
--
-- 产物写入审计：扩展现有 publish_record（已记 task/thread/commit），新增细粒度变更日志，
-- 让用户可查看"谁在什么时候改了什么"。

-- 权限变更申请：下级申请、上级审批
CREATE TABLE IF NOT EXISTS permission_change_request (
  id                        TEXT PRIMARY KEY,
  company_id                TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  requester_employee_id     TEXT NOT NULL,             -- 申请人（agent_definition.id）
  target_path_prefix        TEXT,                      -- 针对哪个目录/资料
  requested_effect          TEXT NOT NULL CHECK (requested_effect IN ('allow','deny')),
  requested_action          TEXT,                      -- read-file/write-file/delete 等
  requested_scope           TEXT NOT NULL CHECK (requested_scope IN ('temp','project','permanent')),
  reason                    TEXT NOT NULL,             -- 申请原因
  approver_employee_id      TEXT,                      -- 审批人（直接负责人，org 边上溯）
  state                     TEXT NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending','approved','rejected','cancelled')),
  valid_until               TEXT,                      -- temp/project 期的到期时间
  approved_rule_id          TEXT,                      -- 批准后生成的 permission_rule id
  created_at                TEXT NOT NULL,
  decided_at                TEXT,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perm_change_requester ON permission_change_request(requester_employee_id, state);
CREATE INDEX IF NOT EXISTS idx_perm_change_approver ON permission_change_request(approver_employee_id, state);

-- 产物写入审计日志：细粒度变更记录（扩展 publish_record）
CREATE TABLE IF NOT EXISTS artifact_change_log (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  artifact_path   TEXT NOT NULL,
  agent_id        TEXT,                                  -- 操作人（离职后置 NULL）
  action          TEXT NOT NULL CHECK (action IN ('create','update','delete','transfer')),
  task_id         TEXT,                                  -- 来源任务
  detail          TEXT,                                  -- 变更摘要
  transferred_to  TEXT,                                  -- action=transfer 时的接手人
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_change_project ON artifact_change_log(project_id, artifact_path, created_at);
CREATE INDEX IF NOT EXISTS idx_artifact_change_agent ON artifact_change_log(agent_id, created_at);
