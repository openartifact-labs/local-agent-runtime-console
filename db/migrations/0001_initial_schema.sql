-- SQLite 最新完整结构。应用首次启动时会在事务中自动执行并记录迁移版本。
CREATE TABLE ai_provider (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  connection_status TEXT NOT NULL DEFAULT 'unknown',
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  version TEXT,
  message TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_ai_provider_kind ON ai_provider(kind);
CREATE INDEX idx_ai_provider_status ON ai_provider(connection_status);

CREATE TABLE ai_runtime_task (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES ai_provider(id),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  cwd TEXT,
  model TEXT,
  source TEXT NOT NULL CHECK (source IN ('discovered', 'managed')),
  relation_type TEXT CHECK (relation_type IS NULL OR relation_type = 'subtask'),
  parent_external_id TEXT,
  relation_depth INTEGER CHECK (relation_depth IS NULL OR relation_depth >= 0),
  agent_name TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT,
  last_synced_at TEXT NOT NULL,
  UNIQUE (provider_id, external_id)
) STRICT;

CREATE INDEX idx_ai_task_status_activity ON ai_runtime_task(status, last_activity_at);
CREATE INDEX idx_ai_task_source_activity ON ai_runtime_task(source, last_activity_at);
CREATE INDEX idx_ai_task_parent ON ai_runtime_task(provider_id, parent_external_id);

CREATE TABLE ai_runtime_run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES ai_runtime_task(id) ON DELETE CASCADE,
  external_id TEXT,
  status TEXT NOT NULL,
  prompt TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_output_tokens INTEGER CHECK (reasoning_output_tokens IS NULL OR reasoning_output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, external_id)
) STRICT;

CREATE INDEX idx_ai_run_task_started ON ai_runtime_run(task_id, started_at);
CREATE INDEX idx_ai_run_status_started ON ai_runtime_run(status, started_at);

CREATE TABLE ai_runtime_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES ai_runtime_run(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES ai_runtime_task(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES ai_provider(id),
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_ai_event_run_time ON ai_runtime_event(run_id, occurred_at);
CREATE INDEX idx_ai_event_task_time ON ai_runtime_event(task_id, occurred_at);
CREATE INDEX idx_ai_event_type_time ON ai_runtime_event(event_type, occurred_at);

CREATE TABLE ai_runtime_output_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_uuid TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES ai_runtime_run(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES ai_runtime_task(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'text')),
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_ai_snapshot_run_time ON ai_runtime_output_snapshot(run_id, created_at);
CREATE INDEX idx_ai_snapshot_task_time ON ai_runtime_output_snapshot(task_id, created_at);
