-- 讨论室（设计二-方案B）：项目级多员工异步串行探讨，结论压缩回项目。
-- discussion：讨论室主表（topic/participants/state/minutes/conclusion）
-- discussion_participant：参与者（含 moderator 角色）
-- discussion_turn：发言记录（每次发言 = 一个 task）

CREATE TABLE discussion (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  initiator_agent_id TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','concluding','concluded','closed')),
  -- 发言轮转：当前轮到谁（agent_id），null=待启动或已结束
  current_speaker_agent_id TEXT,
  -- 当前轮次对应的 task_id（发言任务）
  current_turn_task_id TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL DEFAULT 12,
  -- 讨论目标/背景，注入给每个发言者
  context_json TEXT NOT NULL DEFAULT '{}',
  -- conclude 时写入的纪要（人话总结）
  minutes TEXT,
  -- 结论要点 + 落地方式（JSON：{ keyPoints:[], actions:[], artifacts:[] }）
  conclusion_json TEXT,
  source_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE discussion_participant (
  discussion_id TEXT NOT NULL REFERENCES discussion(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator')),
  turn_index INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (discussion_id, agent_id)
);

CREATE TABLE discussion_turn (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussion(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  speaker_agent_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_discussion_project ON discussion(project_id, state);
CREATE INDEX idx_discussion_participant ON discussion_participant(discussion_id);
CREATE INDEX idx_discussion_turn ON discussion_turn(discussion_id, turn_index);
