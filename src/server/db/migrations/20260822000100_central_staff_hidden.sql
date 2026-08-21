-- B5 中央六岗隐形化：一个人就是一个公司——用户只对负责人说话。
-- 存量翻面：人事/养蜂人/验收员（此前可见固定岗）翻 hidden；裁决庭/能力管理本就隐形（懒确保建即 hidden）。
-- 分区标记：五隐形中央岗 visible_in='central'（@ 下拉/群聊经 GET /api/agents?visible_in=central 取数）。
-- 负责人保持可见（用户唯一对话入口）；老库 visible_in 缺失由 ensureOne 幂等自愈补上。
UPDATE company_employee SET hidden=1
WHERE legacy_agent_id IN (
  SELECT id FROM agent_definition WHERE role IN ('swarm-dispatcher', 'hr', 'acceptance-officer')
);

UPDATE agent_definition SET visible_in='central'
WHERE role IN ('swarm-dispatcher', 'hr', 'acceptance-officer', 'debate-judge', 'capability-manager')
  AND (visible_in IS NULL OR visible_in = '');
