-- 双 Loop 自改进系统地基（P0）：验收标准升为 task 一等数据 + 打断信号 + 对齐轮次计数。
-- 目的：把原本只存在于前端表单自由文本（task-protocol.ts）的"验收标准"升为一等结构化数据，
-- 同时为①反思 loop 采集"打断频率"根因信号、为②任务驱动 loop 的开始段提供独立对齐轮次计量。
--
-- 设计原则（纯加法，沿用 failure_count 直接加列的仓库惯例；不动状态机、不动 CHECK 约束）：
-- - acceptance_criteria：结构化 checklist JSON（[{id,criterion,met?}]），可查询、可在验收时逐条对照。
-- - interruption_count：每次进入任意阻塞态 +1，是反思 loop 的根因探针（"中间打断多=开始没对齐"）。
-- - alignment_rounds：开始段对齐澄清轮次，独立于 clarification_rounds（执行中追问），避免语义混淆。
-- - alignment_state：对齐子状态标记（null | 'awaiting_alignment'），不污染主 10 态状态机与 wait_state。
ALTER TABLE task ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task ADD COLUMN interruption_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN alignment_rounds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN alignment_state TEXT CHECK (alignment_state IS NULL OR alignment_state = 'awaiting_alignment');
