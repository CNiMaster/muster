-- Agent 立场/视角字段（stance）。
-- 用于讨论/辩论场景中锁定 Agent 的立场，防止盲目跟风。
-- 空 = 不注入（默认）。非空时在 system prompt 的 "# 你的立场" 部分注入。
ALTER TABLE agent_definition ADD COLUMN stance TEXT NOT NULL DEFAULT '';
