-- 公司退役 D4-1：凭据三级解析(平台>公司>员工)降为两级(平台>员工)。
-- 数据型迁移，不动表结构。空库/无覆盖时 no-op。
-- 1) enabled=1 且 override_key 非空的公司级覆盖，一次性覆写对应 credential_definition.credential_key；
-- 2) 清空 company_credential 数据(层已退役，行不再消费；表结构与列保留)。
UPDATE credential_definition
SET credential_key = (
  SELECT cc.override_key FROM company_credential cc
  WHERE cc.credential_definition_id = credential_definition.id
    AND cc.enabled = 1 AND cc.override_key IS NOT NULL
  LIMIT 1
)
WHERE id IN (
  SELECT DISTINCT credential_definition_id FROM company_credential
  WHERE enabled = 1 AND override_key IS NOT NULL
);

DELETE FROM company_credential;
