-- 批次 F.4：waiting_input 超时自动继续（默认一直等；全局设置 waiting_auto_continue_minutes 可开，任务级可覆盖）。
-- auto_continue_minutes：NULL=跟随全局设置；0=本任务一直等；>0=本任务 N 分钟后自动继续。
-- auto_continue_stopped：用户交互（显式停止计时/答复）后置 1——本轮等待不再自动继续；再进 waiting_input 时重置 0。
ALTER TABLE task ADD COLUMN auto_continue_minutes INTEGER NULL;
ALTER TABLE task ADD COLUMN auto_continue_stopped INTEGER NOT NULL DEFAULT 0;
