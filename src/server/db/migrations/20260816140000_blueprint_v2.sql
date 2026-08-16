-- 蓝图打法包一期：用户语言描述 + 工具记账 + 多维战绩(返工/纠正) + 阶段工作流预留 + 版本化快照链。
ALTER TABLE blueprint ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE blueprint ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE blueprint ADD COLUMN rework_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blueprint ADD COLUMN correction_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blueprint ADD COLUMN stages_json TEXT;

CREATE TABLE blueprint_version (
  id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES blueprint(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (blueprint_id, version)
);
CREATE INDEX idx_blueprint_version_bp ON blueprint_version(blueprint_id, version DESC);
