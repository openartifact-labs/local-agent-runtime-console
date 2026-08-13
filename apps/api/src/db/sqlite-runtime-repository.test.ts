import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderDescriptor, RuntimeRun, RuntimeTask } from "@openartifact-labs/runtime-contracts";

import { loadConfig } from "../config.js";
import { SqliteRuntimeRepository } from "./sqlite-runtime-repository.js";

const PROVIDER: ProviderDescriptor = {
  id: "codex-local",
  kind: "codex",
  name: "本机 Codex",
  connected: true,
  capabilities: {
    discoverTasks: true,
    launchTask: true,
    deepObservation: true,
    interruptRun: true,
    tokenUsage: true,
  },
  version: "1.0.0",
};

function task(overrides: Partial<RuntimeTask> = {}): RuntimeTask {
  return {
    id: overrides.id ?? "provider-id-not-used-as-storage-id",
    externalId: overrides.externalId ?? "thread-parent",
    providerId: overrides.providerId ?? PROVIDER.id,
    title: overrides.title ?? "父任务",
    summary: overrides.summary,
    cwd: overrides.cwd ?? "D:\\workspace",
    model: overrides.model,
    source: overrides.source ?? "discovered",
    status: overrides.status ?? "running",
    createdAt: overrides.createdAt ?? "2026-08-13T01:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-13T01:00:01.000Z",
    lastActivityAt: overrides.lastActivityAt ?? "2026-08-13T01:00:01.000Z",
    relation: overrides.relation,
  };
}

async function fixture(t: test.TestContext): Promise<{
  databasePath: string;
  repository: SqliteRuntimeRepository;
}> {
  const directory = await mkdtemp(join(tmpdir(), "local-agent-runtime-repository-"));
  const databasePath = join(directory, "nested", "runtime.sqlite");
  const repository = new SqliteRuntimeRepository({ path: databasePath });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  await repository.verify();
  await repository.upsertProvider(PROVIDER);
  return { databasePath, repository };
}

test("首次启动自动创建数据库，配置默认使用调用方传入的数据目录", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "local-agent-runtime-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({}, { dataDirectory: directory });
  assert.equal(config.database.path, join(directory, "runtime-console.sqlite"));

  const repository = new SqliteRuntimeRepository(config.database);
  await repository.verify();
  await repository.close();
  assert.equal((await stat(config.database.path)).isFile(), true);
});

test("任务同步保留父子关系，并且发现同步不会把受管任务降级", async (t) => {
  const { repository } = await fixture(t);
  const parent = task({ externalId: "thread-parent", title: "主任务", source: "managed" });
  const child = task({
    externalId: "thread-child",
    title: "子任务",
    relation: {
      type: "subtask",
      parentExternalId: parent.externalId,
      depth: 1,
      agentName: "worker-a",
    },
  });
  await repository.upsertTasks([parent, child]);

  await repository.upsertTask({
    ...parent,
    source: "discovered",
    title: "同步后的主任务",
    updatedAt: "2026-08-13T01:01:00.000Z",
  });

  const storedParent = await repository.getTaskByExternalId(PROVIDER.id, parent.externalId);
  const storedChild = await repository.getTaskByExternalId(PROVIDER.id, child.externalId);
  assert.equal(storedParent?.source, "managed");
  assert.equal(storedParent?.title, "同步后的主任务");
  assert.deepEqual(storedChild?.relation, {
    type: "subtask",
    parentExternalId: parent.externalId,
    parentTitle: "同步后的主任务",
    depth: 1,
    agentName: "worker-a",
  });

  assert.equal(await repository.removeMissingDiscoveredTasks(PROVIDER.id, []), 0);
  assert.equal(await repository.removeMissingDiscoveredTasks(PROVIDER.id, [parent.externalId]), 1);
  assert.equal(await repository.getTaskByExternalId(PROVIDER.id, child.externalId), null);
  assert.ok(await repository.getTaskByExternalId(PROVIDER.id, parent.externalId));
});

test("运行、Token、事件和最新输出快照在关闭数据库后仍可完整恢复", async (t) => {
  const { databasePath, repository } = await fixture(t);
  const storedTask = await repository.upsertTask(task({ source: "managed" }));
  const runInput: RuntimeRun = {
    id: "temporary-run-id",
    externalId: "turn-1",
    taskId: storedTask.id,
    status: "running",
    prompt: "检查本地持久化",
    startedAt: "2026-08-13T02:00:00.000Z",
    toolCallCount: 0,
  };
  const run = await repository.createRun(runInput);
  await repository.updateRun(run.id, {
    status: "completed",
    completedAt: "2026-08-13T02:00:05.000Z",
    durationMs: 5_000,
    inputTokens: 120,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 10,
    outputTokens: 30,
    reasoningOutputTokens: 5,
    totalTokens: 150,
    toolCallCount: 2,
  });
  await repository.appendEvent({
    runId: run.id,
    taskId: storedTask.id,
    providerId: PROVIDER.id,
    type: "turn/started",
    category: "lifecycle",
    level: "info",
    title: "任务开始",
    payload: { source: "test" },
    occurredAt: "2026-08-13T02:00:00.000Z",
  });
  await repository.appendEvent({
    runId: run.id,
    taskId: storedTask.id,
    providerId: PROVIDER.id,
    type: "turn/completed",
    category: "lifecycle",
    level: "info",
    title: "任务完成",
    durationMs: 5_000,
    occurredAt: "2026-08-13T02:00:05.000Z",
  });
  await repository.saveOutputSnapshot({
    runId: run.id,
    taskId: storedTask.id,
    content: "处理中",
    format: "markdown",
    isFinal: false,
    createdAt: "2026-08-13T02:00:03.000Z",
  });
  await repository.saveOutputSnapshot({
    runId: run.id,
    taskId: storedTask.id,
    content: "已完成",
    format: "markdown",
    isFinal: true,
    createdAt: "2026-08-13T02:00:05.000Z",
  });

  await repository.close();
  const reopened = new SqliteRuntimeRepository({ path: databasePath });
  t.after(() => reopened.close());
  const detail = await reopened.getTaskDetail(storedTask.id);
  assert.equal(detail.runs.length, 1);
  assert.deepEqual(detail.runs[0], {
    ...runInput,
    id: run.id,
    status: "completed",
    completedAt: "2026-08-13T02:00:05.000Z",
    durationMs: 5_000,
    inputTokens: 120,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 10,
    outputTokens: 30,
    reasoningOutputTokens: 5,
    totalTokens: 150,
    toolCallCount: 2,
    errorMessage: undefined,
  });
  assert.deepEqual(detail.events.map((event) => event.type), ["turn/started", "turn/completed"]);
  assert.deepEqual(detail.events[0]?.payload, { source: "test" });
  assert.equal(detail.output?.content, "已完成");
  assert.equal(detail.output?.isFinal, true);
  assert.equal((await reopened.getRunWithTask(run.id))?.taskExternalId, storedTask.externalId);
  await reopened.close();
});

test("启动恢复只中断排队中和运行中的遗留运行", async (t) => {
  const { repository } = await fixture(t);
  const storedTask = await repository.upsertTask(task({ source: "managed" }));
  const running = await repository.createRun({
    id: "running",
    taskId: storedTask.id,
    status: "running",
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    toolCallCount: 0,
  });
  const completed = await repository.createRun({
    id: "completed",
    taskId: storedTask.id,
    externalId: "completed-turn",
    status: "completed",
    startedAt: "2026-08-13T03:00:00.000Z",
    completedAt: "2026-08-13T03:00:01.000Z",
    toolCallCount: 0,
  });

  assert.equal(await repository.interruptOrphanedRuns(), 1);
  const recovered = await repository.getRunWithTask(running.id);
  const untouched = await repository.getRunWithTask(completed.id);
  assert.equal(recovered?.run.status, "interrupted");
  assert.equal(recovered?.run.errorMessage, "API 进程重启，运行观测已中断");
  assert.ok((recovered?.run.durationMs ?? -1) >= 0);
  assert.equal(untouched?.run.status, "completed");
});
