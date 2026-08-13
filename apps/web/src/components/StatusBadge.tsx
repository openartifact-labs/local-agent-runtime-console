import type { ReactNode } from "react";

interface StatusBadgeProps {
  label: ReactNode;
  tone?: string;
  pulse?: boolean;
  title?: string;
}

export function StatusBadge({ label, tone = "muted", pulse = false, title }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${tone}`} title={title}>
      <span className={`status-dot${pulse ? " status-dot--pulse" : ""}`} aria-hidden="true" />
      {label}
    </span>
  );
}
