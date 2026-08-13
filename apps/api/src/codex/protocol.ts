export type JsonObject = Record<string, unknown>;
export type JsonRpcId = number | string;

export interface JsonRpcNotification { method: string; params?: JsonObject; }
export interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface InitializeResponse {
  userAgent: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

export interface CodexThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active" | string;
  activeFlags?: string[];
}

export interface CodexThreadItem {
  id?: string;
  type: string;
  text?: string;
  status?: string;
  durationMs?: number | null;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  items?: CodexThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress" | string;
  error?: { message: string; additionalDetails?: string | null } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface CodexThread {
  id: string;
  path?: string | null;
  preview?: string;
  modelProvider?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  status?: CodexThreadStatus;
  cwd?: string;
  source?: unknown;
  name?: string | null;
  turns?: CodexTurn[];
}

export interface ThreadListResponse { data: CodexThread[]; nextCursor: string | null; }
export interface ThreadReadResponse { thread: CodexThread; }
export interface ThreadStartResponse { thread: CodexThread; model?: string; modelProvider?: string; cwd?: string; }
export interface TurnStartResponse { turn: CodexTurn; }

export const CODEX_THREAD_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
] as const;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasRpcId(value: JsonObject): value is JsonObject & { id: JsonRpcId } {
  return typeof value.id === "string" || typeof value.id === "number";
}
