import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  LaunchTaskInput,
  ProviderDescriptor,
  ProviderUsageAnalytics,
  ProviderUsageSnapshot,
  RuntimeTask,
  TaskDetail,
} from "@openartifact-labs/runtime-contracts";
import {
  Activity,
  Bell,
  BellOff,
  Bot,
  CircleAlert,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  Gauge,
  Layers3,
  Play,
  ServerCog,
  Wifi,
  WifiOff,
} from "lucide-react";
import { getProviders, getProviderUsage, getProviderUsageAnalytics, getTaskDetail, getTasks, interruptRun, launchTask, openRuntimeStream } from "./api/client";
import { LaunchTaskDrawer } from "./components/LaunchTaskDrawer";
import { StatusBadge } from "./components/StatusBadge";
import { ProviderUsageDialog } from "./components/ProviderUsageDialog";
import { SourceFilter, StatusFilter, TaskBoard } from "./components/TaskBoard";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { ThemeControl } from "./components/ThemeControl";
import { taskMatchesMetric, type TaskMetricFilter } from "./lib/task-tree";
import {
  RuntimeNotificationSender,
  createRuntimeNotificationCandidate,
  type RuntimeNotificationType,
} from "./lib/runtime-notifications";

interface DashboardState {
  providers: ProviderDescriptor[];
  tasks: RuntimeTask[];
  total: number;
  syncedAt?: string;
  usage?: ProviderUsageSnapshot | null;
}

const initialDashboard: DashboardState = {
  providers: [],
  tasks: [],
  total: 0,
};

const UI_STORAGE_KEYS = {
  overviewCollapsed: "local-agent-runtime-console:overview-collapsed",
  workspaceRatio: "local-agent-runtime-console:workspace-ratio",
  notificationsEnabled: "local-agent-runtime-console:notifications-enabled",
} as const;

function storedBoolean(key: string, fallback: boolean): boolean {
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

function remainingPercent(usedPercent?: number): string {
  if (usedPercent === undefined) return "--";
  const remaining = 100 - Math.min(100, Math.max(0, usedPercent));
  return `${Math.round(remaining * 10) / 10}%`;
}

export default function App() {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [metricFilter, setMetricFilter] = useState<TaskMetricFilter>();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [streamConnected, setStreamConnected] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  const [usageAnalyticsLoading, setUsageAnalyticsLoading] = useState(false);
  const [usageAnalyticsDays, setUsageAnalyticsDays] = useState(30);
  const [usageAnalytics, setUsageAnalytics] = useState<ProviderUsageAnalytics>();
  const [usageRefreshError, setUsageRefreshError] = useState<string>();
  const [launchError, setLaunchError] = useState<string>();
  const [overviewCollapsed, setOverviewCollapsed] = useState(() => storedBoolean(UI_STORAGE_KEYS.overviewCollapsed, false));
  const [detailFocused, setDetailFocused] = useState(false);
  const [workspaceRatio, setWorkspaceRatio] = useState(() => storedNumber(UI_STORAGE_KEYS.workspaceRatio, 38, 30, 55));
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => storedBoolean(UI_STORAGE_KEYS.notificationsEnabled, false));
  const [notificationMessage, setNotificationMessage] = useState<string>();
  const streamRefreshTimer = useRef<number | undefined>(undefined);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const workspaceRatioRef = useRef(workspaceRatio);
  const notificationSenderRef = useRef(new RuntimeNotificationSender());
  const previousTaskStatusRef = useRef<Map<string, string> | undefined>(undefined);

  useEffect(() => {
    workspaceRatioRef.current = workspaceRatio;
  }, [workspaceRatio]);

  useEffect(() => {
    const previous = previousTaskStatusRef.current;
    const next = new Map(dashboard.tasks.map((task) => [task.id, String(task.status)]));
    previousTaskStatusRef.current = next;
    if (!previous || !notificationsEnabled) return;

    const typeByStatus: Partial<Record<string, RuntimeNotificationType>> = {
      completed: "completed",
      failed: "failed",
      stale: "disconnected",
      waiting_user: "waiting_user",
      waiting_approval: "waiting_approval",
    };
    for (const task of dashboard.tasks) {
      const previousStatus = previous.get(task.id);
      const notificationType = typeByStatus[String(task.status)];
      if (!previousStatus || previousStatus === task.status || !notificationType) continue;
      const candidate = createRuntimeNotificationCandidate({
        type: notificationType,
        taskId: task.id,
        runId: task.activeRunId ?? task.externalId,
        providerId: task.providerId,
        projectId: task.cwd ?? `${task.providerId}:unknown-project`,
      });
      const result = notificationSenderRef.current.send(candidate, { enabled: true });
      if (result.sent && "onclick" in result.notification) {
        (result.notification as Notification).onclick = () => {
          window.focus();
          setSelectedTaskId(task.id);
          result.notification.close();
        };
      }
    }
  }, [dashboard.tasks, notificationsEnabled]);

  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) setOverviewLoading(true);
    try {
      const providers = await getProviders();
      const [taskResponse, usage] = await Promise.all([
        getTasks(),
        providers[0]?.capabilities.tokenUsage
          ? getProviderUsage(providers[0].id).catch(() => null)
          : Promise.resolve(null),
      ]);
      setDashboard({
        providers,
        tasks: taskResponse.items,
        total: taskResponse.total,
        syncedAt: taskResponse.syncedAt,
        usage,
      });
      setOverviewError(undefined);
      setSelectedTaskId((current) => {
        if (current && taskResponse.items.some((task) => task.id === current)) return current;
        return taskResponse.items[0]?.id;
      });
    } catch (error) {
      setOverviewError(getErrorMessage(error));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (taskId: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    try {
      const nextDetail = await getTaskDetail(taskId);
      setDetail(nextDetail);
      setDetailError(undefined);
    } catch (error) {
      setDetailError(getErrorMessage(error));
      setDetail((current) => (current?.id === taskId ? current : undefined));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedTaskId) {
      setDetail(undefined);
      return;
    }
    void loadDetail(selectedTaskId);
  }, [loadDetail, selectedTaskId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      void loadOverview(true);
      if (selectedTaskId) void loadDetail(selectedTaskId, true);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, loadDetail, loadOverview, selectedTaskId]);

  useEffect(() => {
    if (!autoRefresh) {
      setStreamConnected(false);
      return;
    }
    const close = openRuntimeStream(
      () => {
        window.clearTimeout(streamRefreshTimer.current);
        // 将短时间内连续到达的 SSE 事件合并为一次刷新，避免并发请求挤压后端。
        streamRefreshTimer.current = window.setTimeout(() => {
          void loadOverview(true);
          if (selectedTaskId) void loadDetail(selectedTaskId, true);
        }, 250);
      },
      setStreamConnected,
    );
    return () => {
      window.clearTimeout(streamRefreshTimer.current);
      close();
      setStreamConnected(false);
    };
  }, [autoRefresh, loadDetail, loadOverview, selectedTaskId]);

  const stats = useMemo(() => {
    return {
      active: dashboard.tasks.filter((task) => taskMatchesMetric(task, "active")).length,
      managed: dashboard.tasks.filter((task) => taskMatchesMetric(task, "managed")).length,
      abnormal: dashboard.tasks.filter((task) => taskMatchesMetric(task, "abnormal")).length,
      providers: dashboard.providers.filter((provider) => provider.connected).length,
    };
  }, [dashboard.providers, dashboard.tasks]);

  function handleOverviewMetric(metric: TaskMetricFilter): void {
    setMetricFilter((current) => current === metric ? undefined : metric);
    setQuery("");
    setStatusFilter("all");
    setSourceFilter("all");
    window.requestAnimationFrame(() => {
      document.getElementById("global-task-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function handleLaunch(input: LaunchTaskInput) {
    setLaunching(true);
    setLaunchError(undefined);
    try {
      const result = await launchTask(input);
      setDrawerOpen(false);
      setSelectedTaskId(result.task.id);
      await loadOverview(true);
      await loadDetail(result.task.id);
    } catch (error) {
      setLaunchError(getErrorMessage(error));
    } finally {
      setLaunching(false);
    }
  }

  async function handleInterrupt(runId: string) {
    if (!selectedTaskId) return;
    setInterrupting(true);
    try {
      await interruptRun(runId);
      await Promise.all([loadOverview(true), loadDetail(selectedTaskId, true)]);
    } catch (error) {
      setDetailError(getErrorMessage(error));
    } finally {
      setInterrupting(false);
    }
  }

  async function handleUsageRefresh(): Promise<void> {
    const provider = dashboard.providers.find((item) => item.capabilities.tokenUsage);
    if (!provider || usageRefreshing) return;
    setUsageRefreshing(true);
    setUsageAnalyticsLoading(true);
    setUsageRefreshError(undefined);
    const [usageResult, analyticsResult] = await Promise.allSettled([
      getProviderUsage(provider.id),
      getProviderUsageAnalytics(provider.id, usageAnalyticsDays),
    ]);
    if (usageResult.status === "fulfilled") {
      setDashboard((current) => ({ ...current, usage: usageResult.value }));
    }
    if (analyticsResult.status === "fulfilled") setUsageAnalytics(analyticsResult.value);
    const errors = [usageResult, analyticsResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => getErrorMessage(result.reason));
    if (errors.length > 0) setUsageRefreshError(errors.join("；"));
    setUsageRefreshing(false);
    setUsageAnalyticsLoading(false);
  }

  async function handleAnalyticsDaysChange(days: number): Promise<void> {
    const provider = dashboard.providers.find((item) => item.capabilities.tokenUsage);
    setUsageAnalyticsDays(days);
    if (!provider || usageAnalyticsLoading) return;
    setUsageAnalyticsLoading(true);
    setUsageRefreshError(undefined);
    try {
      setUsageAnalytics(await getProviderUsageAnalytics(provider.id, days));
    } catch (error) {
      setUsageRefreshError(getErrorMessage(error));
    } finally {
      setUsageAnalyticsLoading(false);
    }
  }

  const providerSummary = dashboard.providers.length === 0
    ? "暂无 Provider"
    : `${stats.providers}/${dashboard.providers.length} 已连接`;

  function toggleOverview(): void {
    setOverviewCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(UI_STORAGE_KEYS.overviewCollapsed, String(next));
      return next;
    });
  }

  function beginWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (detailFocused || !workspaceRef.current) return;
    event.preventDefault();
    const bounds = workspaceRef.current.getBoundingClientRect();
    document.body.classList.add("is-resizing-workspace");

    const handleMove = (pointerEvent: PointerEvent) => {
      // 限制任务导航区宽度，避免拖动后任一工作区失去基本可用空间。
      const next = Math.min(55, Math.max(30, (pointerEvent.clientX - bounds.left) / bounds.width * 100));
      workspaceRatioRef.current = next;
      setWorkspaceRatio(next);
    };
    const handleEnd = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      document.body.classList.remove("is-resizing-workspace");
      window.localStorage.setItem(UI_STORAGE_KEYS.workspaceRatio, String(Math.round(workspaceRatioRef.current * 10) / 10));
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd, { once: true });
  }

  async function toggleNotifications(): Promise<void> {
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      setNotificationMessage("系统通知已关闭");
      window.localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, "false");
      return;
    }
    const permission = await notificationSenderRef.current.requestPermission();
    if (permission !== "granted") {
      setNotificationMessage(permission === "unsupported" ? "当前浏览器不支持系统通知" : "浏览器未授予通知权限");
      return;
    }
    setNotificationsEnabled(true);
    setNotificationMessage("关键任务通知已开启");
    window.localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, "true");
  }

  const overviewCompact = overviewCollapsed || detailFocused;
  const workspaceStyle = { "--task-pane-width": `${workspaceRatio}%` } as CSSProperties;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark"><Activity size={21} /></span>
          <div>
            <h1>Local Agent 运行观测台</h1>
            <p>统一任务发现、发起与深度观测</p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className={`icon-button header-notification-button${notificationsEnabled ? " is-active" : ""}`}
            type="button"
            onClick={() => void toggleNotifications()}
            title={notificationMessage ?? (notificationsEnabled ? "关闭关键任务系统通知" : "开启关键任务系统通知")}
            aria-pressed={notificationsEnabled}
          >
            {notificationsEnabled ? <Bell size={16} /> : <BellOff size={16} />}
            <span className="sr-only">{notificationsEnabled ? "关闭系统通知" : "开启系统通知"}</span>
          </button>
          <ThemeControl />
          <div className={`connection-state${streamConnected ? " is-live" : " is-syncing"}`} title={streamConnected ? "实时事件流已连接" : "实时事件流未连接，将使用定时刷新"}>
            {streamConnected ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{streamConnected ? "实时连接" : "定时同步"}</span>
          </div>
          <button className="button button--primary" type="button" onClick={() => setDrawerOpen(true)}>
            <Play size={17} /><span className="button-label">发起任务</span>
          </button>
        </div>
      </header>

      <main>
        <section className={`overview-band${overviewCompact ? " overview-band--compact" : ""}`} aria-label="运行时总览">
          <button
            className="overview-collapse-button"
            type="button"
            onClick={toggleOverview}
            title={overviewCollapsed ? "展开运行时总览" : "收起为紧凑状态条"}
            aria-expanded={!overviewCompact}
          >
            {overviewCompact ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            <span className="sr-only">{overviewCompact ? "展开运行时总览" : "收起运行时总览"}</span>
          </button>
          <div className="provider-overview" data-connected={dashboard.providers[0]?.connected ? "true" : "false"}>
            <div className="eyebrow"><ServerCog size={14} />运行时提供方</div>
            <div className="provider-title-row">
              <h2>{dashboard.providers[0]?.name ?? "Codex Provider"}</h2>
              <StatusBadge
                label={dashboard.providers[0]?.connected ? "运行正常" : overviewError ? "服务离线" : "等待连接"}
                tone={dashboard.providers[0]?.connected ? "green" : overviewError ? "red" : "amber"}
                pulse={dashboard.providers[0]?.connected}
              />
            </div>
            <p>{dashboard.providers[0]?.message ?? "Provider 抽象已启用，当前接入 Codex 运行时。"}</p>
            <div className="provider-foot">
              <span><Bot size={14} />{dashboard.providers[0]?.kind ?? "codex"}</span>
              <span><Database size={14} />{providerSummary}</span>
              {dashboard.providers[0]?.version && <span>v{dashboard.providers[0].version}</span>}
            </div>
          </div>

          <div className="overview-stats">
            <button
              className={`overview-stat overview-stat--action${metricFilter === "active" ? " is-active" : ""}`}
              type="button"
              aria-pressed={metricFilter === "active"}
              aria-controls="global-task-board"
              onClick={() => handleOverviewMetric("active")}
            >
              <span><Activity size={16} />运行中</span>
              <strong>{stats.active}</strong>
              <small>本机 Codex 活跃任务</small>
            </button>
            <button
              className={`overview-stat overview-stat--action${metricFilter === "managed" ? " is-active" : ""}`}
              type="button"
              aria-pressed={metricFilter === "managed"}
              aria-controls="global-task-board"
              onClick={() => handleOverviewMetric("managed")}
            >
              <span><Layers3 size={16} />受管任务</span>
              <strong>{stats.managed}</strong>
              <small>支持深度观测</small>
            </button>
            <button
              className={`overview-stat overview-stat--action${stats.abnormal > 0 ? " overview-stat--danger" : ""}${metricFilter === "abnormal" ? " is-active" : ""}`}
              type="button"
              aria-pressed={metricFilter === "abnormal"}
              aria-controls="global-task-board"
              onClick={() => handleOverviewMetric("abnormal")}
            >
              <span><CircleAlert size={16} />异常任务</span>
              <strong className={stats.abnormal > 0 ? "text-danger" : undefined}>{stats.abnormal}</strong>
              <small>需要人工关注</small>
            </button>
            <div className="overview-stat">
              <span><Clock3 size={16} />任务总量</span>
              <strong>{dashboard.total}</strong>
              <small>当前已发现</small>
            </div>
            <button
              className="overview-stat overview-stat--action overview-stat--usage"
              type="button"
              disabled={!dashboard.usage}
              onClick={() => {
                setUsageOpen(true);
                void handleUsageRefresh();
              }}
              title={dashboard.usage ? "查看 Codex Token 与额度明细" : "等待 Codex 返回 Token 用量"}
            >
              <span><Gauge size={16} />Codex 剩余</span>
              <strong>{remainingPercent(dashboard.usage?.rateLimit?.usedPercent)}</strong>
              <small>{dashboard.usage ? "账号周期额度 · 查看明细" : "等待额度数据"}</small>
            </button>
          </div>
        </section>

        {overviewError && (
          <div className="global-alert" role="alert">
            <CircleAlert size={17} />
            <span><strong>运行时服务暂不可用</strong>{overviewError}</span>
            <button type="button" onClick={() => void loadOverview()}>重新连接</button>
          </div>
        )}

        <div
          ref={workspaceRef}
          className={`workspace-layout${detailFocused ? " workspace-layout--detail-focused" : ""}`}
          style={workspaceStyle}
        >
          <TaskBoard
            tasks={dashboard.tasks}
            total={dashboard.total}
            selectedTaskId={selectedTaskId}
            query={query}
            statusFilter={statusFilter}
            sourceFilter={sourceFilter}
            metricFilter={metricFilter}
            autoRefresh={autoRefresh}
            loading={overviewLoading}
            syncedAt={dashboard.syncedAt}
            onQueryChange={(value) => {
              setMetricFilter(undefined);
              setQuery(value);
            }}
            onStatusChange={(value) => {
              setMetricFilter(undefined);
              setStatusFilter(value);
            }}
            onSourceChange={(value) => {
              setMetricFilter(undefined);
              setSourceFilter(value);
            }}
            onMetricClear={() => setMetricFilter(undefined)}
            onAutoRefreshChange={setAutoRefresh}
            onRefresh={() => void loadOverview()}
            onSelect={(task) => setSelectedTaskId(task.id)}
          />
          <div
            className="workspace-resizer"
            role="separator"
            aria-label="调整任务列表与详情宽度"
            aria-orientation="vertical"
            aria-valuemin={30}
            aria-valuemax={55}
            aria-valuenow={Math.round(workspaceRatio)}
            tabIndex={detailFocused ? -1 : 0}
            onPointerDown={beginWorkspaceResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              const delta = event.key === "ArrowLeft" ? -2 : 2;
              const next = Math.min(55, Math.max(30, workspaceRatio + delta));
              setWorkspaceRatio(next);
              window.localStorage.setItem(UI_STORAGE_KEYS.workspaceRatio, String(next));
            }}
          ><span /></div>
          <TaskDetailPanel
            detail={detail}
            loading={detailLoading}
            error={detailError}
            interrupting={interrupting}
            focused={detailFocused}
            onFocusToggle={() => setDetailFocused((current) => !current)}
            onInterrupt={handleInterrupt}
          />
        </div>
      </main>

      <LaunchTaskDrawer
        open={drawerOpen}
        providers={dashboard.providers}
        submitting={launching}
        error={launchError}
        onClose={() => {
          if (!launching) setDrawerOpen(false);
        }}
        onSubmit={handleLaunch}
      />
      {usageOpen && dashboard.usage && (
        <ProviderUsageDialog
          usage={dashboard.usage}
          analytics={usageAnalytics}
          analyticsLoading={usageAnalyticsLoading}
          analyticsDays={usageAnalyticsDays}
          refreshing={usageRefreshing}
          refreshError={usageRefreshError}
          onRefresh={handleUsageRefresh}
          onAnalyticsDaysChange={(days) => void handleAnalyticsDaysChange(days)}
          onClose={() => setUsageOpen(false)}
        />
      )}
    </div>
  );
}
