-- 批次 D2：消息级执行选项（模式/模型/思考等级），随消息落库、随 Task inputProtocol 下发。
ALTER TABLE conversation_message ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';
