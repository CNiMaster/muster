CREATE TABLE agent_profile_base (
  profile_id    TEXT PRIMARY KEY,
  version       INTEGER NOT NULL DEFAULT 1,
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE
);

INSERT INTO agent_profile_base (profile_id, version, snapshot_json, created_at)
SELECT id, base_version, json_object(
  'displayName', display_name,
  'soul', soul,
  'principles', json(principles_json),
  'capabilities', json(capabilities_json),
  'recommendedExecutor', json(recommended_executor_json),
  'recommendedPermission', json(recommended_permission_json)
), created_at
FROM agent_profile;
