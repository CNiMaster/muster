-- Muster 初始 schema。
-- 14 个核心实体：company, department, agent_definition, relationship,
-- workflow, project, project_agent_thread, mirror, task, task_event,
-- task_message, trigger, artifact, report_cycle, usage_record。
--
-- 设计要点：
-- - 所有 PK 用 TEXT（应用层生成 shortId），便于跨进程稳定引用与导出。
-- - 时间统一 ISO 字符串；created_at/updated_at 由应用写入。
-- - 状态机字段用 TEXT CHECK 约束。
-- - 外键 + 级联：根实体删除时子实体级联（项目删除时其 Task 也删除）。
-- - 启用 WAL 与外键在 client.ts 中执行（PRAGMA 不能在 migration 事务里持久化）。

-- ============================================================
-- Company
-- ============================================================
CREATE TABLE company (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'novel',
  state           TEXT NOT NULL DEFAULT 'off'
                  CHECK (state IN ('off','online','draining','review_paused')),
  charter         TEXT NOT NULL DEFAULT '',         -- 公司章程，所有员工始终加载
  contract_json   TEXT NOT NULL DEFAULT '{}',       -- 结构化运行契约
  first_agent_id  TEXT,                              -- 公司负责人
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (first_agent_id) REFERENCES agent_definition(id) DEFERRABLE INITIALLY DEFERRED
);

-- ============================================================
-- Department
-- ============================================================
CREATE TABLE department (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  rules_json  TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE
);

-- ============================================================
-- Agent Definition（员工）
-- ============================================================
CREATE TABLE agent_definition (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  department_id   TEXT,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,                    -- 岗位 e.g. 'lead'|'writer'|'character'|'plot'|'inspector'
  responsibilities TEXT NOT NULL DEFAULT '',
  system_prompt   TEXT NOT NULL DEFAULT '',
  skills_json     TEXT NOT NULL DEFAULT '[]',
  tools_json      TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  contact_allow_json TEXT NOT NULL DEFAULT '[]',    -- 可联系对象 agent id
  can_dispatch    INTEGER NOT NULL DEFAULT 1,
  executor_json   TEXT NOT NULL DEFAULT '{}',       -- 执行器配置（model/adapter）
  is_inspector    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES department(id) ON DELETE SET NULL
);

-- ============================================================
-- Relationship（组织图 + 通信图节点边）
-- relationship 表同时表达 org 与 communication 关系，用 kind 区分。
-- workflow 用独立的 workflow_node / workflow_edge 表。
-- ============================================================
CREATE TABLE relationship (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('org','communication')),
  source_id    TEXT NOT NULL,    -- agent_definition.id（语义：节点）
  target_id    TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  protocol_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  UNIQUE (company_id, kind, source_id, target_id)
);

-- ============================================================
-- Workflow（工作流图，独立节点/边存储）
-- ============================================================
CREATE TABLE workflow_node (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  workflow_id TEXT NOT NULL,    -- 同一公司可有多张工作流，workflow_id 分组
  kind        TEXT NOT NULL DEFAULT 'step',   -- step|decision|start|end
  label       TEXT NOT NULL,
  position_json TEXT NOT NULL DEFAULT '{}',   -- React Flow {x,y}
  props_json  TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE
);

CREATE TABLE workflow_edge (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  source_id   TEXT NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  UNIQUE (workflow_id, source_id, target_id)
);

-- ============================================================
-- Project
-- ============================================================
CREATE TABLE project (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  root_dir        TEXT NOT NULL,                -- 用户项目目录绝对路径
  first_agent_id  TEXT,                          -- 负责人（默认继承公司）
  state           TEXT NOT NULL DEFAULT 'idle'
                    CHECK (state IN ('idle','active','paused','completed','archived')),
  settings_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  FOREIGN KEY (first_agent_id) REFERENCES agent_definition(id) ON DELETE SET NULL
);

-- 跨项目只读引用
CREATE TABLE project_reference (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  source_project_id TEXT NOT NULL,
  source_path  TEXT NOT NULL DEFAULT '',
  read_only    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY (source_project_id) REFERENCES project(id) ON DELETE CASCADE,
  CHECK (read_only = 1)   -- 首版只读
);

-- ============================================================
-- Project Agent Thread（员工在项目中的运行线程）
-- ============================================================
CREATE TABLE project_agent_thread (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary','mirror')),
  root_thread_id TEXT,                  -- mirror 指向其根线程；primary 为 NULL
  claude_session_id TEXT,               -- Claude Code session（Phase 3 使用）
  context_json  TEXT NOT NULL DEFAULT '{}',   -- 项目级上下文缓存
  state         TEXT NOT NULL DEFAULT 'idle'
                  CHECK (state IN ('idle','running','waiting','paused','failed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  FOREIGN KEY (root_thread_id) REFERENCES project_agent_thread(id) ON DELETE CASCADE
);

CREATE INDEX idx_thread_project_agent ON project_agent_thread(project_id, agent_id);
CREATE INDEX idx_thread_kind ON project_agent_thread(project_id, kind);

-- ============================================================
-- Task（统一运行单元）
-- ============================================================
CREATE TABLE task (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,            -- 项目内序号
  root_task_id    TEXT REFERENCES task(id) ON DELETE SET NULL,
  parent_task_id  TEXT REFERENCES task(id) ON DELETE SET NULL,
  dispatcher_agent_id TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  assignee_agent_id   TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  assignee_thread_id TEXT REFERENCES project_agent_thread(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  input_protocol_json  TEXT NOT NULL DEFAULT '{}',
  context_refs_json    TEXT NOT NULL DEFAULT '[]',
  output_protocol_json TEXT NOT NULL DEFAULT '{}',
  priority        INTEGER NOT NULL DEFAULT 5,
  -- 运行状态
  state           TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','claimed','running','waiting_input',
                                     'waiting_dependency','paused','blocked',
                                     'completed','failed','cancelled')),
  -- 租约
  lease_owner_thread_id TEXT,
  lease_expires_at TEXT,
  heartbeat_at    TEXT,
  -- 结果
  outcome         TEXT CHECK (outcome IN ('completed','waiting_input','waiting_dependency','blocked')),
  summary         TEXT NOT NULL DEFAULT '',
  question        TEXT,
  artifacts_json  TEXT NOT NULL DEFAULT '[]',
  checkpoint      TEXT,
  -- 元数据
  clarification_rounds INTEGER NOT NULL DEFAULT 0,
  is_discussion   INTEGER NOT NULL DEFAULT 0,
  budget_json     TEXT NOT NULL DEFAULT '{}',
  deadline_at     TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_task_project_seq ON task(project_id, seq);
CREATE INDEX idx_task_state ON task(project_id, state);
CREATE INDEX idx_task_assignee ON task(assignee_agent_id, state);
CREATE INDEX idx_task_lease ON task(state, lease_expires_at) WHERE state IN ('claimed','running');

-- Task 依赖关系（多对多）
CREATE TABLE task_dependency (
  task_id        TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

-- ============================================================
-- Task Event（追加事件日志）
-- ============================================================
CREATE TABLE task_event (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,    -- created|claimed|running|waiting_input|...
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_event_task ON task_event(task_id, occurred_at);

-- ============================================================
-- Task Message（Task 内讨论）
-- ============================================================
CREATE TABLE task_message (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,    -- 'user' | agent_id | 'system'
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','dispatch')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_msg_task ON task_message(task_id, created_at);

-- ============================================================
-- Trigger（事件 / 定时触发器）
-- ============================================================
CREATE TABLE trigger (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('event','schedule')),
  event_name  TEXT,             -- event 触发器的事件名
  cron_expr   TEXT,             -- schedule 触发器表达式（简化为 intervalMs）
  interval_ms INTEGER,
  template_json TEXT NOT NULL DEFAULT '{}',   -- 派发 Task 模板
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK ((kind='event' AND event_name IS NOT NULL) OR (kind='schedule' AND interval_ms IS NOT NULL))
);

-- ============================================================
-- Artifact（成果注册表）
-- ============================================================
CREATE TABLE artifact (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,    -- markdown|outline|character_sheet|timeline|...
  path            TEXT NOT NULL,    -- 相对项目根目录
  owner_agent_id  TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  merge_strategy  TEXT NOT NULL DEFAULT 'three_way' CHECK (merge_strategy IN ('three_way','exclusive_lock')),
  props_json      TEXT NOT NULL DEFAULT '{}',
  created_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (project_id, path)
);

-- ============================================================
-- Report Cycle（强制复盘）
-- ============================================================
CREATE TABLE report_cycle (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  cycle_no     INTEGER NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('time','task_count','milestone')),
  summary_json TEXT NOT NULL DEFAULT '{}',   -- 按根员工聚合的摘要
  user_notes_json TEXT NOT NULL DEFAULT '[]', -- [{seq, note}]
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','reviewing','closed')),
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  UNIQUE (project_id, cycle_no)
);

-- ============================================================
-- Usage Record（用量统计）
-- ============================================================
CREATE TABLE usage_record (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agent_definition(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL REFERENCES project_agent_thread(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  recorded_at     TEXT NOT NULL
);
CREATE INDEX idx_usage_project ON usage_record(project_id, recorded_at);
CREATE INDEX idx_usage_agent ON usage_record(agent_id, recorded_at);
CREATE INDEX idx_usage_task ON usage_record(task_id);

-- schema_migrations 表由 client.ts 在运行 migration 前创建，此处不再声明。
