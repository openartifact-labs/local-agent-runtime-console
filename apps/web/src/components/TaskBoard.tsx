import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeTask } from "@openartifact-labs/runtime-contracts";
import {
  ArrowDownUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash2,
  FolderTree,
  GitBranch,
  List,
  ListFilter,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { formatDateTime, shortenPath, taskStatusMeta } from "../lib/format";
import {
  ancestorTaskIds,
  buildTaskTree,
  descendantCount,
  findFirstDirectMatch,
  nodeContainsTask,
  taskIsDirectMatch,
  type TaskMetricFilter,
  type TaskSourceFilter,
  type TaskStatusFilter,
  type TaskTreeNode,
} from "../lib/task-tree";
import { StatusBadge } from "./StatusBadge";

export type SourceFilter = TaskSourceFilter;
export type StatusFilter = TaskStatusFilter;

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

interface VisibleTaskRow {
  node: TaskTreeNode;
  depth: number;
  projectKey?: string;
  projectLabel?: string;
  projectTaskCount?: number;
  projectActiveCount?: number;
  projectAbnormalCount?: number;
}

interface ProjectGroup {
  key: string;
  label: string;
  roots: TaskTreeNode[];
  taskCount: number;
  activeCount: number;
  abnormalCount: number;
  latestActivityAt: string;
}

type TaskViewMode = "tasks" | "projects";

interface TaskBoardProps {
  tasks: RuntimeTask[];
  total: number;
  selectedTaskId?: string;
  query: string;
  statusFilter: StatusFilter;
  sourceFilter: SourceFilter;
  metricFilter?: TaskMetricFilter;
  autoRefresh: boolean;
  loading: boolean;
  syncedAt?: string;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void;
  onSourceChange: (value: SourceFilter) => void;
  onMetricClear: () => void;
  onAutoRefreshChange: (value: boolean) => void;
  onRefresh: () => void;
  onSelect: (task: RuntimeTask) => void;
}

const metricFilterLabels: Record<TaskMetricFilter, string> = {
  active: "运行中 + 等待中",
  managed: "受管任务",
  abnormal: "失败 + 已失联",
};

export function TaskBoard({
  tasks,
  total,
  selectedTaskId,
  query,
  statusFilter,
  sourceFilter,
  metricFilter,
  autoRefresh,
  loading,
  syncedAt,
  onQueryChange,
  onStatusChange,
  onSourceChange,
  onMetricClear,
  onAutoRefreshChange,
  onRefresh,
  onSelect,
}: TaskBoardProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [viewMode, setViewMode] = useState<TaskViewMode>(() => window.localStorage.getItem("local-agent-runtime-console:task-view") === "projects" ? "projects" : "tasks");
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const expandedSelectionRef = useRef<string | undefined>(undefined);
  const taskTree = useMemo(
    () => buildTaskTree(tasks, { query, source: sourceFilter, status: statusFilter, metric: metricFilter }),
    [metricFilter, query, sourceFilter, statusFilter, tasks],
  );
  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const groups = new Map<string, ProjectGroup>();
    for (const root of taskTree.roots) {
      const cwd = root.task.cwd?.trim() || "未记录工作目录";
      const key = `${root.task.providerId}:${cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase("zh-CN")}`;
      const current = groups.get(key) ?? {
        key,
        label: cwd,
        roots: [],
        taskCount: 0,
        activeCount: 0,
        abnormalCount: 0,
        latestActivityAt: root.latestActivityAt,
      };
      current.roots.push(root);
      current.taskCount += root.totalTaskCount;
      current.activeCount += ["running", "waiting"].includes(root.task.status) ? 1 : 0;
      current.abnormalCount += ["failed", "stale"].includes(root.task.status) ? 1 : 0;
      if (root.latestActivityAt > current.latestActivityAt) current.latestActivityAt = root.latestActivityAt;
      groups.set(key, current);
    }
    return [...groups.values()].sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));
  }, [taskTree.roots]);
  const pageUnitCount = viewMode === "projects" ? projectGroups.length : taskTree.roots.length;
  const pageCount = Math.max(1, Math.ceil(pageUnitCount / pageSize));
  const visibleProjectGroups = useMemo(
    () => viewMode === "projects" ? projectGroups.slice((page - 1) * pageSize, page * pageSize) : [],
    [page, pageSize, projectGroups, viewMode],
  );
  const visibleRoots = useMemo(
    () => viewMode === "projects"
      ? visibleProjectGroups.flatMap((group) => group.roots)
      : taskTree.roots.slice((page - 1) * pageSize, page * pageSize),
    [page, pageSize, taskTree.roots, viewMode, visibleProjectGroups],
  );
  const visibleRows = useMemo(() => {
    const rows: VisibleTaskRow[] = [];
    const appendNode = (node: TaskTreeNode, depth: number, project?: ProjectGroup) => {
      rows.push({
        node,
        depth,
        projectKey: project?.key,
        projectLabel: project?.label,
        projectTaskCount: project?.taskCount,
        projectActiveCount: project?.activeCount,
        projectAbnormalCount: project?.abnormalCount,
      });
      const expanded = taskTree.filtersActive
        || expandedTaskIds.has(node.task.id);
      if (expanded) node.children.forEach((child) => appendNode(child, depth + 1, project));
    };
    if (viewMode === "projects") {
      visibleProjectGroups.forEach((group) => group.roots.forEach((root) => appendNode(root, 0, group)));
    } else {
      visibleRoots.forEach((root) => appendNode(root, 0));
    }
    return rows;
  }, [expandedTaskIds, taskTree.filtersActive, viewMode, visibleProjectGroups, visibleRoots]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    setPage(1);
  }, [metricFilter, query, sourceFilter, statusFilter, viewMode]);

  useEffect(() => {
    if (visibleRoots.length === 0) return;
    // 筛选命中子任务时，父任务仅提供归属上下文，详情应定位到当前页首个真实命中任务。
    const selectedOnPage = visibleRoots.some((root) => nodeContainsTask(root, selectedTaskId));
    const selectedMatches = taskIsDirectMatch(visibleRoots, selectedTaskId);
    if (selectedOnPage && (!taskTree.filtersActive || selectedMatches)) return;

    const nextSelection = taskTree.filtersActive
      ? findFirstDirectMatch(visibleRoots)?.task
      : visibleRoots[0]?.task;
    if (nextSelection) onSelect(nextSelection);
  }, [onSelect, selectedTaskId, taskTree.filtersActive, visibleRoots]);

  useEffect(() => {
    if (!selectedTaskId || expandedSelectionRef.current === selectedTaskId) return;
    const ancestors = ancestorTaskIds(taskTree.roots, selectedTaskId);
    const taskExists = taskTree.roots.some((root) => nodeContainsTask(root, selectedTaskId));
    if (!taskExists) return;

    expandedSelectionRef.current = selectedTaskId;
    if (ancestors.length === 0) return;
    setExpandedTaskIds((current) => new Set([...current, ...ancestors]));
  }, [selectedTaskId, taskTree.roots]);

  function resetPage(action: () => void): void {
    setPage(1);
    action();
  }

  function toggleExpanded(taskId: string): void {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  return (
    <section id="global-task-board" className="task-board" aria-labelledby="task-board-title">
      <div className="section-heading">
        <div>
          <div className="section-title-row">
            <h2 id="task-board-title">全局任务</h2>
            <span className="count-label" title={`${taskTree.roots.length} 个任务组`}>{taskTree.filtersActive ? taskTree.matchedTaskCount : total}</span>
          </div>
          <p>汇总当前运行时提供方发现和受管的任务</p>
        </div>
        <div className="sync-note" title={syncedAt ? formatDateTime(syncedAt) : "尚未同步"}>
          {loading ? "正在同步…" : syncedAt ? `更新于 ${formatDateTime(syncedAt)}` : "等待首次同步"}
        </div>
      </div>

      <div className="task-toolbar">
        <label className="search-field">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">搜索任务</span>
          <input
            value={query}
            onChange={(event) => resetPage(() => onQueryChange(event.target.value))}
            placeholder="搜索标题、摘要或目录"
          />
        </label>

        <label className="select-field select-field--status">
          <span className="sr-only">按状态筛选</span>
          <select value={statusFilter} onChange={(event) => resetPage(() => onStatusChange(event.target.value as StatusFilter))}>
            <option value="all">全部状态</option>
            <optgroup label="执行中">
              <option value="running">运行中</option>
              <option value="waiting">等待中</option>
            </optgroup>
            <optgroup label="已结束">
              <option value="completed">已完成</option>
              <option value="interrupted">已中断</option>
            </optgroup>
            <optgroup label="需关注">
              <option value="failed">失败</option>
              <option value="stale">已失联</option>
            </optgroup>
            <optgroup label="其他状态">
              <option value="idle">空闲</option>
              <option value="not_loaded">客户端持有</option>
              <option value="unknown">未识别状态</option>
            </optgroup>
          </select>
        </label>

        <label className="select-field select-field--source">
          <span className="sr-only">按来源筛选</span>
          <select value={sourceFilter} onChange={(event) => resetPage(() => onSourceChange(event.target.value as SourceFilter))}>
            <option value="all">全部来源</option>
            <option value="managed">面板任务</option>
            <option value="discovered">客户端任务</option>
            <option value="subtask">子任务</option>
          </select>
        </label>

        {metricFilter && (
          <button
            className="metric-filter-chip"
            type="button"
            onClick={onMetricClear}
            aria-label={`清除快捷筛选：${metricFilterLabels[metricFilter]}`}
            title="清除快捷筛选"
          >
            <ListFilter size={13} aria-hidden="true" />
            <b>{metricFilterLabels[metricFilter]}</b>
            <X size={13} aria-hidden="true" />
          </button>
        )}

        <div className="task-view-control" role="group" aria-label="任务列表视图">
          <button
            type="button"
            className={viewMode === "tasks" ? "is-active" : undefined}
            aria-pressed={viewMode === "tasks"}
            onClick={() => {
              setViewMode("tasks");
              window.localStorage.setItem("local-agent-runtime-console:task-view", "tasks");
            }}
            title="按最后活动时间查看任务"
          ><List size={14} />任务</button>
          <button
            type="button"
            className={viewMode === "projects" ? "is-active" : undefined}
            aria-pressed={viewMode === "projects"}
            onClick={() => {
              setViewMode("projects");
              window.localStorage.setItem("local-agent-runtime-console:task-view", "projects");
            }}
            title="按 Provider 与工作目录分组"
          ><FolderTree size={14} />项目</button>
        </div>

        <div className="toolbar-spacer" />
        <label className="toggle-control">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => onAutoRefreshChange(event.target.checked)}
          />
          <span className="toggle-track" aria-hidden="true"><span /></span>
          自动刷新
        </label>
        <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} title="立即刷新">
          <RefreshCw size={17} className={loading ? "spin" : undefined} aria-hidden="true" />
          <span className="sr-only">立即刷新</span>
        </button>
      </div>

      <div className="table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th><span className="th-label">任务 <ArrowDownUp size={13} /></span></th>
              <th title="其他 Codex 客户端进程持有的任务无法读取实时运行状态">运行状态</th>
              <th>来源</th>
              <th>工作目录</th>
              <th>最后活动</th>
              <th><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ node, depth, projectKey, projectLabel, projectTaskCount, projectActiveCount, projectAbnormalCount }, index) => {
              const task = node.task;
              const status = taskStatusMeta[task.status];
              const selected = selectedTaskId === task.id;
              const childCount = descendantCount(node);
              const contextOnly = taskTree.filtersActive && !node.directMatch;
              const expanded = taskTree.filtersActive
                || expandedTaskIds.has(task.id);
              const showProjectHeader = viewMode === "projects" && projectKey !== visibleRows[index - 1]?.projectKey;
              return (
                <Fragment key={task.id}>
                {showProjectHeader && (
                  <tr className="project-group-row">
                    <td colSpan={6}>
                      <span><FolderTree size={14} /></span>
                      <strong title={projectLabel}>{shortenPath(projectLabel)}</strong>
                      <small>{projectTaskCount} 个任务</small>
                      {Boolean(projectActiveCount) && <small className="project-group-stat project-group-stat--active">{projectActiveCount} 个活跃</small>}
                      {Boolean(projectAbnormalCount) && <small className="project-group-stat project-group-stat--abnormal">{projectAbnormalCount} 个异常</small>}
                    </td>
                  </tr>
                )}
                <tr
                  className={`${selected ? "is-selected " : ""}${depth > 0 ? "task-row--child " : childCount > 0 ? "task-row--parent " : ""}${contextOnly ? "task-row--context" : ""}`.trim() || undefined}
                  data-status={task.status}
                  data-source={task.relation ? "subtask" : task.source}
                  data-depth={depth}
                  onClick={() => {
                    if (!contextOnly) onSelect(task);
                  }}
                  tabIndex={contextOnly ? -1 : 0}
                  onKeyDown={(event) => {
                    if (!contextOnly && (event.key === "Enter" || event.key === " ")) onSelect(task);
                  }}
                  aria-selected={selected}
                >
                  <td>
                    <div className="task-tree-cell" style={{ paddingLeft: `${Math.min(depth, 3) * 17}px` }}>
                      {node.children.length > 0 ? (
                        <button
                          className="task-tree-toggle"
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "收起" : "展开"}${task.title}的子任务`}
                          title={taskTree.filtersActive ? "筛选期间自动展开匹配的子任务" : expanded ? "收起子任务" : "展开子任务"}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!taskTree.filtersActive) toggleExpanded(task.id);
                          }}
                        >
                          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      ) : <span className="task-tree-spacer" />}
                      <div className={`task-primary${task.relation ? " task-primary--subtask" : ""}`}>
                        <span className="task-icon">
                          {task.relation ? <GitBranch size={16} /> : <Bot size={16} />}
                        </span>
                        <span>
                          <span className="task-name-row">
                            <strong>{task.title || "未命名任务"}</strong>
                            {task.relation && <span className="task-kind-label">子任务</span>}
                            {childCount > 0 && <span className="task-children-count">{childCount} 个子任务</span>}
                            {contextOnly && <span className="task-context-label">关联父任务</span>}
                          </span>
                          <small>
                            {task.relation?.agentName && <b>{task.relation.agentName} · </b>}
                            {task.summary || task.model || "暂无任务摘要"}
                          </small>
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusBadge
                      label={status.label}
                      tone={status.tone}
                      pulse={task.status === "running"}
                      title={status.description}
                    />
                  </td>
                  <td>
                    <span
                      className={`source-label source-label--${task.relation ? "subtask" : task.source}`}
                      title={task.relation ? `父任务：${task.relation.parentTitle ?? task.relation.parentExternalId}` : undefined}
                    >
                      {task.source === "managed" ? <Check size={13} /> : task.relation ? <GitBranch size={13} /> : <CircleSlash2 size={13} />}
                      {task.source === "managed" ? "面板任务" : task.relation ? "子任务" : "客户端任务"}
                    </span>
                  </td>
                  <td><code className="path-value" title={task.cwd}>{shortenPath(task.cwd)}</code></td>
                  <td className="time-value">{formatDateTime(task.lastActivityAt ?? task.updatedAt)}</td>
                  <td><ChevronRight size={16} className="row-chevron" /></td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>

        {!loading && taskTree.roots.length === 0 && (
          <div className="empty-state">
            <Search size={24} aria-hidden="true" />
            <strong>没有匹配的任务</strong>
            <span>调整搜索词或筛选条件后重试</span>
          </div>
        )}
        {loading && tasks.length === 0 && (
          <div className="table-loading" aria-label="正在加载任务">
            <span /><span /><span />
          </div>
        )}
      </div>

      {taskTree.roots.length > 0 && (
        <nav className="task-pagination" aria-label="任务列表分页">
          <div className="page-size-control">
            <span>共 {taskTree.matchedTaskCount} 条 · {viewMode === "projects" ? `${projectGroups.length} 个项目` : `${taskTree.roots.length} 组`}</span>
            <label>
              每页
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value) as PageSize);
                  setPage(1);
                }}
                aria-label="每页任务数量"
              >
                {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
              {viewMode === "projects" ? "项目" : "组"}
            </label>
          </div>
          <div>
            <button
              className="pagination-button"
              type="button"
              disabled={page === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              title="上一页"
              aria-label="上一页"
            >
              <ChevronLeft size={16} />
            </button>
            <strong>第 {page} / {pageCount} 页</strong>
            <button
              className="pagination-button"
              type="button"
              disabled={page === pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              title="下一页"
              aria-label="下一页"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
