-- E2 review 修复：memory_entry fingerprint 部分索引，避免 detectPromotions 全表 GROUP BY 扫描。
-- 部分索引（WHERE state='active'）与 detectPromotions 的过滤条件一致，只索引活跃记忆。
CREATE INDEX IF NOT EXISTS idx_memory_entry_fingerprint
  ON memory_entry(fingerprint)
  WHERE state = 'active';
