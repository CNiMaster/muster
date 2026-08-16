-- 批次 D1：对话消息附件（引用素材区上传文件）。
ALTER TABLE conversation_message ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
