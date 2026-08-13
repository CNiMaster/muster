-- E3.2 promotion_candidate 加 company_id：让候选可挂到具体公司的 optimization-report。
-- detectPromotions 按指纹聚合时取该指纹下多数 entry 的 company_id 填入；
-- personal scope（跨公司画像）的 entry company_id 为 NULL，其产生的候选 company_id 也为 NULL，
-- 不进入按公司的 report 衔接（跨公司偏好另议）。
ALTER TABLE promotion_candidate ADD COLUMN company_id TEXT;
CREATE INDEX IF NOT EXISTS idx_promotion_candidate_company ON promotion_candidate(company_id, status);
