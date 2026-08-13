import { MonitorCog, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type ThemePreference = "dark" | "light" | "system";

const THEME_STORAGE_KEY = "local-agent-runtime-console:theme";

function storedPreference(): ThemePreference {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === "dark" || value === "light" || value === "system" ? value : "dark";
}

function resolvedTheme(preference: ThemePreference, mediaQuery: MediaQueryList): "dark" | "light" {
  return preference === "system" ? (mediaQuery.matches ? "dark" : "light") : preference;
}

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const theme = resolvedTheme(preference, mediaQuery);
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.themePreference = preference;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#070b12" : "#f3f5f7");
    };

    applyTheme();
    // 仅在跟随系统时响应系统主题变化，避免覆盖用户明确选择。
    if (preference === "system") mediaQuery.addEventListener("change", applyTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    return () => mediaQuery.removeEventListener("change", applyTheme);
  }, [preference]);

  const options = [
    { value: "dark" as const, label: "深色", icon: Moon },
    { value: "light" as const, label: "浅色", icon: Sun },
    { value: "system" as const, label: "跟随系统", icon: MonitorCog },
  ];

  return (
    <div className="theme-control" role="group" aria-label="界面主题">
      {options.map((option) => (
        <button
          key={option.value}
          className={preference === option.value ? "is-active" : undefined}
          type="button"
          aria-pressed={preference === option.value}
          title={option.label}
          onClick={() => setPreference(option.value)}
        >
          <option.icon size={14} aria-hidden="true" />
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
