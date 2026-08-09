-- 批次 C：离职交接工作流。
-- 设计见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第四节。
--
-- 按人整体交接（跨所有项目）：工作履历、经验教训、进行中工作、待办、注意事项。
-- 四阶段：drafting（整理）→ awaiting（选接手人）→ receiving（接收确认）→ completed（离职生效）。
-- 产物 owner 指针单一更新（不叠加），交接记录链表可追溯。
CREATE TABLE IF NOT EXISTS handover_record (
  id                          TEXT PRIMARY KEY,
  company_id                  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  departing_employee_id       TEXT NOT NULL,             -- 离职员工 agent_definition.id（离职后可能不存在）
  departing_profile_id        TEXT NOT NULL,             -- 离职员工 profile（永恒，用于追溯）
  receiver_employee_id        TEXT,                      -- 接手员工（awaiting 后填）
  previous_handover_id        TEXT REFERENCES handover_record(id) ON DELETE SET NULL, -- 连环交接链
  state                       TEXT NOT NULL DEFAULT 'drafting'
                                CHECK (state IN ('drafting','awaiting','receiving','completed','cancelled')),
  handover_note               TEXT,                       -- 交接记录（工作履历+经验+进行中工作+注意事项）
  work_history_json           TEXT NOT NULL DEFAULT '[]', -- [{projectId, role, period, summary}]
  lessons_json                TEXT NOT NULL DEFAULT '[]', -- 经验教训（从记忆导出）
  pending_work_json           TEXT NOT NULL DEFAULT '[]', -- 进行中的工作 + 待办
  artifact_inventory_json     TEXT NOT NULL DEFAULT '[]', -- 产物清单（按项目分组 [{projectId, items:[{path, note, transferred}]}]）
  receiver_acknowledgement    TEXT,                       -- 接手人确认记录
  created_at                  TEXT NOT NULL,
  completed_at                TEXT,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handover_company ON handover_record(company_id, state);
CREATE INDEX IF NOT EXISTS idx_handover_departing ON handover_record(departing_profile_id);
CREATE INDEX IF NOT EXISTS idx_handover_receiver ON handover_record(receiver_employee_id, state);
