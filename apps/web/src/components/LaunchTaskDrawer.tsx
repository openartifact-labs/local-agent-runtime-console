import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { LaunchTaskInput, ProviderDescriptor } from "@openartifact-labs/runtime-contracts";
import { Bot, ChevronDown, FolderOpen, LoaderCircle, Play, X } from "lucide-react";

interface LaunchTaskDrawerProps {
  open: boolean;
  providers: ProviderDescriptor[];
  submitting: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (input: LaunchTaskInput) => Promise<void>;
}

const reasoningOptions = [
  { value: "", label: "跟随默认设置" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

export function LaunchTaskDrawer({ open, providers, submitting, error, onClose, onSubmit }: LaunchTaskDrawerProps) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [providerId, setProviderId] = useState("");

  const launchProviders = providers.filter((provider) => provider.connected && provider.capabilities.launchTask);

  useEffect(() => {
    if (!providerId && launchProviders[0]) setProviderId(launchProviders[0].id);
  }, [launchProviders, providerId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({
      prompt: prompt.trim(),
      cwd: cwd.trim(),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(providerId ? { providerId } : {}),
    });
  }

  return (
    <div className={`drawer-layer${open ? " is-open" : ""}`} aria-hidden={!open}>
      <button className="drawer-backdrop" type="button" onClick={onClose} tabIndex={open ? 0 : -1} aria-label="关闭发起任务面板" />
      <aside className="launch-drawer" role="dialog" aria-modal="true" aria-labelledby="launch-title">
        <div className="drawer-header">
          <div>
            <span className="drawer-kicker"><Play size={13} />受管运行</span>
            <h2 id="launch-title">发起新任务</h2>
            <p>任务将由选定的运行时提供方执行并记录完整观测数据。</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={19} /><span className="sr-only">关闭</span>
          </button>
        </div>

        <form className="launch-form" onSubmit={handleSubmit}>
          <label className="form-field form-field--large">
            <span>任务描述 <b>*</b></span>
            <textarea
              required
              rows={8}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="描述要交给 Agent 完成的目标、约束和验收标准…"
              autoFocus={open}
            />
            <small>{prompt.length} 字</small>
          </label>

          <label className="form-field">
            <span>工作目录 <b>*</b></span>
            <div className="input-with-icon">
              <FolderOpen size={16} />
              <input
                required
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="D:\\projects\\my-project"
              />
            </div>
          </label>

          <div className="form-grid">
            <label className="form-field">
              <span>运行时提供方</span>
              <div className="input-with-icon select-with-icon">
                <Bot size={16} />
                <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                  {launchProviders.length === 0 && <option value="">暂无可用提供方</option>}
                  {launchProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
                <ChevronDown size={15} className="select-chevron" />
              </div>
            </label>

            <label className="form-field">
              <span>推理强度</span>
              <div className="input-with-icon select-with-icon">
                <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
                  {reasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <ChevronDown size={15} className="select-chevron" />
              </div>
            </label>
          </div>

          <label className="form-field">
            <span>模型（可选）</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="留空以使用 Provider 默认模型" />
          </label>

          {error && <div className="form-error" role="alert">{error}</div>}

          <div className="drawer-actions">
            <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
            <button
              className="button button--primary"
              type="submit"
              disabled={submitting || launchProviders.length === 0 || !prompt.trim() || !cwd.trim()}
            >
              {submitting ? <LoaderCircle size={17} className="spin" /> : <Play size={17} />}
              {submitting ? "正在发起…" : "发起并观测"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
