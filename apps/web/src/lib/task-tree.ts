import type { RuntimeTask, TaskStatus } from "@openartifact-labs/runtime-contracts";

export type TaskSourceFilter = "all" | "managed" | "discovered" | "subtask";
export type TaskStatusFilter = "all" | TaskStatus;
export type TaskMetricFilter = "active" | "managed" | "abnormal";

const metricStatusFilters: Record<Exclude<TaskMetricFilter, "managed">, ReadonlySet<TaskStatus>> = {
  active: new Set(["running", "waiting"]),
  abnormal: new Set(["failed", "stale"]),
};

export interface TaskTreeFilters {
  query: string;
  source: TaskSourceFilter;
  status: TaskStatusFilter;
  metric?: TaskMetricFilter;
}

export interface TaskTreeNode {
  task: RuntimeTask;
  children: TaskTreeNode[];
  directMatch: boolean;
  matchedTaskCount: number;
  totalTaskCount: number;
  latestActivityAt: string;
}

export interface TaskTreeResult {
  roots: TaskTreeNode[];
  matchedTaskCount: number;
  filtersActive: boolean;
}

function taskKey(task: Pick<RuntimeTask, "providerId" | "externalId">): string {
  return `${task.providerId}:${task.externalId}`;
}

function taskActivity(task: RuntimeTask): string {
  return task.lastActivityAt ?? task.updatedAt;
}

function matchesSource(task: RuntimeTask, source: TaskSourceFilter): boolean {
  if (source === "all") return true;
  if (source === "subtask") return Boolean(task.relation);
  if (source === "managed") return task.source === "managed";
  return task.source === "discovered" && !task.relation;
}

export function taskMatchesStatusFilter(status: TaskStatus, filter: TaskStatusFilter): boolean {
  if (filter === "all") return true;
  return status === filter;
}

export function taskMatchesMetric(
  task: Pick<RuntimeTask, "source" | "status">,
  metric: TaskMetricFilter,
): boolean {
  if (metric === "managed") return task.source === "managed";
  return metricStatusFilters[metric].has(task.status);
}

function matchesTask(task: RuntimeTask, filters: TaskTreeFilters, normalizedQuery: string): boolean {
  if (filters.metric && !taskMatchesMetric(task, filters.metric)) return false;
  if (!taskMatchesStatusFilter(task.status, filters.status)) return false;
  if (!matchesSource(task, filters.source)) return false;
  if (!normalizedQuery) return true;

  return [
    task.title,
    task.summary,
    task.cwd,
    task.model,
    task.relation?.agentName,
    task.relation?.parentTitle,
  ].filter(Boolean).some((value) => value!.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
}

function containsNode(root: TaskTreeNode, candidate: TaskTreeNode): boolean {
  if (root === candidate) return true;
  return root.children.some((child) => containsNode(child, candidate));
}

function summarizeNode(node: TaskTreeNode): void {
  for (const child of node.children) summarizeNode(child);
  node.totalTaskCount = 1 + node.children.reduce((total, child) => total + child.totalTaskCount, 0);
  node.latestActivityAt = node.children.reduce(
    (latest, child) => child.latestActivityAt > latest ? child.latestActivityAt : latest,
    taskActivity(node.task),
  );
  node.children.sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));
}

function filterNode(node: TaskTreeNode, filters: TaskTreeFilters, normalizedQuery: string): TaskTreeNode | null {
  const children = node.children
    .map((child) => filterNode(child, filters, normalizedQuery))
    .filter((child): child is TaskTreeNode => child !== null);
  const directMatch = matchesTask(node.task, filters, normalizedQuery);
  if (!directMatch && children.length === 0) return null;

  return {
    ...node,
    children,
    directMatch,
    matchedTaskCount: (directMatch ? 1 : 0) + children.reduce((total, child) => total + child.matchedTaskCount, 0),
  };
}

export function buildTaskTree(tasks: RuntimeTask[], filters: TaskTreeFilters): TaskTreeResult {
  const nodes = tasks.map<TaskTreeNode>((task) => ({
    task,
    children: [],
    directMatch: true,
    matchedTaskCount: 1,
    totalTaskCount: 1,
    latestActivityAt: taskActivity(task),
  }));
  const nodesByExternalId = new Map(nodes.map((node) => [taskKey(node.task), node]));
  const roots: TaskTreeNode[] = [];

  for (const node of nodes) {
    const relation = node.task.relation;
    const parent = relation
      ? nodesByExternalId.get(`${node.task.providerId}:${relation.parentExternalId}`)
      : undefined;
    // 异常或循环关系按根任务降级，避免一条脏关系让整棵任务树不可见。
    if (parent && parent !== node && !containsNode(node, parent)) parent.children.push(node);
    else roots.push(node);
  }

  for (const root of roots) summarizeNode(root);
  roots.sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));

  const normalizedQuery = filters.query.trim().toLocaleLowerCase("zh-CN");
  const filtersActive = Boolean(normalizedQuery)
    || filters.status !== "all"
    || filters.source !== "all"
    || Boolean(filters.metric);
  if (!filtersActive) {
    return { roots, matchedTaskCount: tasks.length, filtersActive };
  }

  const filteredRoots = roots
    .map((root) => filterNode(root, filters, normalizedQuery))
    .filter((root): root is TaskTreeNode => root !== null);
  return {
    roots: filteredRoots,
    matchedTaskCount: filteredRoots.reduce((total, root) => total + root.matchedTaskCount, 0),
    filtersActive,
  };
}

export function nodeContainsTask(node: TaskTreeNode, taskId: string | undefined): boolean {
  if (!taskId) return false;
  return node.task.id === taskId || node.children.some((child) => nodeContainsTask(child, taskId));
}

export function findFirstDirectMatch(roots: TaskTreeNode[]): TaskTreeNode | undefined {
  for (const root of roots) {
    if (root.directMatch) return root;
    const childMatch = findFirstDirectMatch(root.children);
    if (childMatch) return childMatch;
  }
  return undefined;
}

export function taskIsDirectMatch(roots: TaskTreeNode[], taskId: string | undefined): boolean {
  if (!taskId) return false;
  for (const root of roots) {
    if (root.task.id === taskId) return root.directMatch;
    if (taskIsDirectMatch(root.children, taskId)) return true;
  }
  return false;
}

export function descendantCount(node: TaskTreeNode): number {
  return Math.max(0, node.totalTaskCount - 1);
}

export function ancestorTaskIds(roots: TaskTreeNode[], taskId: string): string[] {
  const visit = (node: TaskTreeNode, ancestors: string[]): string[] | null => {
    if (node.task.id === taskId) return ancestors;
    for (const child of node.children) {
      const result = visit(child, [...ancestors, node.task.id]);
      if (result) return result;
    }
    return null;
  };

  for (const root of roots) {
    const result = visit(root, []);
    if (result) return result;
  }
  return [];
}
