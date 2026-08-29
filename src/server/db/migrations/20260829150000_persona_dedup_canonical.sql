-- 蓝图工作流化批次 A1（2026-08-29）：人设库去重——8 组跨域孪生归一到域目录正身
-- （frontend/backend/devops/security），personas/engineering/ 侧孪生文件已删（MD5 与正身逐字节相同，零内容损失）。
-- 数据级幂等迁移（纯 UPDATE+REPLACE，天然可重放）：所有存 persona id 的列做串替换；JSON 列替换带引号整串。
-- 实况基线：live 库仅 agent_profile 有 5 行用户人才（已在正身侧，本迁移防御性覆盖）；
-- blueprint 存量播种行含旧 id 是关键修复面——不迁则软件交付/数据分析/网站开发/CI-CD 四套蓝图
-- 对应班底槽变死人设（getPersona=null → 穿戴跳过/复制断链）。其余列当前为空，防御性覆盖。
-- 替换顺序安全性：8 个旧 id 互不为彼此子串（含带引号形态，闭引号定界）。

-- blueprint：存量播种行的班底 + 原版快照（快照不迁则「重置为原版」会复活死 id）
UPDATE blueprint SET staffing_json = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  staffing_json,
  '"engineering/engineering-frontend-developer"', '"frontend/engineering-frontend-developer"'),
  '"engineering/engineering-mobile-app-builder"', '"frontend/engineering-mobile-app-builder"'),
  '"engineering/engineering-backend-architect"', '"backend/engineering-backend-architect"'),
  '"engineering/engineering-data-engineer"', '"backend/engineering-data-engineer"'),
  '"engineering/engineering-database-optimizer"', '"backend/engineering-database-optimizer"'),
  '"engineering/engineering-devops-automator"', '"devops/engineering-devops-automator"'),
  '"engineering/engineering-sre"', '"devops/engineering-sre"'),
  '"engineering/engineering-security-engineer"', '"security/engineering-security-engineer"');
UPDATE blueprint SET preset_snapshot_json = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  preset_snapshot_json,
  '"engineering/engineering-frontend-developer"', '"frontend/engineering-frontend-developer"'),
  '"engineering/engineering-mobile-app-builder"', '"frontend/engineering-mobile-app-builder"'),
  '"engineering/engineering-backend-architect"', '"backend/engineering-backend-architect"'),
  '"engineering/engineering-data-engineer"', '"backend/engineering-data-engineer"'),
  '"engineering/engineering-database-optimizer"', '"backend/engineering-database-optimizer"'),
  '"engineering/engineering-devops-automator"', '"devops/engineering-devops-automator"'),
  '"engineering/engineering-sre"', '"devops/engineering-sre"'),
  '"engineering/engineering-security-engineer"', '"security/engineering-security-engineer"');

-- task_stage_run：阶段绑定的参与人 id（JSON 数组）
UPDATE task_stage_run SET staffing_persona_ids_json = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  staffing_persona_ids_json,
  '"engineering/engineering-frontend-developer"', '"frontend/engineering-frontend-developer"'),
  '"engineering/engineering-mobile-app-builder"', '"frontend/engineering-mobile-app-builder"'),
  '"engineering/engineering-backend-architect"', '"backend/engineering-backend-architect"'),
  '"engineering/engineering-data-engineer"', '"backend/engineering-data-engineer"'),
  '"engineering/engineering-database-optimizer"', '"backend/engineering-database-optimizer"'),
  '"engineering/engineering-devops-automator"', '"devops/engineering-devops-automator"'),
  '"engineering/engineering-sre"', '"devops/engineering-sre"'),
  '"engineering/engineering-security-engineer"', '"security/engineering-security-engineer"');

-- agent_profile：用户人才的源人设绑定（裸 id）+ 能力快照内嵌 personaId（带引号）
UPDATE agent_profile SET source_persona_id = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  source_persona_id,
  'engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'),
  'engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'),
  'engineering/engineering-backend-architect', 'backend/engineering-backend-architect'),
  'engineering/engineering-data-engineer', 'backend/engineering-data-engineer'),
  'engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'),
  'engineering/engineering-devops-automator', 'devops/engineering-devops-automator'),
  'engineering/engineering-sre', 'devops/engineering-sre'),
  'engineering/engineering-security-engineer', 'security/engineering-security-engineer');
UPDATE agent_profile SET capabilities_json = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  capabilities_json,
  '"engineering/engineering-frontend-developer"', '"frontend/engineering-frontend-developer"'),
  '"engineering/engineering-mobile-app-builder"', '"frontend/engineering-mobile-app-builder"'),
  '"engineering/engineering-backend-architect"', '"backend/engineering-backend-architect"'),
  '"engineering/engineering-data-engineer"', '"backend/engineering-data-engineer"'),
  '"engineering/engineering-database-optimizer"', '"backend/engineering-database-optimizer"'),
  '"engineering/engineering-devops-automator"', '"devops/engineering-devops-automator"'),
  '"engineering/engineering-sre"', '"devops/engineering-sre"'),
  '"engineering/engineering-security-engineer"', '"security/engineering-security-engineer"');
-- capabilities_json 内嵌 domain 键随归一修正（按改名后的 id 精确圈定，不误伤真 engineering 人设行）
UPDATE agent_profile SET capabilities_json = REPLACE(capabilities_json, '"domain":"engineering"', '"domain":"frontend"')
  WHERE source_persona_id IN ('frontend/engineering-frontend-developer', 'frontend/engineering-mobile-app-builder');
UPDATE agent_profile SET capabilities_json = REPLACE(capabilities_json, '"domain":"engineering"', '"domain":"backend"')
  WHERE source_persona_id IN ('backend/engineering-backend-architect', 'backend/engineering-data-engineer', 'backend/engineering-database-optimizer');
UPDATE agent_profile SET capabilities_json = REPLACE(capabilities_json, '"domain":"engineering"', '"domain":"devops"')
  WHERE source_persona_id IN ('devops/engineering-devops-automator', 'devops/engineering-sre');
UPDATE agent_profile SET capabilities_json = REPLACE(capabilities_json, '"domain":"engineering"', '"domain":"security"')
  WHERE source_persona_id = 'security/engineering-security-engineer';

-- 裸 id 列防御性覆盖（当前各表为空；统一口径防历史/外部导入残留）
UPDATE task SET persona_id = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  persona_id,
  'engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'),
  'engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'),
  'engineering/engineering-backend-architect', 'backend/engineering-backend-architect'),
  'engineering/engineering-data-engineer', 'backend/engineering-data-engineer'),
  'engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'),
  'engineering/engineering-devops-automator', 'devops/engineering-devops-automator'),
  'engineering/engineering-sre', 'devops/engineering-sre'),
  'engineering/engineering-security-engineer', 'security/engineering-security-engineer')
  WHERE persona_id LIKE 'engineering/engineering-%';
UPDATE specialist_pool SET persona_id = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  persona_id,
  'engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'),
  'engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'),
  'engineering/engineering-backend-architect', 'backend/engineering-backend-architect'),
  'engineering/engineering-data-engineer', 'backend/engineering-data-engineer'),
  'engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'),
  'engineering/engineering-devops-automator', 'devops/engineering-devops-automator'),
  'engineering/engineering-sre', 'devops/engineering-sre'),
  'engineering/engineering-security-engineer', 'security/engineering-security-engineer')
  WHERE persona_id LIKE 'engineering/engineering-%';
UPDATE task_closeout_summary SET persona_id = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  persona_id,
  'engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'),
  'engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'),
  'engineering/engineering-backend-architect', 'backend/engineering-backend-architect'),
  'engineering/engineering-data-engineer', 'backend/engineering-data-engineer'),
  'engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'),
  'engineering/engineering-devops-automator', 'devops/engineering-devops-automator'),
  'engineering/engineering-sre', 'devops/engineering-sre'),
  'engineering/engineering-security-engineer', 'security/engineering-security-engineer')
  WHERE persona_id LIKE 'engineering/engineering-%';
-- expert_candidate 曾于 20260824110000 重建（v2 结构，建新搬数后改名回 expert_candidate）——表名不变
UPDATE expert_candidate SET persona_id = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  persona_id,
  'engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'),
  'engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'),
  'engineering/engineering-backend-architect', 'backend/engineering-backend-architect'),
  'engineering/engineering-data-engineer', 'backend/engineering-data-engineer'),
  'engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'),
  'engineering/engineering-devops-automator', 'devops/engineering-devops-automator'),
  'engineering/engineering-sre', 'devops/engineering-sre'),
  'engineering/engineering-security-engineer', 'security/engineering-security-engineer')
  WHERE persona_id LIKE 'engineering/engineering-%';
UPDATE memory_entry SET persona_key = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  persona_key,
  'engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'),
  'engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'),
  'engineering/engineering-backend-architect', 'backend/engineering-backend-architect'),
  'engineering/engineering-data-engineer', 'backend/engineering-data-engineer'),
  'engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'),
  'engineering/engineering-devops-automator', 'devops/engineering-devops-automator'),
  'engineering/engineering-sre', 'devops/engineering-sre'),
  'engineering/engineering-security-engineer', 'security/engineering-security-engineer')
  WHERE persona_key LIKE 'engineering/engineering-%';
UPDATE memory_candidate SET persona_key = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  persona_key,
  'engineering/engineering-frontend-developer', 'frontend/engineering-frontend-developer'),
  'engineering/engineering-mobile-app-builder', 'frontend/engineering-mobile-app-builder'),
  'engineering/engineering-backend-architect', 'backend/engineering-backend-architect'),
  'engineering/engineering-data-engineer', 'backend/engineering-data-engineer'),
  'engineering/engineering-database-optimizer', 'backend/engineering-database-optimizer'),
  'engineering/engineering-devops-automator', 'devops/engineering-devops-automator'),
  'engineering/engineering-sre', 'devops/engineering-sre'),
  'engineering/engineering-security-engineer', 'security/engineering-security-engineer')
  WHERE persona_key LIKE 'engineering/engineering-%';
