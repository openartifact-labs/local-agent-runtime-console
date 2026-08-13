import type {
  ProviderDescriptor,
  RuntimeEvent,
  RuntimeOutputSnapshot,
  RuntimeRun,
  RuntimeTask,
  TaskDetail,
} from "@openartifact-labs/runtime-contracts";

/** Runtime Service 依赖的持久化边界，具体数据库实现不得泄漏到业务层。 */
export interface RuntimeRepository {
  verify(): Promise<void>;
  close(): Promise<void>;
  interruptOrphanedRuns(): Promise<number>;
  upsertProvider(provider: ProviderDescriptor): Promise<void>;
  upsertTasks(tasks: RuntimeTask[]): Promise<RuntimeTask[]>;
  removeMissingDiscoveredTasks(providerId: string, externalIds: string[]): Promise<number>;
  upsertTask(task: RuntimeTask): Promise<RuntimeTask>;
  listTasks(): Promise<RuntimeTask[]>;
  getTask(taskId: string): Promise<RuntimeTask | null>;
  getTaskByExternalId(providerId: string, externalId: string): Promise<RuntimeTask | null>;
  createRun(run: RuntimeRun): Promise<RuntimeRun>;
  updateRun(runId: string, patch: Partial<RuntimeRun>): Promise<void>;
  getRunWithTask(runId: string): Promise<{ run: RuntimeRun; taskExternalId: string } | null>;
  appendEvent(event: Omit<RuntimeEvent, "id">): Promise<RuntimeEvent>;
  saveOutputSnapshot(snapshot: Omit<RuntimeOutputSnapshot, "id">): Promise<RuntimeOutputSnapshot>;
  getTaskDetail(taskId: string): Promise<TaskDetail>;
}
