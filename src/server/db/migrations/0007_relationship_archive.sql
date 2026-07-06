-- 关系图软删除：归档（PRD:351-359）。
-- 历史组织关系保留为归档态，前端以灰色虚线展示，可恢复。
-- ON DELETE CASCADE 之外，归档不会触发 FK 删除。
ALTER TABLE relationship ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_relationship_archived ON relationship(archived_at);
