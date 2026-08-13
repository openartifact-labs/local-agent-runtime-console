import type { ProviderUsageAnalytics, UsageAnalyticsSeries } from "@openartifact-labs/runtime-contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatDateTime, formatNumber } from "../lib/format";

const COLORS = ["#2563eb", "#60a5fa", "#1d4ed8", "#8b5cf6", "#ec4899", "#f59e0b", "#0f766e", "#64748b", "#b91c1c"];

interface UsageAnalyticsPanelProps {
  analytics?: ProviderUsageAnalytics;
  loading: boolean;
  days: number;
  onDaysChange: (days: number) => void;
}

function seriesTotal(series: UsageAnalyticsSeries): number {
  return series.points.reduce((total, point) => (
    total + Object.values(point.values).reduce((sum, value) => sum + value, 0)
  ), 0);
}

function pointTotal(point: UsageAnalyticsSeries["points"][number]): number {
  return Object.values(point.values).reduce((sum, value) => sum + value, 0);
}

function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function ChartLegend({ series }: { series: UsageAnalyticsSeries }) {
  return (
    <div className="usage-chart-legend">
      {series.keys.map((key, index) => (
        <span key={key.id}><i style={{ background: COLORS[index % COLORS.length] }} />{key.label}</span>
      ))}
    </div>
  );
}

function EmptyChart() {
  return <div className="usage-chart-empty">当前时间范围内暂无可识别数据</div>;
}

function SurfaceBars({ series }: { series: UsageAnalyticsSeries }) {
  const rawMaximum = Math.max(1, ...series.points.map(pointTotal));
  const showBreakdown = series.points.length <= 14;
  const maximum = Math.ceil(rawMaximum * (showBreakdown ? 1.25 : 1.12));
  const labelInterval = series.points.length <= 31 ? 1 : Math.ceil(series.points.length / 24);
  if (seriesTotal(series) === 0) return <EmptyChart />;

  return (
    <>
      <div className="usage-bar-chart" aria-label="每日会话来源柱状图">
        <div className="usage-chart-y-axis"><span>{maximum}</span><span>{Math.round(maximum / 2)}</span><span>0</span></div>
        <div className="usage-bar-plot">
          {series.points.map((point, pointIndex) => {
            const total = pointTotal(point);
            const details = series.keys
              .map((key) => ({ label: key.label, value: point.values[key.id] ?? 0 }))
              .filter((item) => item.value > 0);
            const showLabel = total > 0 && pointIndex % labelInterval === 0;
            return (
              <div className="usage-bar-column" key={point.date} title={`${shortDate(point.date)}：${total} 个会话`}>
                {showLabel && (
                  <div className={`usage-bar-label${showBreakdown ? " usage-bar-label--detail" : ""}`} style={{ bottom: `calc(${total / maximum * 100}% + 5px)` }}>
                    {showBreakdown
                      ? details.map((item) => <span key={item.label}>{item.label} <strong>{item.value}</strong></span>)
                      : <strong>{total}</strong>}
                  </div>
                )}
                <div className="usage-bar-stack" style={{ height: `${total / maximum * 100}%` }}>
                  {series.keys.map((key, index) => {
                    const value = point.values[key.id] ?? 0;
                    if (value === 0) return null;
                    return (
                      <span
                        key={key.id}
                        title={`${key.label}：${value}`}
                        style={{ height: `${value / pointTotal(point) * 100}%`, background: COLORS[index % COLORS.length] }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="usage-chart-x-axis"><span>{shortDate(series.points[0]!.date)}</span><span>{shortDate(series.points.at(-1)!.date)}</span></div>
      <ChartLegend series={series} />
    </>
  );
}

function areaPath(top: number[], bottom: number[], width: number, height: number, maximum: number): string {
  const x = (index: number) => top.length <= 1 ? 0 : index / (top.length - 1) * width;
  const y = (value: number) => height - value / maximum * height;
  const upper = top.map((value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`).join(" ");
  const lower = bottom.map((value, index) => `L${x(bottom.length - 1 - index)},${y(bottom[bottom.length - 1 - index]!)}`).join(" ");
  return `${upper} ${lower} Z`;
}

function StackedArea({ series, ariaLabel }: { series: UsageAnalyticsSeries; ariaLabel: string }) {
  const [hoverIndex, setHoverIndex] = useState<number>();
  const hoverIndexRef = useRef<number | undefined>(undefined);
  const hoverFrameRef = useRef<number | undefined>(undefined);
  const width = 900;
  const height = 190;
  const geometry = useMemo(() => {
    const totals = series.points.map(pointTotal);
    const maximum = Math.max(1, ...totals);
    const cumulative = new Array(series.points.length).fill(0) as number[];
    const layers = series.keys.map((key) => {
      const bottom = [...cumulative];
      const top = cumulative.map((value, index) => value + (series.points[index]!.values[key.id] ?? 0));
      for (let index = 0; index < cumulative.length; index += 1) cumulative[index] = top[index]!;
      return { key, top, bottom };
    });
    return { maximum, layers };
  }, [series]);

  useEffect(() => {
    hoverIndexRef.current = undefined;
    setHoverIndex(undefined);
    return () => {
      if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
    };
  }, [series]);

  function scheduleHover(nextIndex: number | undefined): void {
    if (hoverIndexRef.current === nextIndex) return;
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = undefined;
      hoverIndexRef.current = nextIndex;
      setHoverIndex(nextIndex);
    });
  }

  if (seriesTotal(series) === 0) return <EmptyChart />;
  const hovered = hoverIndex === undefined ? undefined : series.points[hoverIndex];
  const hoverX = hoverIndex === undefined || series.points.length <= 1 ? 0 : hoverIndex / (series.points.length - 1) * width;
  const hoverPercent = hoverX / width * 100;
  // Tooltip 加宽后提前换边，确保长 Skill 名称完整显示且不越出图表右侧。
  const tooltipSide = hoverPercent > 58 ? "left" : "right";

  return (
    <>
      <div className="usage-area-chart">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => scheduleHover(undefined)}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
            scheduleHover(Math.round(ratio * (series.points.length - 1)));
          }}
        >
          {[0, 0.5, 1].map((ratio) => (
            <line key={ratio} x1="0" x2={width} y1={height * ratio} y2={height * ratio} className="usage-chart-grid-line" />
          ))}
          {geometry.layers.map((layer, index) => (
            <path
              key={layer.key.id}
              d={areaPath(layer.top, layer.bottom, width, height, geometry.maximum)}
              fill={COLORS[index % COLORS.length]}
              fillOpacity={0.78}
              stroke={COLORS[index % COLORS.length]}
              strokeWidth="1.5"
              className="usage-area-layer"
            />
          ))}
          {hovered && (
            <>
              <line x1={hoverX} x2={hoverX} y1="0" y2={height} className="usage-chart-hover-line" />
              <circle
                cx={hoverX}
                cy={height - pointTotal(hovered) / geometry.maximum * height}
                r="7"
                className="usage-chart-hover-point-halo"
              />
              <circle
                cx={hoverX}
                cy={height - pointTotal(hovered) / geometry.maximum * height}
                r="3.5"
                className="usage-chart-hover-point"
              />
            </>
          )}
        </svg>
        {hovered && (
          <div
            className={`usage-chart-tooltip usage-chart-tooltip--${tooltipSide}`}
            style={{ left: `${hoverPercent}%` }}
          >
            <strong>{shortDate(hovered.date)}</strong>
            {series.keys.map((key, index) => (
              <span key={key.id}><i style={{ background: COLORS[index % COLORS.length] }} />{key.label}<b>{hovered.values[key.id] ?? 0}</b></span>
            ))}
          </div>
        )}
      </div>
      <div className="usage-chart-x-axis"><span>{shortDate(series.points[0]!.date)}</span><span>{shortDate(series.points.at(-1)!.date)}</span></div>
      <ChartLegend series={series} />
    </>
  );
}

export function UsageAnalyticsPanel({ analytics, loading, days, onDaysChange }: UsageAnalyticsPanelProps) {
  return (
    <div className="usage-analytics">
      <div className="usage-analytics-toolbar">
        <div>
          <strong>本机使用分析</strong>
          <span>{analytics ? `观测于 ${formatDateTime(analytics.observedAt)}` : "正在读取本机会话记录"}</span>
        </div>
        <div className="usage-range-control" aria-label="统计时间范围">
          {[7, 30, 90].map((value) => (
            <button key={value} type="button" className={days === value ? "is-active" : undefined} onClick={() => onDaysChange(value)}>{value} 天</button>
          ))}
        </div>
      </div>

      {loading && !analytics ? <div className="usage-analytics-loading">正在聚合本机 rollout 记录...</div> : analytics && (
        <>
          <section className="usage-chart-section">
            <header><div><h3>每日会话来源</h3><p>仅统计本机创建或同步的 Codex 会话</p></div><strong>{formatNumber(analytics.sessionCount)}<small>个会话</small></strong></header>
            <SurfaceBars series={analytics.bySurface} />
          </section>
          <section className="usage-chart-section">
            <header><div><h3>模型轮次</h3><p>按每轮 turn_context 中记录的模型聚合</p></div><strong>{formatNumber(analytics.turnCount)}<small>轮</small></strong></header>
            <StackedArea series={analytics.byModel} ariaLabel="按模型统计的轮次趋势图" />
          </section>
          <section className="usage-chart-section">
            <header><div><h3>Skills 使用</h3><p>同一轮内重复读取同一个 Skill 只统计一次</p></div><strong>{formatNumber(analytics.skillInvocationCount)}<small>次调用</small></strong></header>
            <StackedArea series={analytics.bySkill} ariaLabel="Skills 使用趋势图" />
          </section>
          <p className="usage-analytics-note">以上趋势来自本机 `.codex` 会话文件，不代表账号在其他设备或网页端的完整使用情况。</p>
        </>
      )}
    </div>
  );
}
