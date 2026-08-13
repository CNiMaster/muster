-- E3 review 修复：promotion_candidate 加 profile_id（多数 entry 的 profile 归属），
-- 供需要 profileId 的 action（update_user_preference）定位目标。
ALTER TABLE promotion_candidate ADD COLUMN profile_id TEXT;
