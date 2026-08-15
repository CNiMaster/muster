-- 蓝图组织重构收尾：公司模板平台退场（组织 = f(活)，岗位由任务穿戴人设动态生成）。
-- 保留 capability_binding（通用能力绑定，resolveTaskSkills 注入链消费）。
-- 产品未上线，无需数据兼容。
DROP TABLE IF EXISTS company_template_installation;
DROP TABLE IF EXISTS template_version;
DROP TABLE IF EXISTS template_definition;
DROP TABLE IF EXISTS template_health_finding;
