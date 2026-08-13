import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseHandle } from "node:sqlite";

import type {
  ProviderDescriptor,
  RuntimeEvent,
  RuntimeOutputSnapshot,
  RuntimeRun,
  RuntimeTask,
  TaskDetail,
} from "@openartifact-labs/runtime-contracts";

import type { AppConfig } from "../config.js";
import { DatabaseUnavailableError, NotFoundError, errorMessage } from "../errors.js";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import type { RuntimeRepository } from "./runtime-repository.js";

// esbuild 尚未识别 node:sqlite，分段构造模块名可避免打包时被错误改写为 npm 包 sqlite。
const { DatabaseSync } = createRequire(import.meta.url)(["node", "sqlite"].join(":")) as typeof import("node:sqlite");

type DatabaseRow = Record<string, unknown>;
const REQUIRED_TABLES = [
  "ai_schema_migrations",
  "ai_provider",
  "ai_runtime_task",
  "ai_runtime_run",
  "ai_runtime_event",
  "ai_runtime_output_snapshot",
] as const;

const now = (): string => new Date().toISOString();
const date = (value: unknown): string | undefined => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || !value) return undefined;
  return new Date(value).toISOString();
};
const numeric = (value: unknown): number | undefined => value === null || value === undefined ? undefined : Number(value);
const sqliteDate = (value: string | undefined): string | null => value ? new Date(value).toISOString() : null;
const rows = (value: unknown): DatabaseRow[] => value as DatabaseRow[];

function mapTask(row: DatabaseRow): RuntimeTask {
  return {
    id: String(row.id),
    externalId: String(row.external_id),
    providerId: String(row.provider_id),
    title: String(row.title),
    summary: row.summary ? String(row.summary) : undefined,
    cwd: row.cwd ? String(row.cwd) : undefined,
    model: row.model ? String(row.model) : undefined,
    source: row.source === "managed" ? "managed" : "discovered",
    status: String(row.status) as RuntimeTask["status"],
    createdAt: date(row.created_at)!,
    updatedAt: date(row.updated_at)!,
    lastActivityAt: date(row.last_activity_at),
    relation: row.relation_type === "subtask" && row.parent_external_id ? {
      type: "subtask",
      parentExternalId: String(row.parent_external_id),
      parentTitle: row.parent_title ? String(row.parent_title) : undefined,
      depth: Number(row.relation_depth ?? 1),
      agentName: row.agent_name ? String(row.agent_name) : undefined,
    } : undefined,
  };
}

function mapRun(row: DatabaseRow): RuntimeRun {
  return {
    id: String(row.id),
    externalId: row.external_id ? String(row.external_id) : undefined,
    taskId: String(row.task_id),
    status: String(row.status) as RuntimeRun["status"],
    prompt: row.prompt ? String(row.prompt) : undefined,
    startedAt: date(row.started_at)!,
    completedAt: date(row.completed_at),
    durationMs: numeric(row.duration_ms),
    inputTokens: numeric(row.input_tokens),
    cachedInputTokens: numeric(row.cached_input_tokens),
    cacheWriteInputTokens: numeric(row.cache_write_input_tokens),
    outputTokens: numeric(row.output_tokens),
    reasoningOutputTokens: numeric(row.reasoning_output_tokens),
    totalTokens: numeric(row.total_tokens),
    toolCallCount: Number(row.tool_call_count ?? 0),
    errorMessage: row.error_message ? String(row.error_message) : undefined,
  };
}

function mapEvent(row: DatabaseRow): RuntimeEvent {
  return {
    id: String(row.event_uuid),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    providerId: String(row.provider_id),
    type: String(row.event_type),
    category: String(row.category) as RuntimeEvent["category"],
    level: String(row.level) as RuntimeEvent["level"],
    title: String(row.title),
    detail: row.detail ? String(row.detail) : undefined,
    durationMs: numeric(row.duration_ms),
    payload: row.payload ? JSON.parse(String(row.payload)) as Record<string, unknown> : undefined,
    occurredAt: date(row.occurred_at)!,
  };
}

function runInTransaction<T>(database: DatabaseHandle, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function applyMigrations(database: DatabaseHandle): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      executed_at TEXT NOT NULL
    ) STRICT
  `);
  const applied = new Set(
    rows(database.prepare("SELECT version FROM ai_schema_migrations").all())
      .map((row) => String(row.version)),
  );
  const insertMigration = database.prepare(
    "INSERT INTO ai_schema_migrations (version, description, executed_at) VALUES (?, ?, ?)",
  );

  for (const migration of SQLITE_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    runInTransaction(database, () => {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.description, now());
    });
  }
}

export class SqliteRuntimeRepository implements RuntimeRepository {
  private readonly database: DatabaseHandle;
  private closed = false;

  constructor(config: AppConfig["database"], database?: DatabaseHandle) {
    try {
      if (!database) mkdirSync(dirname(config.path), { recursive: true });
      this.database = database ?? new DatabaseSync(config.path);
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      applyMigrations(this.database);
    } catch (error) {
      throw new DatabaseUnavailableError(`无法初始化本地 SQLite 数据库：${errorMessage(error)}`, { cause: error });
    }
  }

  async verify(): Promise<void> {
    try {
      this.database.prepare("SELECT 1").get();
      const found = new Set(
        rows(this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
          .map((row) => String(row.name)),
      );
      const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
      if (missing.length > 0) {
        throw new DatabaseUnavailableError(`SQLite 数据库缺少运行时表：${missing.join(", ")}`);
      }
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) throw error;
      throw new DatabaseUnavailableError(`无法访问本地 SQLite 数据库：${errorMessage(error)}`, { cause: error });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  async interruptOrphanedRuns(): Promise<number> {
    const completedAt = now();
    const result = this.database.prepare(`
      UPDATE ai_runtime_run
      SET status = 'interrupted', completed_at = ?,
          duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
          error_message = COALESCE(error_message, 'API 进程重启，运行观测已中断'),
          updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(completedAt, completedAt, completedAt);
    return Number(result.changes);
  }

  async upsertProvider(provider: ProviderDescriptor): Promise<void> {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO ai_provider
        (id, kind, name, connection_status, capabilities, version, message, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        connection_status = excluded.connection_status,
        capabilities = excluded.capabilities,
        version = excluded.version,
        message = excluded.message,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run(
      provider.id,
      provider.kind,
      provider.name,
      provider.connected ? "connected" : "disconnected",
      JSON.stringify(provider.capabilities),
      provider.version?.slice(0, 64) ?? null,
      provider.message?.slice(0, 512) ?? null,
      timestamp,
      timestamp,
      timestamp,
    );
  }

  async upsertTasks(tasks: RuntimeTask[]): Promise<RuntimeTask[]> {
    // 全量发现可能返回数百条任务，分批事务既限制锁持有时间，也避免单条写入频繁刷盘。
    for (let offset = 0; offset < tasks.length; offset += 100) {
      this.writeTasks(tasks.slice(offset, offset + 100));
    }
    return this.listTasks();
  }

  async removeMissingDiscoveredTasks(providerId: string, externalIds: string[]): Promise<number> {
    // 空列表可能只是 Provider 临时读取失败，沿用旧实现语义，不执行清空操作。
    if (externalIds.length === 0) return 0;
    const placeholders = externalIds.map(() => "?").join(", ");
    const result = this.database.prepare(`
      DELETE FROM ai_runtime_task
      WHERE provider_id = ? AND source = 'discovered'
        AND external_id NOT IN (${placeholders})
    `).run(providerId, ...externalIds);
    return Number(result.changes);
  }

  async upsertTask(task: RuntimeTask): Promise<RuntimeTask> {
    this.writeTasks([task]);
    const result = await this.getTaskByExternalId(task.providerId, task.externalId);
    if (!result) throw new DatabaseUnavailableError("任务写入后无法读取");
    return result;
  }

  async listTasks(): Promise<RuntimeTask[]> {
    return rows(this.database.prepare(`
      SELECT task.*, parent.title AS parent_title
      FROM ai_runtime_task task
      LEFT JOIN ai_runtime_task parent
        ON parent.provider_id = task.provider_id
       AND parent.external_id = task.parent_external_id
      ORDER BY COALESCE(task.last_activity_at, task.updated_at) DESC
      LIMIT 1000
    `).all()).map(mapTask);
  }

  async getTask(taskId: string): Promise<RuntimeTask | null> {
    const row = this.database.prepare(`
      SELECT task.*, parent.title AS parent_title
      FROM ai_runtime_task task
      LEFT JOIN ai_runtime_task parent
        ON parent.provider_id = task.provider_id
       AND parent.external_id = task.parent_external_id
      WHERE task.id = ?
    `).get(taskId);
    return row ? mapTask(row as DatabaseRow) : null;
  }

  async getTaskByExternalId(providerId: string, externalId: string): Promise<RuntimeTask | null> {
    const row = this.database.prepare(`
      SELECT task.*, parent.title AS parent_title
      FROM ai_runtime_task task
      LEFT JOIN ai_runtime_task parent
        ON parent.provider_id = task.provider_id
       AND parent.external_id = task.parent_external_id
      WHERE task.provider_id = ? AND task.external_id = ?
    `).get(providerId, externalId);
    return row ? mapTask(row as DatabaseRow) : null;
  }

  async createRun(run: RuntimeRun): Promise<RuntimeRun> {
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO ai_runtime_run
        (id, task_id, external_id, status, prompt, started_at, tool_call_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      run.taskId,
      run.externalId ?? null,
      run.status,
      run.prompt ?? null,
      sqliteDate(run.startedAt),
      run.toolCallCount,
      timestamp,
      timestamp,
    );
    return { ...run, id };
  }

  async updateRun(runId: string, patch: Partial<RuntimeRun>): Promise<void> {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const mapping: Array<[keyof RuntimeRun, string]> = [
      ["status", "status"],
      ["completedAt", "completed_at"],
      ["durationMs", "duration_ms"],
      ["inputTokens", "input_tokens"],
      ["cachedInputTokens", "cached_input_tokens"],
      ["cacheWriteInputTokens", "cache_write_input_tokens"],
      ["outputTokens", "output_tokens"],
      ["reasoningOutputTokens", "reasoning_output_tokens"],
      ["totalTokens", "total_tokens"],
      ["toolCallCount", "tool_call_count"],
      ["errorMessage", "error_message"],
    ];
    for (const [key, column] of mapping) {
      if (patch[key] === undefined) continue;
      fields.push(`${column} = ?`);
      values.push(key === "completedAt" ? sqliteDate(patch.completedAt) : patch[key] as string | number | null);
    }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(now(), runId);
    this.database.prepare(`UPDATE ai_runtime_run SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  async getRunWithTask(runId: string): Promise<{ run: RuntimeRun; taskExternalId: string } | null> {
    const row = this.database.prepare(`
      SELECT run.*, task.external_id AS task_external_id
      FROM ai_runtime_run run
      INNER JOIN ai_runtime_task task ON task.id = run.task_id
      WHERE run.id = ?
    `).get(runId) as DatabaseRow | undefined;
    return row ? { run: mapRun(row), taskExternalId: String(row.task_external_id) } : null;
  }

  async appendEvent(event: Omit<RuntimeEvent, "id">): Promise<RuntimeEvent> {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO ai_runtime_event
        (event_uuid, run_id, task_id, provider_id, event_type, category, level, title,
         detail, duration_ms, payload, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.runId,
      event.taskId,
      event.providerId,
      event.type,
      event.category,
      event.level,
      event.title,
      event.detail ?? null,
      event.durationMs ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
      sqliteDate(event.occurredAt),
      now(),
    );
    return { ...event, id };
  }

  async saveOutputSnapshot(snapshot: Omit<RuntimeOutputSnapshot, "id">): Promise<RuntimeOutputSnapshot> {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO ai_runtime_output_snapshot
        (snapshot_uuid, run_id, task_id, content, format, is_final, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      snapshot.runId,
      snapshot.taskId,
      snapshot.content,
      snapshot.format,
      snapshot.isFinal ? 1 : 0,
      sqliteDate(snapshot.createdAt),
    );
    return { ...snapshot, id };
  }

  async getTaskDetail(taskId: string): Promise<TaskDetail> {
    const task = await this.getTask(taskId);
    if (!task) throw new NotFoundError("未找到任务");
    const runRows = rows(this.database.prepare(
      "SELECT * FROM ai_runtime_run WHERE task_id = ? ORDER BY started_at DESC",
    ).all(taskId));
    const eventRows = rows(this.database.prepare(
      "SELECT * FROM ai_runtime_event WHERE task_id = ? ORDER BY occurred_at DESC LIMIT 500",
    ).all(taskId));
    const latest = this.database.prepare(
      "SELECT * FROM ai_runtime_output_snapshot WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(taskId) as DatabaseRow | undefined;

    return {
      ...task,
      runs: runRows.map(mapRun),
      events: eventRows.map(mapEvent).reverse(),
      output: latest ? {
        id: String(latest.snapshot_uuid),
        runId: String(latest.run_id),
        taskId,
        content: String(latest.content),
        format: String(latest.format) as RuntimeOutputSnapshot["format"],
        isFinal: Boolean(latest.is_final),
        createdAt: date(latest.created_at)!,
      } : undefined,
    };
  }

  private writeTasks(tasks: RuntimeTask[]): void {
    if (tasks.length === 0) return;
    const statement = this.database.prepare(`
      INSERT INTO ai_runtime_task
        (id, provider_id, external_id, title, summary, cwd, model, source,
         relation_type, parent_external_id, relation_depth, agent_name,
         status, created_at, updated_at, last_activity_at, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, external_id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        cwd = excluded.cwd,
        model = excluded.model,
        source = CASE
          WHEN ai_runtime_task.source = 'managed' THEN ai_runtime_task.source
          ELSE excluded.source
        END,
        relation_type = excluded.relation_type,
        parent_external_id = excluded.parent_external_id,
        relation_depth = excluded.relation_depth,
        agent_name = excluded.agent_name,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_activity_at = excluded.last_activity_at,
        last_synced_at = excluded.last_synced_at
    `);

    runInTransaction(this.database, () => {
      for (const task of tasks) {
        statement.run(
          randomUUID(),
          task.providerId,
          task.externalId,
          task.title,
          task.summary ?? null,
          task.cwd ?? null,
          task.model ?? null,
          task.source,
          task.relation?.type ?? null,
          task.relation?.parentExternalId ?? null,
          task.relation?.depth ?? null,
          task.relation?.agentName ?? null,
          task.status,
          sqliteDate(task.createdAt),
          sqliteDate(task.updatedAt),
          sqliteDate(task.lastActivityAt),
          now(),
        );
      }
    });
  }
}
