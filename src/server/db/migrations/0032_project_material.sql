-- ============================================================
-- 项目素材区(原料/需求/源文件存储)
-- 三选一导入:link(引用不复制)/ moved(移入删源)/ copied(复制留源)
-- ============================================================
CREATE TABLE IF NOT EXISTS project_material (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,              -- video|audio|image|document|link|other
  source_type     TEXT NOT NULL CHECK (source_type IN ('link', 'moved', 'copied')),
  storage_path    TEXT,                       -- moved/copied 时相对项目根的路径;link 时 NULL
  source_url      TEXT,                       -- link 型的 URL;或原始来源记录
  tags_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  meta_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),  -- 文件大小/时长/分辨率等
  created_by      TEXT,                       -- agent_id | 'user'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_material_project ON project_material(project_id);
CREATE INDEX IF NOT EXISTS idx_project_material_kind ON project_material(project_id, kind);
