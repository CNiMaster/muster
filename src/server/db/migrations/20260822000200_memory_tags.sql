-- 经验库（X1）：归因 + 标签——memory_candidate/memory_entry 各加两列。
-- cause：受控词表 model|method|context|tool（NULL=未归因，旧数据兼容）；
-- tags_json：自由标签数组（反思写入时建议，小写归一化，cap 5）。
-- push 路径（loadContextMemories）不消费这两列——标签只服务 pull 检索（searchMemory tag/cause 过滤）。
ALTER TABLE memory_candidate ADD COLUMN cause TEXT;
ALTER TABLE memory_candidate ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_entry ADD COLUMN cause TEXT;
ALTER TABLE memory_entry ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
