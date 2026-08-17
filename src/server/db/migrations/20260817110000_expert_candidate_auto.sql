-- WP3 改版（2026-08-17）：自建专家免人工确认——信号命中即自动入库，候选表转为「沉淀历史」。
-- persona_id 记录该次沉淀生成的人设 id（user/ 前缀），供溯源与列表跳转。
ALTER TABLE expert_candidate ADD COLUMN persona_id TEXT;
