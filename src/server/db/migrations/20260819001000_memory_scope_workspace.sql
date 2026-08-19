-- 记忆体系名词对齐（组织模型 2026-08-19）：scope 'company' 是公司时代遗留——UI 早已显示「工作台」，
-- 枚举值与语义统一为 workspace（工作台级、跟员工走、跨项目的中间层；非蓝图——蓝图是打法包另一层）。
UPDATE memory_entry SET scope='workspace' WHERE scope='company';
UPDATE memory_candidate SET scope='workspace' WHERE scope='company';
