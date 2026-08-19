-- 组织模型批次二（2026-08-19）：项目专家池 + 养蜂人转可见。
-- 专家 = 项目级常驻执行体（非固定员工）：养蜂人三种蜂优先复用、人事 staffingPlan 创建、
-- 只加不减（dismiss 仅改状态不删行）。三级阶梯：需求计数（agent_id 为空的计数行）→
-- 项目专家（project，agent_id 落位）→ 常驻专家（staff，跨项目可借）。
CREATE TABLE specialist_pool (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id    TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  persona_id  TEXT,
  specialty   TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'project',   -- project(项目专家) / staff(常驻专家)
  status      TEXT NOT NULL DEFAULT 'active',    -- active / dismissed
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_via TEXT NOT NULL DEFAULT 'swarm',     -- swarm(蜂群需求沉淀) / hr(人事创建) / manual
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_specialist_pool_lookup ON specialist_pool(project_id, persona_id, status);
CREATE INDEX idx_specialist_pool_staff ON specialist_pool(tier, status);

-- 养蜂人（role=swarm-dispatcher）从隐形转可见固定岗；裁决法庭保持隐形不动。
UPDATE company_employee SET hidden=0
WHERE hidden=1
  AND legacy_agent_id IN (SELECT id FROM agent_definition WHERE role='swarm-dispatcher' AND is_system=1);
