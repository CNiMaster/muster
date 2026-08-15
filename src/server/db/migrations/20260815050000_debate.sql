-- 指挥系统批次4：对抗评审庭 + 决策记录（偏好记忆）。
-- debate：一场辩论（问题/选项/轮次输出/裁决/状态/来源任务）。
-- decision_record：用户每次选择的沉淀（source=user 是偏好信号；source=auto 是评审庭自动采纳的上下文）。
CREATE TABLE debate (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  project_id  TEXT,
  question    TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  rounds_json TEXT,
  verdict_json TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','escalated')),
  origin_task_id TEXT,
  origin_scope_kind TEXT,
  origin_scope_id TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_debate_company ON debate(company_id, created_at);
CREATE INDEX idx_debate_origin_task ON debate(origin_task_id);

CREATE TABLE decision_record (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  debate_id   TEXT,
  question    TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  chosen      TEXT NOT NULL,
  chosen_option_id TEXT,
  rationale   TEXT,
  context     TEXT,
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','auto')),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_decision_company ON decision_record(company_id, created_at);
