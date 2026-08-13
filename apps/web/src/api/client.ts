import type {
  LaunchTaskInput,
  LaunchTaskResult,
  ProviderDescriptor,
  ProviderUsageAnalytics,
  ProviderUsageSnapshot,
  RuntimeTask,
  TaskDetail,
  TaskListResponse,
} from "@openartifact-labs/runtime-contracts";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("无法连接运行时服务，请确认 API 服务已启动");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new ApiError(body?.message ?? body?.error ?? `请求失败（${response.status}）`, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function unwrapItems<T>(value: T[] | { items: T[] } | { data: T[] }): T[] {
  if (Array.isArray(value)) return value;
  if ("items" in value) return value.items;
  return value.data;
}

export async function getProviders(): Promise<ProviderDescriptor[]> {
  const response = await request<
    ProviderDescriptor[] | { items: ProviderDescriptor[] } | { data: ProviderDescriptor[] }
  >("/providers");
  return unwrapItems(response);
}

export async function getProviderUsage(providerId: string): Promise<ProviderUsageSnapshot | null> {
  return request<ProviderUsageSnapshot | null>(`/providers/${encodeURIComponent(providerId)}/usage`);
}

export async function getProviderUsageAnalytics(providerId: string, days = 30): Promise<ProviderUsageAnalytics> {
  return request<ProviderUsageAnalytics>(`/providers/${encodeURIComponent(providerId)}/usage-analytics?days=${days}`);
}

export async function getTasks(): Promise<TaskListResponse> {
  const response = await request<TaskListResponse | RuntimeTask[]>("/tasks");
  if (Array.isArray(response)) {
    return { items: response, total: response.length, syncedAt: new Date().toISOString() };
  }
  return response;
}

export async function getTaskDetail(taskId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/tasks/${encodeURIComponent(taskId)}`);
}

export async function launchTask(input: LaunchTaskInput): Promise<LaunchTaskResult> {
  return request<LaunchTaskResult>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function interruptRun(runId: string): Promise<void> {
  await request<void>(`/runs/${encodeURIComponent(runId)}/interrupt`, { method: "POST" });
}

export function openRuntimeStream(
  onMessage: () => void,
  onConnectionChange: (connected: boolean) => void,
): () => void {
  const stream = new EventSource(`${API_BASE}/stream`);

  stream.onopen = () => onConnectionChange(true);
  stream.onmessage = onMessage;
  stream.addEventListener("runtime-event", onMessage);
  stream.addEventListener("task-updated", onMessage);
  stream.addEventListener("run-updated", onMessage);
  stream.onerror = () => onConnectionChange(false);

  return () => stream.close();
}
