-- 能力探针结果存储（设计一：API 能力矩阵）
-- 给 connection_probe 增加 capability_json：API 型执行器的能力矩阵探针结果
-- （function calling / 工具循环 / 结构化输出 / 指令遵循等级 / 支持与不支持的任务类别）
ALTER TABLE connection_probe ADD COLUMN capability_json TEXT;
