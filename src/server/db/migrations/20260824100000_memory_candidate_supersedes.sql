-- 记忆更新闭环（对标学习循环"更新"环节）：候选可声明替代某条已有记忆。
-- 审批通过时：旧条目 state='superseded'（此前为死码状态，本次激活）+ 清 FTS；
-- 新条目继承旧条目的 hit_count/vote_count/adv_sum（战绩延续，避免老而准的记忆被替代后从零冷启动）。
-- 生产方：反思管道（LLM 在已有相关经验清单中识别出"新经验是对旧记忆的修正"时引用旧 entry id）；
-- 亦服务于个人偏好合并提案（多对一替代，P0-③）。目标不合法时静默降级为普通候选（LLM 幻觉 id 不阻断）。
ALTER TABLE memory_candidate ADD COLUMN supersedes_entry_id TEXT NULL;
