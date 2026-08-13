export type ProviderKind = "codex" | (string & {});

export type TaskStatus =
  | "not_loaded"
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "stale"
  | "unknown";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "stale";

export type EventLevel = "debug" | "info" | "warning" | "error";

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  name: string;
  connected: boolean;
  capabilities: {
    discoverTasks: boolean;
    launchTask: boolean;
    deepObservation: boolean;
    interruptRun: boolean;
    tokenUsage: boolean;
  };
  version?: string;
  message?: string;
}

export interface RuntimeTask {
  id: string;
  externalId: string;
  providerId: string;
  title: string;
  summary?: string;
  cwd?: string;
  model?: string;
  source: "discovered" | "managed";
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  activeRunId?: string;
  relation?: {
    type: "subtask";
    parentExternalId: string;
    parentTitle?: string;
    depth: number;
    agentName?: string;
  };
}

export interface RuntimeTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface ProviderRateLimit {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
  planType?: string;
  hasCredits?: boolean;
  unlimited?: boolean;
  creditBalance?: string;
}

export interface ProviderUsageSnapshot {
  providerId: string;
  observedAt: string;
  scope: "latest-session";
  taskExternalId?: string;
  taskTitle?: string;
  modelContextWindow?: number;
  usage: RuntimeTokenUsage;
  rateLimit?: ProviderRateLimit;
}

export interface UsageAnalyticsSeries {
  keys: Array<{ id: string; label: string }>;
  points: Array<{ date: string; values: Record<string, number> }>;
}

export interface ProviderUsageAnalytics {
  providerId: string;
  observedAt: string;
  scope: "local";
  days: number;
  sessionCount: number;
  turnCount: number;
  skillInvocationCount: number;
  bySurface: UsageAnalyticsSeries;
  byModel: UsageAnalyticsSeries;
  bySkill: UsageAnalyticsSeries;
}

export interface RuntimeRun extends RuntimeTokenUsage {
  id: string;
  externalId?: string;
  taskId: string;
  status: RunStatus;
  prompt?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  toolCallCount: number;
  errorMessage?: string;
}

export interface RuntimeEvent {
  id: string;
  runId: string;
  taskId: string;
  providerId: string;
  type: string;
  category: "lifecycle" | "message" | "command" | "tool" | "file" | "system";
  level: EventLevel;
  title: string;
  detail?: string;
  occurredAt: string;
  durationMs?: number;
  payload?: Record<string, unknown>;
}

export interface RuntimeOutputSnapshot {
  id: string;
  runId: string;
  taskId: string;
  content: string;
  format: "markdown" | "text";
  isFinal: boolean;
  createdAt: string;
}

export interface TaskDetail extends RuntimeTask {
  runs: RuntimeRun[];
  events: RuntimeEvent[];
  output?: RuntimeOutputSnapshot;
}

export interface RuntimeObservation {
  run?: RuntimeRun;
  events: RuntimeEvent[];
  output?: RuntimeOutputSnapshot;
}

export interface TaskListResponse {
  items: RuntimeTask[];
  total: number;
  syncedAt: string;
}

export interface LaunchTaskInput {
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  providerId?: string;
}

export interface LaunchTaskResult {
  task: RuntimeTask;
  run: RuntimeRun;
}

export interface ProviderEvent {
  method: string;
  params: Record<string, unknown>;
  receivedAt: string;
}

export interface AgentRuntimeProvider {
  descriptor(): Promise<ProviderDescriptor>;
  listTasks(): Promise<RuntimeTask[]>;
  getTask(externalId: string): Promise<RuntimeTask | null>;
  readObservation?(task: RuntimeTask): Promise<RuntimeObservation | null>;
  getUsageSnapshot?(): Promise<ProviderUsageSnapshot | null>;
  getUsageAnalytics?(days?: number): Promise<ProviderUsageAnalytics>;
  launchTask(input: LaunchTaskInput): Promise<LaunchTaskResult>;
  interruptRun(taskExternalId: string, runExternalId: string): Promise<void>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  close(): Promise<void>;
}
