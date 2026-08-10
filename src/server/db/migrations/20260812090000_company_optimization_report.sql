-- 公司运营优化报告（阶段五任务 5.1）：
-- 定期为公司生成简洁的组织/人员/运营优化建议，用户一键审批后自动执行。
CREATE TABLE IF NOT EXISTS company_optimization_report (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company(id),
  period_start TEXT,
  period_end TEXT,
  report_json TEXT NOT NULL,          -- { summary, stats, actionItems[] }
  status TEXT NOT NULL DEFAULT 'generated',  -- generated / approved / rejected / dismissed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opt_report_company ON company_optimization_report(company_id, created_at DESC);

-- 报告中的单条可执行建议（用户逐条/一键审批后自动执行）
CREATE TABLE IF NOT EXISTS report_action_item (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES company_optimization_report(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,   -- add_employee/adjust_employee/adjust_executor/expand_mirror/adjust_workflow/remove_employee/adjust_permission/prompt_optimization
  description TEXT NOT NULL,
  reason TEXT,
  expected_effect TEXT,
  params_json TEXT,            -- 执行参数（如 add_employee 的 personaId、adjust_executor 的 executorProfileId）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected / executed / failed / pending_offline
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opt_item_report ON report_action_item(report_id);
