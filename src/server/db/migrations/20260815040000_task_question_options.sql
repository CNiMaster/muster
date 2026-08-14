-- 指挥系统批次3：追问的结构化选项（agent 给用户的 A/B/C 多选一）。
ALTER TABLE task ADD COLUMN question_options_json TEXT;
