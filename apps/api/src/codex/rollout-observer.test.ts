import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexRolloutObserver } from "./rollout-observer.js";

let eventSequence = 0;

function record(type: string, payloadType: string, extra: Record<string, unknown> = {}): string {
  eventSequence += 1;
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 7, 6, 8, 0, eventSequence)).toISOString(),
    type,
    payload: { type: payloadType, ...extra },
  });
}

function event(type: string, extra: Record<string, unknown> = {}): string {
  return record("event_msg", type, extra);
}

function sessionMeta(source: unknown): string {
  eventSequence += 1;
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 7, 6, 8, 0, eventSequence)).toISOString(),
    type: "session_meta",
    payload: { source },
  });
}

test("读取子 Agent 的父任务关系", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-rollout-"));
  const path = join(directory, "rollout.jsonl");
  try {
    await writeFile(path, [
      sessionMeta({ subagent: { thread_spawn: {
        parent_thread_id: "parent-thread", depth: 1, agent_nickname: "Ampere",
      } } }),
      event("task_started", { turn_id: "child-turn" }),
    ].join("\n") + "\n", "utf8");

    const result = await new CodexRolloutObserver(128).inspect(path);
    assert.deepEqual(result.relation, {
      type: "subtask",
      parentExternalId: "parent-thread",
      depth: 1,
      agentName: "Ampere",
    });
    assert.equal(result.lastObservedAt !== undefined, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("读取最新用户提问和已完成状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-rollout-"));
  const path = join(directory, "rollout.jsonl");
  try {
    await writeFile(path, [
      event("task_started", { turn_id: "turn-1" }),
      event("user_message", { message: "第一条提问" }),
      event("task_complete", { turn_id: "turn-1" }),
      event("task_started", { turn_id: "turn-2" }),
      event("user_message", { message: "最新一轮提问" }),
      event("task_complete", { turn_id: "turn-2", last_agent_message: "最终回答" }),
    ].join("\n") + "\n", "utf8");

    const result = await new CodexRolloutObserver().inspect(path);
    assert.equal(result.status, "completed");
    assert.equal(result.latestUserMessage, "最新一轮提问");
    assert.equal(result.run?.turnId, "turn-2");
    assert.equal(result.output?.content, "最终回答");
    assert.equal(result.output?.isFinal, true);
    assert.deepEqual(result.events.map((item) => item.title), ["任务开始执行", "收到任务输入", "任务执行完成"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("解析最新一轮的推理、命令、工具输出和 Token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-rollout-"));
  const path = join(directory, "rollout.jsonl");
  try {
    const observer = new CodexRolloutObserver();
    await writeFile(path, [
      event("task_started", { turn_id: "turn-observe", started_at: "2026-08-06T08:00:00.000Z" }),
      event("user_message", { message: "检查项目状态" }),
      event("agent_reasoning", { text: "先读取仓库状态" }),
      record("response_item", "custom_tool_call", {
        call_id: "call-1",
        name: "functions.exec",
        input: "tools.shell_command({ command: 'git status --short' })",
      }),
      record("response_item", "custom_tool_call_output", {
        call_id: "call-1",
        output: "Process exited with code 0\nFinal output:\n M README.md",
      }),
      event("token_count", {
        info: {
          last_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 900,
            cache_write_input_tokens: 20,
            output_tokens: 180,
            reasoning_output_tokens: 60,
            total_tokens: 1380,
          },
          total_token_usage: {
            input_tokens: 8200,
            cached_input_tokens: 6400,
            cache_write_input_tokens: 20,
            output_tokens: 980,
            reasoning_output_tokens: 260,
            total_tokens: 9180,
          },
          model_context_window: 258400,
        },
        rate_limits: {
          primary: { used_percent: 69, window_minutes: 10080, resets_at: 1786853279 },
          credits: { has_credits: false, unlimited: false, balance: "0" },
          plan_type: "prolite",
        },
      }),
      event("agent_message", { message: "检查完成", phase: "commentary" }),
    ].join("\n") + "\n", "utf8");

    const result = await observer.inspect(path);
    assert.equal(result.status, "running");
    assert.equal(result.run?.toolCallCount, 1);
    assert.equal(result.run?.inputTokens, 1200);
    assert.equal(result.run?.cachedInputTokens, 900);
    assert.equal(result.run?.cacheWriteInputTokens, 20);
    assert.equal(result.run?.outputTokens, 180);
    assert.equal(result.run?.reasoningOutputTokens, 60);
    assert.equal(result.run?.totalTokens, 1380);
    assert.equal(result.usageSnapshot?.usage.totalTokens, 9180);
    assert.equal(result.usageSnapshot?.usage.cachedInputTokens, 6400);
    assert.equal(result.usageSnapshot?.modelContextWindow, 258400);
    assert.equal(result.usageSnapshot?.rateLimit?.usedPercent, 69);
    assert.equal(result.usageSnapshot?.rateLimit?.windowMinutes, 10080);
    assert.equal(result.usageSnapshot?.rateLimit?.planType, "prolite");
    assert.equal(result.events.find((item) => item.category === "command")?.detail, "tools.shell_command({ command: 'git status --short' })");
    assert.equal(result.events.find((item) => item.type === "custom_tool_call_output")?.detail?.includes("README.md"), true);
    assert.equal(result.output?.content, "检查完成");
    assert.equal(result.output?.isFinal, false);

    await appendFile(path, `${event("agent_message", { message: "继续处理", phase: "commentary" })}\n`, "utf8");
    const incremented = await observer.inspect(path);
    assert.equal(incremented.run?.toolCallCount, 1);
    assert.equal(incremented.run?.inputTokens, 1200);
    assert.equal(incremented.run?.cachedInputTokens, 900);
    assert.equal(incremented.run?.outputTokens, 180);
    assert.equal(incremented.run?.reasoningOutputTokens, 60);
    assert.equal(incremented.run?.totalTokens, 1380);
    assert.equal(incremented.output?.content, "继续处理");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("文件增长后增量更新为运行中", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-rollout-"));
  const path = join(directory, "rollout.jsonl");
  try {
    const observer = new CodexRolloutObserver();
    await writeFile(path, `${event("task_started")}\n${event("user_message", { message: "上一轮" })}\n${event("turn_aborted")}\n`, "utf8");
    assert.equal((await observer.inspect(path)).status, "interrupted");

    await appendFile(path, `${event("task_started")}\n${event("user_message", { message: "现在正在执行的问题" })}\n`, "utf8");
    const result = await observer.inspect(path);
    assert.equal(result.status, "running");
    assert.equal(result.latestUserMessage, "现在正在执行的问题");
    assert.equal(result.events.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("文件不存在时安全降级", async () => {
  assert.deepEqual(await new CodexRolloutObserver().inspect("Z:\\missing-rollout.jsonl"), { events: [] });
});

test("长会话会分块向前查找最近的生命周期事件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-rollout-"));
  const path = join(directory, "rollout.jsonl");
  try {
    await writeFile(path, `${event("task_started")}\n${"x".repeat(2_048)}\n`, "utf8");
    const result = await new CodexRolloutObserver(256).inspect(path);
    assert.equal(result.status, "running");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("附件包装消息只保留用户的真实提问", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-rollout-"));
  const path = join(directory, "rollout.jsonl");
  try {
    const wrapped = "# Files mentioned by the user:\n\n## demo.png: C:/demo.png\n\n## My request for Codex:\n这是最新问题";
    await writeFile(path, `${event("task_started")}\n${event("user_message", { message: wrapped })}\n`, "utf8");
    assert.equal((await new CodexRolloutObserver().inspect(path)).latestUserMessage, "这是最新问题");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
