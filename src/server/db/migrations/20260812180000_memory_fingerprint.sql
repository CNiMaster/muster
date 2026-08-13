-- E2.1 memory fingerprint：结构化 category 标签（形如 "design:color"），供晋升流聚类。
-- reflection 产 lesson/rule/preference 时由 LLM 同时产出；旧数据无标签为 NULL（向后兼容）。
ALTER TABLE memory_candidate ADD COLUMN fingerprint TEXT;
ALTER TABLE memory_entry ADD COLUMN fingerprint TEXT;
