-- 指挥系统批次2 W0：系统隐形岗基建。
-- agent_definition.is_system：调度中心/评审中心等系统岗（自动创建、用户不可控）。
-- company_employee.hidden：隐藏任职（系统岗 + 蜂群临时工蜂共用）——
--   花名册/能力路由/组织图默认过滤，但 claimNextTask 不受影响（隐藏 ≠ 不可领取）。
ALTER TABLE agent_definition ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company_employee ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
