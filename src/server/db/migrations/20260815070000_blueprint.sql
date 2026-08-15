-- 蓝图组织重构 批次3：蓝图（从使用中学出来的组织形状）。
-- 蓝图 = 任务类型 × 人设组合 × 战绩。自动复盘进化（反思队列消化后记账/聚类），
-- 用户零手动固化；蓝图库可见/可锁/可淘汰（locked=冻结不被自动淘汰仍可匹配，retired=退出现役不再匹配）。
-- task_type 为确定性词元集合键（taskTypeOf：任务标题词元排序去重后拼接），匹配按 Jaccard 相似度。
CREATE TABLE blueprint (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  task_type   TEXT NOT NULL,
  label       TEXT NOT NULL,
  staffing_json TEXT NOT NULL DEFAULT '[]',
  source_project_ids_json TEXT NOT NULL DEFAULT '[]',
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','retired')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (company_id, task_type)
);

CREATE INDEX idx_blueprint_company ON blueprint(company_id);
CREATE INDEX idx_blueprint_status ON blueprint(status);
