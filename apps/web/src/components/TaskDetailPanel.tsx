import type { RuntimeEvent, RuntimeRun, TaskDetail } from "@openartifact-labs/runtime-contracts";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock3,
  Copy,
  Cpu,
  Database,
  Eye,
  FileCode2,
  FolderOpen,
  GitBranch,
  HardDriveDownload,
  Layers3,
  ListFilter,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Pause,
  Play,
  Radio,
  Search,
  Square,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  eventLevelLabel,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTime,
  runStatusMeta,
  taskStatusMeta,
} from "../lib/format";
import {
  buildEventObservation,
  extractStructuredEventDetails,
  type EventCategory,
  type EventObservationMode,
} from "../lib/event-observation";
import { StatusBadge } from "./StatusBadge";

interface TaskDetailPanelProps {
  detail?: TaskDetail;
  loading: boolean;
  error?: string;
  interrupting: boolean;
  focused: boolean;
  onFocusToggle: () => void;
  onInterrupt: (runId: string) => Promise<void>;
}

const DETAIL_SPLIT_STORAGE_KEY = "local-agent-runtime-console:detail-split-ratio";

function storedSplitRatio(): number {
  const value = Number(window.localStorage.getItem(DETAIL_SPLIT_STORAGE_KEY));
  return Number.isFinite(value) ? Math.min(68, Math.max(38, value)) : 55;
}

const categoryMeta: Record<RuntimeEvent["category"], { label: string; icon: typeof Circle }> = {
  lifecycle: { label: "生命周期", icon: Activity },
  message: { label: "消息", icon: MessageSquareText },
  command: { label: "命令", icon: TerminalSquare },
  tool: { label: "工具", icon: Wrench },
  file: { label: "文件", icon: FileCode2 },
  system: { label: "系统", icon: Cpu },
};

function getCurrentRun(detail: TaskDetail): RuntimeRun | undefined {
  if (detail.activeRunId) {
    const active = detail.runs.find((run) => run.id === detail.activeRunId);
    if (active) return active;
  }
  return [...detail.runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

function Metrics({ run, tokenExpanded, onTokenToggle }: { run?: RuntimeRun; tokenExpanded: boolean; onTokenToggle: () => void }) {
  const totalTokens = run?.totalTokens
    ?? (run?.inputTokens !== undefined || run?.outputTokens !== undefined
      ? (run.inputTokens ?? 0) + (run.outputTokens ?? 0)
      : undefined);
  const cacheHitRate = run?.inputTokens
    ? (run.cachedInputTokens ?? 0) / run.inputTokens * 100
    : undefined;
  const metrics = [
    { label: "总耗时", value: formatDuration(run?.durationMs), icon: Clock3 },
    { label: "Token 总量", value: formatNumber(totalTokens), icon: Braces, expandable: true },
    { label: "缓存命中率", value: cacheHitRate === undefined ? "--" : `${Math.round(cacheHitRate * 10) / 10}%`, icon: Database },
    { label: "工具调用", value: formatNumber(run?.toolCallCount), icon: Wrench },
  ];

  return (
    <div className="metric-strip">
      {metrics.map((metric) => metric.expandable ? (
        <button
          className={`metric-item metric-item--action${tokenExpanded ? " is-active" : ""}`}
          key={metric.label}
          type="button"
          onClick={onTokenToggle}
          aria-expanded={tokenExpanded}
          title={tokenExpanded ? "收起 Token 明细" : "展开 Token 明细"}
        >
          <metric.icon size={16} aria-hidden="true" />
          <span>{metric.label}{tokenExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
          <strong>{metric.value}</strong>
        </button>
      ) : (
        <div className="metric-item" key={metric.label}>
          <metric.icon size={16} aria-hidden="true" />
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
        </div>
      ))}
    </div>
  );
}

function TokenBreakdown({ run }: { run?: RuntimeRun }) {
  const uncachedInput = run?.inputTokens !== undefined
    ? Math.max(0, run.inputTokens - (run.cachedInputTokens ?? 0))
    : undefined;
  const items = [
    { label: "输入 Token", value: run?.inputTokens, icon: Braces },
    { label: "缓存输入", value: run?.cachedInputTokens, icon: Database },
    { label: "非缓存输入", value: uncachedInput, icon: HardDriveDownload },
    { label: "输出 Token", value: run?.outputTokens, icon: MessageSquareText },
    { label: "推理 Token", value: run?.reasoningOutputTokens, icon: BrainCircuit },
  ];

  return (
    <section className="token-breakdown" aria-label="本次运行 Token 用量明细">
      <div className="token-breakdown-heading">
        <strong>Token 用量明细</strong>
        <span>缓存输入包含在输入中，推理 Token 包含在输出中</span>
      </div>
      <div className="token-breakdown-items">
        {items.map((item) => (
          <div key={item.label}>
            <span><item.icon size={13} />{item.label}</span>
            <strong>{formatNumber(item.value)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function Timeline({ events, expanded }: { events: RuntimeEvent[]; expanded: boolean }) {
  const timelineEvents = expanded ? events.slice(-80) : events.slice(-5);
  if (timelineEvents.length === 0) {
    return <div className="inline-empty">当前运行还没有时间线事件</div>;
  }

  return (
    <ol className="timeline-list">
      {timelineEvents.map((event, index) => {
        const meta = categoryMeta[event.category];
        const Icon = meta.icon;
        const completed = index < timelineEvents.length - 1;
        return (
          <li key={event.id} className={`timeline-item timeline-item--${event.level}`}>
            <div className="timeline-marker">
              {completed ? <CheckCircle2 size={17} /> : <Radio size={17} />}
            </div>
            <div className="timeline-content">
              <div className="timeline-title">
                <Icon size={14} aria-hidden="true" />
                <strong>{event.title}</strong>
              </div>
              <span>{formatTime(event.occurredAt)}{event.durationMs !== undefined ? ` · ${formatDuration(event.durationMs)}` : ""}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EventLog({ events }: { events: RuntimeEvent[] }) {
  const [selectedEvent, setSelectedEvent] = useState<RuntimeEvent>();
  const [mode, setMode] = useState<EventObservationMode>("key");
  const [category, setCategory] = useState<"all" | EventCategory>("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [following, setFollowing] = useState(true);
  const [displayedEvents, setDisplayedEvents] = useState(() => events.slice(-500));
  const [unreadCount, setUnreadCount] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const logRef = useRef<HTMLDivElement>(null);
  const closeDialog = useCallback(() => setSelectedEvent(undefined), []);

  useEffect(() => {
    const cappedEvents = events.slice(-500);
    if (paused) {
      const displayedIds = new Set(displayedEvents.map((event) => event.id));
      setUnreadCount(cappedEvents.filter((event) => !displayedIds.has(event.id)).length);
      return;
    }
    setDisplayedEvents(cappedEvents);
    setUnreadCount(0);
    if (following) window.requestAnimationFrame(() => logRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  }, [events, following, paused]);

  const observedItems = buildEventObservation(displayedEvents, {
    mode,
    categories: category === "all" ? undefined : [category],
    query,
  }).reverse();

  function resume(): void {
    setDisplayedEvents(events.slice(-500));
    setUnreadCount(0);
    setPaused(false);
    setFollowing(true);
    window.requestAnimationFrame(() => logRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function renderEvent(event: RuntimeEvent, grouped = false) {
    const meta = categoryMeta[event.category];
    const Icon = meta.icon;
    return (
      <button
        className={`event-row event-row--${event.level}${grouped ? " event-row--grouped" : ""}`}
        key={event.id}
        type="button"
        onClick={() => setSelectedEvent(event)}
        aria-label={`查看事件详情：${event.title}`}
      >
        <time>{formatTime(event.occurredAt)}</time>
        <span className="event-icon"><Icon size={14} /></span>
        <div className="event-copy">
          <div>
            <strong>{event.title}</strong>
            <span>{meta.label} · {eventLevelLabel[event.level]}</span>
          </div>
          {event.detail && <p className="event-preview">{event.detail}</p>}
        </div>
        <span className="event-duration">{formatDuration(event.durationMs)}</span>
        <Eye className="event-open-icon" size={15} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="event-observation">
      <div className="event-toolbar">
        <div className="event-mode-control" role="group" aria-label="事件显示模式">
          <button type="button" className={mode === "key" ? "is-active" : undefined} aria-pressed={mode === "key"} onClick={() => setMode("key")}>关键事件</button>
          <button type="button" className={mode === "full" ? "is-active" : undefined} aria-pressed={mode === "full"} onClick={() => setMode("full")}>完整事件</button>
        </div>
        <label className="event-category-filter">
          <ListFilter size={14} />
          <span className="sr-only">按事件类型筛选</span>
          <select value={category} onChange={(event) => setCategory(event.target.value as "all" | EventCategory)}>
            <option value="all">全部类型</option>
            {Object.entries(categoryMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
          </select>
        </label>
        <label className="event-search">
          <Search size={14} />
          <span className="sr-only">搜索事件</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志" />
        </label>
        <button className={`icon-button icon-button--compact${paused ? " is-active" : ""}`} type="button" onClick={() => paused ? resume() : setPaused(true)} title={paused ? "继续显示实时事件" : "暂停界面更新，后台仍继续接收"}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
          <span className="sr-only">{paused ? "继续显示事件" : "暂停显示事件"}</span>
        </button>
      </div>

      {(paused || !following) && (
        <div className="event-follow-bar">
          <span>{paused ? `界面已暂停${unreadCount > 0 ? ` · 新增 ${unreadCount} 条` : ""}` : "已离开最新事件"}</span>
          <button type="button" onClick={paused ? resume : () => {
            setFollowing(true);
            logRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          }}>{paused ? "继续" : "回到最新"}</button>
        </div>
      )}

      <div
        ref={logRef}
        className="event-log"
        role="log"
        aria-label="运行事件日志"
        onScroll={(event) => {
          if (!paused) setFollowing(event.currentTarget.scrollTop < 8);
        }}
      >
        {observedItems.length === 0 && <div className="inline-empty">没有匹配的事件日志</div>}
        {observedItems.map((item) => item.kind === "event" ? renderEvent(item.event) : (
          <div className="event-aggregate" key={item.id}>
            <button
              className="event-aggregate-toggle"
              type="button"
              aria-expanded={expandedGroups.has(item.id)}
              onClick={() => setExpandedGroups((current) => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id);
                else next.add(item.id);
                return next;
              })}
            >
              <Layers3 size={15} />
              <span><strong>{item.title}</strong><small>{formatTime(item.startedAt)} – {formatTime(item.endedAt)}</small></span>
              {expandedGroups.has(item.id) ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {expandedGroups.has(item.id) && <div className="event-aggregate-items">{[...item.events].reverse().map((event) => renderEvent(event, true))}</div>}
          </div>
        ))}
      </div>
      {selectedEvent && <EventDetailDialog event={selectedEvent} onClose={closeDialog} />}
    </div>
  );
}

function eventContent(event: RuntimeEvent): string {
  if (event.detail?.trim()) return event.detail.trim();
  if (event.payload) return JSON.stringify(event.payload, null, 2);
  return "该事件没有记录额外详情。";
}

function EventDetailDialog({ event, onClose }: { event: RuntimeEvent; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const meta = categoryMeta[event.category];
  const Icon = meta.icon;
  const structured = extractStructuredEventDetails(event);
  const content = structured.content ?? eventContent(event);
  const codeLike = event.category === "command" || event.category === "tool" || event.category === "file";
  const copyText = [
    ...structured.fields.map((field) => `${field.label}: ${field.value}`),
    ...structured.sections.map((section) => `${section.label}:\n${section.value}`),
    content,
  ].join("\n\n");

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  async function copyContent(): Promise<void> {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return createPortal(
    <div className="event-dialog-backdrop" onMouseDown={(mouseEvent) => {
      if (mouseEvent.target === mouseEvent.currentTarget) onClose();
    }}>
      <section
        className="event-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-dialog-title"
      >
        <header className="event-dialog-header">
          <div className={`event-dialog-icon event-dialog-icon--${event.level}`}><Icon size={18} /></div>
          <div>
            <h3 id="event-dialog-title">{event.title}</h3>
            <span>{meta.label} · {eventLevelLabel[event.level]}</span>
          </div>
          <div className="event-dialog-actions">
            <button className="icon-button" type="button" onClick={() => void copyContent()} title="复制事件内容">
              {copied ? <Check size={17} /> : <Copy size={17} />}
              <span className="sr-only">复制事件内容</span>
            </button>
            <button ref={closeButtonRef} className="icon-button" type="button" onClick={onClose} title="关闭详情">
              <X size={18} />
              <span className="sr-only">关闭详情</span>
            </button>
          </div>
        </header>

        <div className="event-dialog-meta">
          <span><Clock3 size={14} />{formatDateTime(event.occurredAt)}</span>
          <span>{event.durationMs === undefined ? "未记录耗时" : `耗时 ${formatDuration(event.durationMs)}`}</span>
        </div>

        <div className="event-dialog-body">
          <dl className="event-dialog-fields">
            {structured.fields.map((field) => (
              <div key={field.key}>
                <dt>{field.label}</dt>
                <dd>{String(field.value)}</dd>
              </div>
            ))}
          </dl>
          {structured.sections.length > 0 && (
            <div className="event-dialog-sections">
              {structured.sections.map((section) => (
                <section key={section.key} className={`event-dialog-section event-dialog-section--${section.format}`}>
                  <h4>{section.label}</h4>
                  {section.format === "text" ? <p>{section.value}</p> : <pre>{section.value}</pre>}
                </section>
              ))}
            </div>
          )}
          <div className={`event-dialog-content${codeLike ? " event-dialog-content--code" : ""}`}>{content}</div>
          {structured.payload && (
            <details className="event-dialog-payload">
              <summary>查看脱敏后的原始事件数据</summary>
              <pre>{JSON.stringify(structured.payload, null, 2)}</pre>
            </details>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function TaskDetailPanel({ detail, loading, error, interrupting, focused, onFocusToggle, onInterrupt }: TaskDetailPanelProps) {
  const [tokenExpanded, setTokenExpanded] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [detailSplitRatio, setDetailSplitRatio] = useState(storedSplitRatio);
  const [focusedPane, setFocusedPane] = useState<"events" | "output">();
  const [mobileTab, setMobileTab] = useState<"events" | "output">("events");
  const detailGridRef = useRef<HTMLDivElement>(null);
  const detailSplitRatioRef = useRef(detailSplitRatio);

  useEffect(() => {
    detailSplitRatioRef.current = detailSplitRatio;
  }, [detailSplitRatio]);

  useEffect(() => {
    setTokenExpanded(false);
    setTimelineExpanded(false);
    setFocusedPane(undefined);
    setMobileTab("events");
  }, [detail?.id]);

  function beginDetailResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (focusedPane || !detailGridRef.current) return;
    event.preventDefault();
    const bounds = detailGridRef.current.getBoundingClientRect();
    document.body.classList.add("is-resizing-workspace");
    const handleMove = (pointerEvent: PointerEvent) => {
      const next = Math.min(68, Math.max(38, (pointerEvent.clientX - bounds.left) / bounds.width * 100));
      detailSplitRatioRef.current = next;
      setDetailSplitRatio(next);
    };
    const handleEnd = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      document.body.classList.remove("is-resizing-workspace");
      window.localStorage.setItem(DETAIL_SPLIT_STORAGE_KEY, String(Math.round(detailSplitRatioRef.current * 10) / 10));
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd, { once: true });
  }

  if (loading && !detail) {
    return (
      <aside className="detail-panel detail-panel--center" aria-label="正在加载任务详情">
        <div className="detail-loader"><span /><span /><span /></div>
        <p>正在加载深度观测数据</p>
      </aside>
    );
  }

  if (error && !detail) {
    return (
      <aside className="detail-panel detail-panel--center">
        <AlertTriangle size={28} />
        <h2>暂时无法读取详情</h2>
        <p>{error}</p>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="detail-panel detail-panel--center">
        <Activity size={28} />
        <h2>选择一项任务</h2>
        <p>查看运行时间线、事件日志、输出和指标</p>
      </aside>
    );
  }

  const currentRun = getCurrentRun(detail);
  const taskStatus = taskStatusMeta[detail.status];
  const runStatus = currentRun ? runStatusMeta[currentRun.status] : undefined;

  return (
    <aside
      className="detail-panel"
      aria-labelledby="detail-title"
      data-status={detail.status}
      data-source={detail.source}
    >
      <div className="detail-header">
        <div className="detail-heading-copy">
          <div className="detail-title-row">
            <h2 id="detail-title">{detail.title || "未命名任务"}</h2>
            <StatusBadge
              label={taskStatus.label}
              tone={taskStatus.tone}
              pulse={detail.status === "running"}
              title={taskStatus.description}
            />
          </div>
          <p>{detail.summary || "该任务暂未生成摘要"}</p>
          <div className="detail-meta">
            <span title={detail.cwd}><FolderOpen size={14} />{detail.cwd || "未记录目录"}</span>
            <span><Cpu size={14} />{detail.model || "默认模型"}</span>
            <span><Clock3 size={14} />{formatDateTime(detail.lastActivityAt ?? detail.updatedAt)}</span>
            {detail.relation && (
              <span title={detail.relation.parentExternalId}>
                <GitBranch size={14} />
                子任务 · {detail.relation.agentName ?? "未命名 Agent"} · 父任务：{detail.relation.parentTitle ?? detail.relation.parentExternalId}
              </span>
            )}
          </div>
        </div>
        <div className="detail-header-actions">
          <button
            className="icon-button detail-focus-button"
            type="button"
            onClick={onFocusToggle}
            title={focused ? "退出详情聚焦" : "聚焦任务详情"}
          >
            {focused ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            <span className="sr-only">{focused ? "退出详情聚焦" : "聚焦任务详情"}</span>
          </button>
          {runStatus && <StatusBadge label={`本次运行：${runStatus.label}`} tone={runStatus.tone} />}
          {detail.source === "managed" && currentRun?.status === "running" && (
            <button
              className="button button--danger"
              type="button"
              disabled={interrupting}
              onClick={() => void onInterrupt(currentRun.id)}
            >
              {interrupting ? <LoaderCircle size={15} className="spin" /> : <Square size={14} />}
              {interrupting ? "正在中断" : "中断运行"}
            </button>
          )}
        </div>
      </div>

      <Metrics run={currentRun} tokenExpanded={tokenExpanded} onTokenToggle={() => setTokenExpanded((current) => !current)} />
      {tokenExpanded && <TokenBreakdown run={currentRun} />}

      {detail.source === "discovered" && detail.events.length === 0 && (
        <div className="notice-bar">
          <Circle size={15} />
          {detail.status === "not_loaded" ? (
            <span><strong>实时状态不可见。</strong>该任务没有可读取的本机会话记录，当前仅能展示任务概览。</span>
          ) : (
            <span><strong>仅提供会话级观测。</strong>已从 Codex 本机会话记录恢复最新状态和提问；从本面板发起的任务才支持完整事件与输出观测。</span>
          )}
        </div>
      )}
      {detail.status === "stale" && (
        <div className="notice-bar">
          <AlertTriangle size={15} />
          <span><strong>任务已失联。</strong>最后一轮没有记录结束事件，且超过 3 分钟没有新活动；Codex 客户端可能已经关闭。</span>
        </div>
      )}
      {currentRun?.errorMessage && (
        <div className="notice-bar notice-bar--error"><AlertTriangle size={15} />{currentRun.errorMessage}</div>
      )}

      <section className="observation-section">
        <div className="subsection-heading">
          <div><h3>执行时间线</h3><span>{detail.events.length} 个事件</span></div>
          <div className="subsection-actions">
            {currentRun?.startedAt && <time>开始于 {formatDateTime(currentRun.startedAt)}</time>}
            {detail.events.length > 5 && (
              <button className="text-button" type="button" onClick={() => setTimelineExpanded((current) => !current)}>
                {timelineExpanded ? "收起时间线" : "展开完整时间线"}
                {timelineExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </div>
        </div>
        <Timeline events={detail.events} expanded={timelineExpanded} />
      </section>

      <div className="detail-mobile-tabs" role="tablist" aria-label="任务观测内容">
        <button type="button" role="tab" aria-selected={mobileTab === "events"} onClick={() => setMobileTab("events")}>事件日志</button>
        <button type="button" role="tab" aria-selected={mobileTab === "output"} onClick={() => setMobileTab("output")}>输出预览</button>
      </div>

      <div
        ref={detailGridRef}
        className={`detail-grid${focusedPane ? ` detail-grid--${focusedPane}-focused` : ""}`}
        style={{ "--event-pane-width": `${detailSplitRatio}%` } as CSSProperties}
        data-mobile-tab={mobileTab}
      >
        <section className="observation-section event-section">
          <div className="subsection-heading">
            <div><h3>事件日志</h3><span>最新事件优先</span></div>
            <div className="subsection-actions">
              {detail.status === "running" && detail.events.length > 0 && (
                <StatusBadge
                  label={detail.source === "managed" ? "实时" : "近实时"}
                  tone={detail.source === "managed" ? "green" : "blue"}
                  pulse
                />
              )}
              <button className="icon-button icon-button--compact pane-focus-button" type="button" onClick={() => setFocusedPane((current) => current === "events" ? undefined : "events")} title={focusedPane === "events" ? "退出日志聚焦" : "聚焦事件日志"}>
                {focusedPane === "events" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                <span className="sr-only">{focusedPane === "events" ? "退出日志聚焦" : "聚焦事件日志"}</span>
              </button>
            </div>
          </div>
          <EventLog key={detail.id} events={detail.events} />
        </section>

        <div
          className="detail-grid-resizer"
          role="separator"
          aria-label="调整事件日志与输出预览宽度"
          aria-orientation="vertical"
          aria-valuemin={38}
          aria-valuemax={68}
          aria-valuenow={Math.round(detailSplitRatio)}
          tabIndex={focusedPane ? -1 : 0}
          onPointerDown={beginDetailResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const delta = event.key === "ArrowLeft" ? -2 : 2;
            const next = Math.min(68, Math.max(38, detailSplitRatio + delta));
            setDetailSplitRatio(next);
            window.localStorage.setItem(DETAIL_SPLIT_STORAGE_KEY, String(next));
          }}
        ><span /></div>

        <section className="observation-section output-section">
          <div className="subsection-heading">
            <div><h3>输出预览</h3><span>{detail.output?.isFinal ? "最终输出" : "流式快照"}</span></div>
            <div className="subsection-actions">
              <span className="format-label">{detail.output?.format ?? "markdown"}</span>
              <button className="icon-button icon-button--compact pane-focus-button" type="button" onClick={() => setFocusedPane((current) => current === "output" ? undefined : "output")} title={focusedPane === "output" ? "退出输出聚焦" : "聚焦输出预览"}>
                {focusedPane === "output" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                <span className="sr-only">{focusedPane === "output" ? "退出输出聚焦" : "聚焦输出预览"}</span>
              </button>
            </div>
          </div>
          <div className="markdown-output">
            {detail.output?.content ? (
              detail.output.format === "markdown" ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.output.content}</ReactMarkdown>
              ) : (
                <pre>{detail.output.content}</pre>
              )
            ) : (
              <div className="inline-empty">运行输出将在这里实时显示</div>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}
