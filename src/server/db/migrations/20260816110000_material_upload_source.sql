-- safety: rebuild
-- 批次 D1：素材来源增加 upload（对话附件上传入库）。
-- SQLite 不支持直接改 CHECK：重建表并迁移数据（未上线，无需保序）。
CREATE TABLE project_material_new (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  source_type     TEXT NOT NULL CHECK (source_type IN ('link', 'moved', 'copied', 'upload')),
  storage_path    TEXT,
  source_url      TEXT,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  meta_json       TEXT NOT NULL DEFAULT '{}',
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
INSERT INTO project_material_new SELECT id, project_id, name, kind, source_type, storage_path, source_url, tags_json, meta_json, created_by, created_at, updated_at FROM project_material;
DROP TABLE project_material;
ALTER TABLE project_material_new RENAME TO project_material;
