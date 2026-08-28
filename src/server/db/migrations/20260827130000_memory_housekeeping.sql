-- 选择闭环 S4（spec 2026-08-27-selection-loop）：记忆内务。
-- 读时脏标记：loadContextMemories 检索时顺手观察（top-k 扎堆/低影响力）打 compaction_dirty=1，
-- 当时不处理（零额外成本哨兵）；条件触发的摊销式压实只处理脏分区（攒批摊薄，O(脏分区) 而非 O(全库)）。
ALTER TABLE memory_entry ADD COLUMN compaction_dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memory_entry_dirty ON memory_entry(compaction_dirty, scope);
