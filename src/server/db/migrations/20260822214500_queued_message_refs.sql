-- 批次H 评审修复 C2：排队消息透传 @引用（refs 带类型前缀 token，与 conversation_message 直达链路同语义）。
ALTER TABLE queued_message ADD COLUMN refs_json TEXT NOT NULL DEFAULT '[]';
