-- 组织模型名词统一（2026-08-19 定案，详见 CLAUDE.md「组织与名词」章）：
-- 调度中心 → 养蜂人（Beemaster，放蜂的固定岗）
-- 评审中心 → 裁决法庭（Judge，对抗辩论裁决，避免与验收员的"评审"撞词）
-- role 标识符（swarm-dispatcher / debate-judge）保持不变——DB 稳定 ID 不随显示名漂移。
UPDATE agent_definition SET name='养蜂人' WHERE role='swarm-dispatcher' AND name='调度中心';
UPDATE agent_definition SET name='裁决法庭' WHERE role='debate-judge' AND name='评审中心';
