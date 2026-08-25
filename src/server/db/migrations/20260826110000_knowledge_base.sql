-- safety: additive
-- capability parity 批次 C（spec 2026-08-25-agent-host-parity-batches）：知识库两级库。
-- 拍板结构：平台通用库（可选，用户建）+ 每项目一库（默认不建，导入时 ensure 幂等创建）。
-- 项目库可独立修改/删除，不连累其他项目。检索=词法（expandMatchTokens 词元+FTS5），
-- 向量维持不排期定案；FTS 由应用层维护（同 memory_fts 模式：删-插成对）。
CREATE TABLE knowledge_base (
  id          TEXT PRIMARY KEY,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('platform', 'project')),
  project_id  TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX idx_knowledge_base_scope ON knowledge_base(scope_level, project_id);

CREATE TABLE knowledge_doc (
  id                 TEXT PRIMARY KEY,
  base_id            TEXT NOT NULL,
  title              TEXT NOT NULL,
  format             TEXT NOT NULL CHECK (format IN ('md', 'txt', 'pdf', 'docx', 'html', 'other')),
  source_material_id TEXT,
  source_url         TEXT,
  raw_path           TEXT,
  extracted_text     TEXT NOT NULL,
  char_count         INTEGER NOT NULL DEFAULT 0,
  tags_json          TEXT NOT NULL DEFAULT '[]',
  created_by         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (base_id) REFERENCES knowledge_base(id) ON DELETE CASCADE
);
CREATE INDEX idx_knowledge_doc_base ON knowledge_doc(base_id);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  doc_id UNINDEXED,
  base_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);
