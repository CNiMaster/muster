-- 蓝图打法包批次1：进化环收拢——晨醒每日定时退役、晋升链与旧运营报告数据面删除。
-- 任务末反思(10s排水)保留并成为唯一进化频率；蓝图状态(active/locked/retired)自带治理。
DROP TABLE IF EXISTS company_optimization_report;
DROP TABLE IF EXISTS report_action_item;
DROP TABLE IF EXISTS promotion_candidate;
DROP TABLE IF EXISTS structure_change_log;
DROP TABLE IF EXISTS entity_lock;
