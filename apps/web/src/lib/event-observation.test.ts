import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "@openartifact-labs/runtime-contracts";

import {
  REDACTED_VALUE,
  aggregateLowValueEvents,
  buildEventObservation,
  extractStructuredEventDetails,
  filterRuntimeEvents,
  isKeyRuntimeEvent,
  redactSensitiveFields,
} from "./event-observation";

function event(
  id: string,
  overrides: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    id,
    runId: "run-1",
    taskId: "task-1",
    providerId: "codex-local",
    type: "diagnostic",
    category: "system",
    level: "info",
    title: `事件 ${id}`,
    occurredAt: `2026-08-11T08:00:${id.padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

test("关键事件保留生命周期、副作用、Agent 输出和所有警告错误", () => {
  const cases: Array<[RuntimeEvent, boolean]> = [
    [event("1", { category: "lifecycle", type: "task_started" }), true],
    [event("2", { category: "command" }), true],
    [event("3", { category: "tool" }), true],
    [event("4", { category: "file" }), true],
    [event("5", { category: "message", type: "agent_message", title: "Agent 输出" }), true],
    [event("10", { category: "message", type: "item/agentMessage/completed", title: "模型回复" }), true],
    [event("6", { level: "warning" }), true],
    [event("7", { level: "error" }), true],
    [event("8", { category: "message", type: "agent_reasoning", level: "debug" }), false],
    [event("9", { category: "system", type: "token_count" }), false],
  ];

  assert.deepEqual(cases.map(([item]) => item.id).filter((_, index) => isKeyRuntimeEvent(cases[index]![0])), [
    "1", "2", "3", "4", "5", "10", "6", "7",
  ]);
});

test("关键和完整模式可叠加分类筛选及大小写不敏感的文本搜索", () => {
  const events = [
    event("1", { category: "command", title: "执行命令", detail: "PNPM Test" }),
    event("2", { category: "tool", title: "调用工具", payload: { name: "Search_Query", result: "matched" } }),
    event("3", { category: "system", title: "Token 更新" }),
  ];

  assert.deepEqual(
    filterRuntimeEvents(events, { mode: "key", categories: ["command"], query: "pnpm" }).map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(
    filterRuntimeEvents(events, { mode: "full", categories: ["tool", "system"], query: "search_query" }).map((item) => item.id),
    ["2"],
  );
  assert.deepEqual(filterRuntimeEvents(events, { mode: "full" }).map((item) => item.id), ["1", "2", "3"]);
});

test("只聚合连续且数量大于一的低价值事件，关键事件保持独立和原顺序", () => {
  const events = [
    event("1", { category: "lifecycle" }),
    event("2", { category: "system", type: "token_count" }),
    event("3", { category: "message", type: "agent_reasoning", level: "debug" }),
    event("4", { category: "command" }),
    event("5", { category: "system" }),
  ];

  const result = aggregateLowValueEvents(events);
  assert.deepEqual(result.map((item) => [item.kind, item.id]), [
    ["event", "1"],
    ["aggregate", "aggregate:2:3"],
    ["event", "4"],
    ["event", "5"],
  ]);
  const group = result[1];
  assert.equal(group?.kind, "aggregate");
  if (group?.kind === "aggregate") {
    assert.equal(group.count, 2);
    assert.deepEqual(group.categories, ["system", "message"]);
    assert.deepEqual(group.events.map((item) => item.id), ["2", "3"]);
  }
});

test("组合观测在关键模式中不会让关键事件进入聚合组", () => {
  const result = buildEventObservation([
    event("1", { category: "system" }),
    event("2", { category: "tool" }),
    event("3", { category: "system", level: "warning" }),
  ], { mode: "key" });

  assert.deepEqual(result.map((item) => [item.kind, item.id]), [["event", "2"], ["event", "3"]]);
});

test("筛选掉的原始事件仍隔断低价值聚合", () => {
  const result = buildEventObservation([
    event("1", { category: "system", detail: "命中" }),
    event("2", { category: "command", detail: "不相关" }),
    event("3", { category: "system", detail: "命中" }),
  ], { mode: "full", query: "命中" });

  assert.deepEqual(result.map((item) => [item.kind, item.id]), [["event", "1"], ["event", "3"]]);
});

test("递归脱敏常见敏感字段，保留 Token 计数且不修改原对象", () => {
  const original = {
    authorization: "Bearer secret",
    headers: { "X-API-Key": "key-value", accept: "application/json" },
    request: {
      password: "pass-value",
      nested: [{ refresh_token: "refresh-value", github_token: "github-value", total_tokens: 128 }],
    },
    tokenUsage: { inputTokens: 64, output_tokens: 32 },
  };

  const result = redactSensitiveFields(original);
  assert.notEqual(result, original);
  assert.notEqual(result.request, original.request);
  assert.equal(result.authorization, REDACTED_VALUE);
  assert.equal(result.headers["X-API-Key"], REDACTED_VALUE);
  assert.equal(result.headers.accept, "application/json");
  assert.equal(result.request.password, REDACTED_VALUE);
  assert.equal(result.request.nested[0]?.refresh_token, REDACTED_VALUE);
  assert.equal(result.request.nested[0]?.github_token, REDACTED_VALUE);
  assert.deepEqual(result.tokenUsage, { inputTokens: 64, output_tokens: 32 });
  assert.equal(original.authorization, "Bearer secret");
  assert.equal(original.request.nested[0]?.refresh_token, "refresh-value");
});

test("结构化详情包含稳定元数据、清理后的正文和脱敏 payload", () => {
  const source = event("42", {
    type: "custom_tool_call",
    category: "tool",
    level: "warning",
    title: "工具重试",
    detail: "  第一次调用超时  ",
    durationMs: 1500,
    payload: { name: "example", client_secret: "secret-value" },
  });

  const details = extractStructuredEventDetails(source);
  assert.equal(details.content, "第一次调用超时");
  assert.deepEqual(details.fields.map((field) => field.key), [
    "type", "category", "level", "occurredAt", "durationMs",
  ]);
  assert.deepEqual(details.payload, { name: "example", client_secret: REDACTED_VALUE });
  assert.deepEqual(source.payload, { name: "example", client_secret: "secret-value" });
});

test("命令事件详情提取工作目录、退出码和脱敏输出分区", () => {
  const details = extractStructuredEventDetails(event("command", {
    category: "command",
    payload: {
      command: "pnpm test",
      cwd: "D:/Ai/project",
      exitCode: 0,
      stdout: "passed",
      apiKey: "secret-value",
    },
  }));

  assert.deepEqual(details.sections.map((section) => section.label), ["执行命令", "工作目录", "退出码", "标准输出"]);
  assert.equal(details.payload?.apiKey, REDACTED_VALUE);
});
