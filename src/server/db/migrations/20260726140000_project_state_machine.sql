-- safety: rebuild
-- B2 项目准备流程：扩展 project.state 状态机。
-- 新增 drafting/researching/equipping/staffing/ready 五个准备阶段，
-- 废弃 idle（保留为合法值以兼容历史数据，不再用于新项目）。
-- 设计见 docs/superpowers/specs/2026-07-26-capability-platform-design.md C.1。
--
-- SQLite 不支持 ALTER CHECK，需重建表。project 被 10+ 张表外键引用，
-- 用 PRAGMA foreign_keys=OFF 包裹 DROP+RENAME，避免外键检查失败。
-- 重建后恢复 foreign_keys=ON，外键关系由子表定义保持（不变）。
PRAGMA foreign_keys = OFF;

CREATE TABLE project_new (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  root_dir        TEXT NOT NULL,
  first_agent_id  TEXT,
  state           TEXT NOT NULL DEFAULT 'drafting'
                    CHECK (state IN ('idle','drafting','researching','equipping','staffing','ready','active','paused','completed','archived')),
  settings_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  FOREIGN KEY (first_agent_id) REFERENCES agent_definition(id) ON DELETE SET NULL
);

INSERT INTO project_new (id, company_id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at)
SELECT id, company_id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at FROM project;

DROP TABLE project;
ALTER TABLE project_new RENAME TO project;

PRAGMA foreign_keys = ON;
