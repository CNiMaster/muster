-- 批次 A：临时工模型 + 员工评级。
-- 设计见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md。
--
-- 「公司」是软件内的本地组织概念。临时工是 B2B 外包决策树 recruit 路径的落地：
-- 自动从人才市场找/新建 → 完成工作后灰色保留（不启用）→ 人工决定转正或开除。
--
-- 临时工两种来源决定开除处理：
--   is_temp_only=0（人才市场来的人）：开除只删任职，profile + Agent Home 保留
--   is_temp_only=1（临时新建的、未转正）：开除连 profile + Agent Home 一起删，不进人才市场

-- company_employee 加临时工字段
ALTER TABLE company_employee ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'permanent'
  CHECK (employment_type IN ('permanent', 'temp'));
ALTER TABLE company_employee ADD COLUMN temp_status TEXT
  CHECK (temp_status IS NULL OR (employment_type = 'temp' AND temp_status IN ('active', 'greyed', 'dismissed')));
ALTER TABLE company_employee ADD COLUMN contracted_at TEXT;
ALTER TABLE company_employee ADD COLUMN source_contract_id TEXT REFERENCES outsourcing_contract(id) ON DELETE SET NULL;

-- 部分索引：快速查询某公司的临时工（greyed 待定者优先展示）
CREATE INDEX IF NOT EXISTS idx_company_employee_temp
  ON company_employee(company_id, employment_type, temp_status)
  WHERE employment_type = 'temp';

-- agent_profile 加评级 + 临时标记
-- is_temp_only=1：临时新建、未转正，人才市场列表过滤掉；转正时清零
-- rating：1-5 星，反映经验丰富度（任务完成/记忆/任职/外包验收加权）
ALTER TABLE agent_profile ADD COLUMN is_temp_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_profile ADD COLUMN rating INTEGER NOT NULL DEFAULT 1 CHECK (rating BETWEEN 1 AND 5);
