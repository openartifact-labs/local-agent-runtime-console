import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { UsageAnalyticsSeries } from "@openartifact-labs/runtime-contracts";

import { CodexUsageAnalyzer } from "./usage-analyzer.js";

function record(type: string, payload: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({ timestamp, type, payload });
}

function seriesTotal(series: UsageAnalyticsSeries, key: string): number {
  return series.points.reduce((total, point) => total + (point.values[key] ?? 0), 0);
}

function chinaDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function chinaTimestamp(date: string, hour: number): string {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00.000+08:00`).toISOString();
}

test("按本机会话来源、模型和每轮 Skill 调用聚合使用分析", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-"));
  const path = join(directory, "rollout.jsonl");
  const now = new Date().toISOString();
  const skillCall = JSON.stringify({ command: "Get-Content C:\\Users\\tester\\.codex\\skills\\grilling\\SKILL.md" });

  try {
    await writeFile(path, [
      record("session_meta", { originator: "Codex Desktop", thread_source: "user" }, now),
      record("event_msg", { type: "task_started" }, now),
      record("turn_context", { model: "gpt-test" }, now),
      record("response_item", { type: "custom_tool_call", arguments: skillCall }, now),
      record("response_item", { type: "custom_tool_call", arguments: skillCall }, now),
      record("event_msg", { type: "task_started" }, now),
      record("turn_context", { model: "gpt-test" }, now),
      record("response_item", { type: "custom_tool_call", arguments: skillCall }, now),
    ].join("\n"), "utf8");

    const cachePath = join(directory, "cache.json");
    const result = await new CodexUsageAnalyzer("codex-local", cachePath).analyze([path], 7);

    assert.equal(result.scope, "local");
    assert.equal(result.sessionCount, 1);
    assert.equal(result.turnCount, 2);
    assert.equal(result.skillInvocationCount, 2);
    assert.equal(seriesTotal(result.bySurface, "desktop"), 1);
    assert.equal(seriesTotal(result.byModel, "gpt-test"), 2);
    assert.equal(seriesTotal(result.bySkill, "grilling"), 2);

    const restored = await new CodexUsageAnalyzer("codex-local", cachePath).analyze([path], 7);
    assert.equal(restored.turnCount, 2);
    assert.equal(restored.skillInvocationCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("按中国时区返回今日任务、模型和 Token 增量，并标记缺少日初快照的跨天会话", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-today-"));
  const completePath = join(directory, "complete.jsonl");
  const partialPath = join(directory, "partial.jsonl");
  const today = chinaDate(new Date());
  const yesterday = chinaDate(new Date(new Date(`${today}T12:00:00.000+08:00`).getTime() - 24 * 60 * 60 * 1_000));

  try {
    await writeFile(completePath, [
      record("session_meta", { originator: "Codex Desktop" }, chinaTimestamp(yesterday, 20)),
      record("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } }, chinaTimestamp(yesterday, 21)),
      record("turn_context", { model: "gpt-test" }, chinaTimestamp(today, 10)),
      record("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 180, cached_input_tokens: 120, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 220 } } }, chinaTimestamp(today, 11)),
    ].join("\n"), "utf8");
    await writeFile(partialPath, [
      record("session_meta", { originator: "Codex Desktop" }, chinaTimestamp(yesterday, 20)),
      record("turn_context", { model: "gpt-partial" }, chinaTimestamp(today, 12)),
      record("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 25, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 60 } } }, chinaTimestamp(today, 13)),
    ].join("\n"), "utf8");

    const result = await new CodexUsageAnalyzer("codex-local", join(directory, "cache.json")).analyze([
      { path: completePath, task: { externalId: "complete", title: "有基线任务" } },
      { path: partialPath, task: { externalId: "partial", title: "缺基线任务" } },
    ], 1);

    assert.equal(result.days, 1);
    assert.equal(result.byModel.points.length, 1);
    assert.equal(result.today.date, today);
    assert.equal(result.today.sessionCount, 2);
    assert.equal(result.today.tokenObservedSessionCount, 2);
    assert.equal(result.today.partialTokenSessionCount, 1);
    assert.equal(result.today.usage.inputTokens, 130);
    assert.equal(result.today.usage.cachedInputTokens, 75);
    assert.equal(result.today.usage.outputTokens, 30);
    assert.equal(result.today.usage.reasoningOutputTokens, 8);
    assert.equal(result.today.usage.totalTokens, 160);
    assert.equal(result.today.sessions.find((session) => session.taskExternalId === "complete")?.model, "gpt-test");
    assert.equal(result.today.sessions.find((session) => session.taskExternalId === "partial")?.tokenUsagePartial, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
