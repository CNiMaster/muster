-- safety: rebuild
-- review 修复（批次 D 问题 7）：knowledge_base 并发竞态——并行任务装配同时 ensureProjectBase
-- （SELECT 空 → 双双 INSERT）会建出两个项目库。加部分唯一索引（每项目至多一个 project 库）
-- 从约束层封死；ensure 侧配合 INSERT OR IGNORE 后重读。存量若有重复行，保留最早一行。
DELETE FROM knowledge_base WHERE scope_level='project' AND id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
    FROM knowledge_base WHERE scope_level='project'
  ) WHERE rn = 1
);
CREATE UNIQUE INDEX idx_knowledge_base_project_unique
  ON knowledge_base(project_id) WHERE scope_level='project';
