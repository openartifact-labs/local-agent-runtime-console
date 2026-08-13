import type { ProviderUsageAnalytics, ProviderUsageSnapshot } from "@openartifact-labs/runtime-contracts";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BrainCircuit,
  Braces,
  Clock3,
  Coins,
  Database,
  Gauge,
  HardDriveDownload,
  MessageSquareText,
  RefreshCw,
  X,
} from "lucide-react";

import { formatDateTime, formatNumber } from "../lib/format";
import { UsageAnalyticsPanel } from "./UsageAnalyticsPanel";

interface ProviderUsageDialogProps {
  usage: ProviderUsageSnapshot;
  analytics?: ProviderUsageAnalytics;
  analyticsLoading: boolean;
  analyticsDays: number;
  refreshing: boolean;
  refreshError?: string;
  onRefresh: () => Promise<void>;
  onAnalyticsDaysChange: (days: number) => void;
  onClose: () => void;
}

function formatWindow(minutes?: number): string {
  if (minutes === undefined) return "未提供周期";
  if (minutes % 1_440 === 0) return `${formatNumber(minutes / 1_440)} 天周期`;
  if (minutes % 60 === 0) return `${formatNumber(minutes / 60)} 小时周期`;
  return `${formatNumber(minutes)} 分钟周期`;
}

function percent(value?: number): string {
  return value === undefined ? "--" : `${Math.round(value * 10) / 10}%`;
}

export function ProviderUsageDialog({
  usage,
  analytics,
  analyticsLoading,
  analyticsDays,
  refreshing,
  refreshError,
  onRefresh,
  onAnalyticsDaysChange,
  onClose,
}: ProviderUsageDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [activeTab, setActiveTab] = useState<"summary" | "analytics">("summary");
  const rateLimit = usage.rateLimit;
  const usedPercent = Math.min(100, Math.max(0, rateLimit?.usedPercent ?? 0));
  const remainingPercent = rateLimit?.usedPercent === undefined ? undefined : 100 - usedPercent;
  const totalTokens = usage.usage.totalTokens
    ?? ((usage.usage.inputTokens ?? 0) + (usage.usage.outputTokens ?? 0));
  const uncachedInput = usage.usage.inputTokens !== undefined
    ? Math.max(0, usage.usage.inputTokens - (usage.usage.cachedInputTokens ?? 0))
    : undefined;
  const cacheHitRate = usage.usage.inputTokens
    ? (usage.usage.cachedInputTokens ?? 0) / usage.usage.inputTokens * 100
    : undefined;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const tokenItems = [
    { label: "Token 总量", value: totalTokens, icon: Coins },
    { label: "输入 Token", value: usage.usage.inputTokens, icon: Braces },
    { label: "缓存输入", value: usage.usage.cachedInputTokens, icon: Database },
    { label: "非缓存输入", value: uncachedInput, icon: HardDriveDownload },
    { label: "输出 Token", value: usage.usage.outputTokens, icon: MessageSquareText },
    { label: "推理 Token", value: usage.usage.reasoningOutputTokens, icon: BrainCircuit },
  ];

  return createPortal(
    <div className="usage-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="usage-dialog usage-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="usage-dialog-title">
        <header className="usage-dialog-header">
          <div className="usage-dialog-title">
            <span><Gauge size={19} /></span>
            <div>
              <h2 id="usage-dialog-title">Codex Token 用量</h2>
              <p>当前登录账号额度与最近活跃会话的本机观测数据</p>
            </div>
          </div>
          <div className="usage-dialog-actions">
            <button className="icon-button" type="button" disabled={refreshing} onClick={() => void onRefresh()} title="刷新额度、Token 与使用分析">
              <RefreshCw className={refreshing ? "spin" : undefined} size={17} />
              <span className="sr-only">刷新额度、Token 与使用分析</span>
            </button>
            <button ref={closeButtonRef} className="icon-button" type="button" onClick={onClose} title="关闭用量详情">
              <X size={18} />
              <span className="sr-only">关闭用量详情</span>
            </button>
          </div>
        </header>

        <div className="usage-dialog-tabs" role="tablist" aria-label="Codex 用量视图">
          <button type="button" role="tab" aria-selected={activeTab === "summary"} className={activeTab === "summary" ? "is-active" : undefined} onClick={() => setActiveTab("summary")}>额度与 Token</button>
          <button type="button" role="tab" aria-selected={activeTab === "analytics"} className={activeTab === "analytics" ? "is-active" : undefined} onClick={() => setActiveTab("analytics")}>使用分析</button>
        </div>

        {refreshError && <div className="usage-refresh-error usage-refresh-error--global" role="alert">{refreshError}</div>}

        {activeTab === "summary" ? <>
        <div className="usage-quota">
          <div className="usage-quota-copy">
            <div>
              <span>当前额度周期剩余</span>
              <strong>{percent(remainingPercent)}</strong>
            </div>
            <div className="usage-quota-meta">
              <span>已用 {percent(rateLimit?.usedPercent)}</span>
              <span>{formatWindow(rateLimit?.windowMinutes)}</span>
              <span>{rateLimit?.planType ? `套餐 ${rateLimit.planType}` : "套餐类型未提供"}</span>
            </div>
          </div>
          <div className="usage-progress" role="progressbar" aria-label="Codex 账号剩余额度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remainingPercent}>
            <span style={{ width: `${remainingPercent ?? 0}%` }} />
          </div>
          <div className="usage-reset">
            <Clock3 size={14} />
            {rateLimit?.resetsAt ? `预计重置于 ${formatDateTime(rateLimit.resetsAt)}` : "Codex 暂未返回重置时间"}
          </div>
        </div>

        <div className="usage-section-heading">
          <div>
            <h3>最近活跃会话累计</h3>
            <p title={usage.taskExternalId}>{usage.taskTitle ?? "未命名 Codex 会话"}</p>
          </div>
          <span>观测于 {formatDateTime(usage.observedAt)}</span>
        </div>

        <div className="usage-token-grid">
          {tokenItems.map((item) => (
            <div className="usage-token-item" key={item.label}>
              <span><item.icon size={15} />{item.label}</span>
              <strong>{formatNumber(item.value)}</strong>
            </div>
          ))}
        </div>

        <footer className="usage-dialog-footer">
          <span>缓存命中率 {percent(cacheHitRate)}</span>
          {usage.modelContextWindow !== undefined && <span>上下文窗口 {formatNumber(usage.modelContextWindow)}</span>}
          <p>输入 Token 已包含缓存输入，输出 Token 已包含推理 Token；总量不会重复相加。剩余额度来自 Codex 当前登录账号的限额周期，Token 明细来自本机会话记录；两者都不代表账单金额或精确 Token 余额。</p>
        </footer>
        </> : (
          <UsageAnalyticsPanel
            analytics={analytics}
            loading={analyticsLoading}
            days={analyticsDays}
            onDaysChange={onAnalyticsDaysChange}
          />
        )}
      </section>
    </div>,
    document.body,
  );
}
