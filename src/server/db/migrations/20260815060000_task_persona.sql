-- 蓝图组织重构 批次1：智能体与人设原语。
-- 任务人设：执行智能体本次穿戴的 persona（id = personas/ 相对路径），不产生任职；
-- 权限/执行器仍绑在智能体任职上，人设只是任务上下文的一部分（治理锚点不变）。
ALTER TABLE task ADD COLUMN persona_id TEXT NULL;

-- 人设键记忆：方法论类经验（反思 CRAFT 产出）挂到具体 persona 上，跨任务、跨项目复用。
-- skill scope 语义升级：persona_key IS NULL = 通用技能记忆（原语义）；persona_key = 某人设 = 该领域方法论，
-- 仅在任务穿戴该人设时注入（loadContextMemories 按 task.persona_id 过滤）。
ALTER TABLE memory_candidate ADD COLUMN persona_key TEXT NULL;
ALTER TABLE memory_entry ADD COLUMN persona_key TEXT NULL;
CREATE INDEX idx_memory_entry_persona_key ON memory_entry(persona_key);
