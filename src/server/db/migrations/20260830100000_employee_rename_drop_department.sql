-- safety: rebuild
-- 公司退役批次 D 收尾：company_employee 改名 employee（公司概念 2026-08-16 退场，表名是最后一块活化石；
-- 域文件早已是 employee-rating.ts / employee-runtime.ts）。同时清除部门死链：department 表（0 行）
-- 与 company_employee / agent_definition 两表上的 department_id 死列（部门概念随公司下线）。
-- 基准为主库现状 schema（勿照抄 0001 原始建表——company_id 等列已在先行批次 DROP）。
-- FK 按表名引用，runner 事务内 foreign_keys=OFF 下重建安全；无视图/触发器引用本批表。

-- 1) agent_definition 去 department_id 死列（其余列与现状 schema 逐列对齐）
CREATE TABLE agent_definition_new (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  responsibilities TEXT NOT NULL DEFAULT '',
  system_prompt   TEXT NOT NULL DEFAULT '',
  skills_json     TEXT NOT NULL DEFAULT '[]',
  tools_json      TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  contact_allow_json TEXT NOT NULL DEFAULT '[]',
  can_dispatch    INTEGER NOT NULL DEFAULT 1,
  executor_json   TEXT NOT NULL DEFAULT '{}',
  is_inspector    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  availability_state TEXT NOT NULL DEFAULT 'online'
                    CHECK (availability_state IN ('online','draining','off')),
  stance TEXT NOT NULL DEFAULT '',
  profile_id TEXT REFERENCES agent_profile(id),
  is_system INTEGER NOT NULL DEFAULT 0, visible_in TEXT
);

INSERT INTO agent_definition_new (id, name, role, responsibilities, system_prompt, skills_json, tools_json,
                                  permissions_json, contact_allow_json, can_dispatch, executor_json, is_inspector,
                                  created_at, updated_at, availability_state, stance, profile_id, is_system, visible_in)
  SELECT id, name, role, responsibilities, system_prompt, skills_json, tools_json,
         permissions_json, contact_allow_json, can_dispatch, executor_json, is_inspector,
         created_at, updated_at, availability_state, stance, profile_id, is_system, visible_in
  FROM agent_definition;

DROP TABLE agent_definition;
ALTER TABLE agent_definition_new RENAME TO agent_definition;

-- 2) company_employee → employee（去 department_id 死列与 department 外键，其余逐列对齐现状）
CREATE TABLE employee_new (
  id                   TEXT PRIMARY KEY,
  profile_id           TEXT NOT NULL,
  legacy_agent_id      TEXT NOT NULL UNIQUE,
  role                 TEXT NOT NULL,
  responsibilities     TEXT NOT NULL DEFAULT '',
  executor_json        TEXT NOT NULL DEFAULT '{}',
  permission_json      TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  executor_profile_id  TEXT REFERENCES executor_profile(id),
  permission_policy_id TEXT REFERENCES permission_policy(id),
  employment_type      TEXT NOT NULL DEFAULT 'permanent'
                         CHECK (employment_type IN ('permanent', 'temp')),
  temp_status          TEXT
                         CHECK (temp_status IS NULL OR (employment_type = 'temp' AND temp_status IN ('active', 'greyed', 'dismissed'))),
  contracted_at        TEXT,
  source_contract_id   TEXT,
  hidden               INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE RESTRICT,
  FOREIGN KEY (legacy_agent_id) REFERENCES agent_definition(id) ON DELETE CASCADE
);

INSERT INTO employee_new (id, profile_id, legacy_agent_id, role, responsibilities, executor_json, permission_json,
                          created_at, updated_at, executor_profile_id, permission_policy_id, employment_type,
                          temp_status, contracted_at, source_contract_id, hidden)
  SELECT id, profile_id, legacy_agent_id, role, responsibilities, executor_json, permission_json,
         created_at, updated_at, executor_profile_id, permission_policy_id, employment_type,
         temp_status, contracted_at, source_contract_id, hidden
  FROM company_employee;

DROP TABLE company_employee;
ALTER TABLE employee_new RENAME TO employee;

CREATE INDEX idx_employee_created ON employee(created_at);

-- 3) 部门死表（0 行，概念随公司下线）
DROP TABLE department;
