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
