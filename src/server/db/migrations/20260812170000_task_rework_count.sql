-- E1.4 task 返工次数一等字段。
-- 让一次通过率可直接 SQL 查询（rework_count=0 的完成 task / 总完成 task），
-- 并让员工评级能纳入质量维度。返工在 business-review changes_requested/rejected 派返工 Task 时递增。
ALTER TABLE task ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0;
