import { useEffect, useState } from "react";
import { api, readerFonts, promptNameFor, ConfirmDialog, AnyRow, UiLanguage } from "./shared";
import { PlanSection } from "./plan-section";
import { Select, Combobox } from "./select";
import { PresetSection } from "./preset-section";
import { WritingEnvironment } from "./presets";

export type PresetSectionProps = {
  environment: WritingEnvironment;
  previewing: boolean;
  /** 预览目标 id/名称，用于操作栏提示 */
  previewLabel?: string | null;
  onPreview: (env: WritingEnvironment, label?: string) => void;
  onApply: (env: WritingEnvironment) => void | Promise<void> | Promise<boolean>;
  onCancelPreview: () => void;
};

export function Settings({
  notify,
  typography,
  onChangeTypography,
  dailyGoal,
  onDailyGoal,
  language,
  onLanguage,
  personalization,
  onPersonalization,
  presetProps,
}: {
  notify: (s: string) => void;
  typography: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    paraSpacing: number;
    readingWidth: number;
  };
  onChangeTypography: (
    t: Partial<{
      fontFamily: string;
      fontSize: number;
      lineHeight: number;
      paraSpacing: number;
      readingWidth: number;
    }>,
  ) => void;
  dailyGoal: number;
  onDailyGoal: (n: number) => void;
  language: UiLanguage;
  onLanguage: (value: UiLanguage) => void;
  personalization: AnyRow;
  onPersonalization: (value: AnyRow) => void;
  presetProps?: PresetSectionProps;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [tab, setTab] = useState<"general" | "editor" | "appearance" | "ai">(
    "general",
  );
  const modKey = window.zhuwen.platform === "darwin" ? "⌘" : "Ctrl";
  const [connections, setConnections] = useState<AnyRow[]>([]),
    [prompts, setPrompts] = useState<AnyRow[]>([]),
    [health, setHealth] = useState<AnyRow | null>(null),
    [checkingHealth, setCheckingHealth] = useState(false),
    [promptEdit, setPromptEdit] = useState<any>(null),
    [modelOptions, setModelOptions] = useState<string[]>([]),
    [loadingModels, setLoadingModels] = useState(false),
    [edit, setEdit] = useState<any>({
      name: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 60000,
      streaming: true,
      reasoningEffort: "",
      apiKey: "",
    });
  // 需二次确认的操作（真实连接测试 / 删除模板 / 恢复默认模板）
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "test-connection"; id: string; name: string }
    | { kind: "delete-prompt"; id: string; name: string }
    | { kind: "restore-defaults" }
    | null
  >(null);
  const load = () =>
    api("connections:list").then((r) => {
      if (!r.ok) return;
      setConnections(r.data);
      const c = r.data?.[0];
      if (c?.locked) {
        setEdit((prev: any) => prev.id ? prev : {
          id: c.id,
          locked: true,
          name: c.name,
          baseUrl: c.base_url,
          model: c.model,
          temperature: c.temperature,
          maxTokens: c.max_tokens,
          timeoutMs: c.timeout_ms,
          streaming: Boolean(c.streaming),
          reasoningEffort: c.reasoning_effort || "medium",
          apiKey: "",
        });
      }
    });
  const loadPrompts = () =>
    api("prompts:list").then((r) => r.ok && setPrompts(r.data));
  useEffect(() => {
    load();
    loadPrompts();
  }, []);
  async function savePrompt() {
    if (!promptEdit?.name?.trim() || !promptEdit?.content?.trim())
      return notify(tr("模板名称和内容不能为空", "Template name and content are required"));
    const r = await api("prompts:save", {
      id: promptEdit.id || undefined,
      name: promptEdit.name.trim(),
      content: promptEdit.content,
    });
    if (r.ok) {
      notify(tr("模板已保存", "Template saved"));
      setPromptEdit(null);
      loadPrompts();
    } else notify(r.error || tr("保存失败", "Save failed"));
  }
  async function fetchModels() {
    if (!edit.baseUrl) return notify(tr("请先填写 API 基础地址", "Enter the API base URL first"));
    setLoadingModels(true);
    const r = await api<string[]>("connections:models", {
      baseUrl: edit.baseUrl,
      apiKey: edit.apiKey,
      connectionId: edit.id || undefined,
    });
    setLoadingModels(false);
    if (r.ok) {
      setModelOptions(r.data);
      notify(tr(`获取到 ${r.data.length} 个模型`, `Loaded ${r.data.length} models`));
    } else notify(r.error || tr("获取模型列表失败", "Could not load models"));
  }
  async function save() {
    if (!edit.name?.trim()) return notify(tr("请填写连接名称", "Enter a connection name"));
    if (!edit.baseUrl?.trim()) return notify(tr("请填写 API 基础地址", "Enter the API base URL"));
    if (!edit.model?.trim()) return notify(tr("请填写模型 ID", "Enter a model ID"));
    if (!Number.isFinite(edit.temperature) || edit.temperature < 0 || edit.temperature > 2)
      return notify(tr("随机程度必须在 0 到 2 之间", "Temperature must be between 0 and 2"));
    if (!Number.isInteger(edit.maxTokens) || edit.maxTokens < 1 || edit.maxTokens > 200000)
      return notify(tr("最大输出 tokens 必须是 1 到 200000 的整数", "Maximum output tokens must be an integer from 1 to 200000"));
    if (!Number.isInteger(edit.timeoutMs) || edit.timeoutMs < 1000 || edit.timeoutMs > 600000)
      return notify(tr("超时必须在 1000 到 600000 毫秒之间", "Timeout must be between 1000 and 600000 ms"));
    const r = await api("connections:save", edit);
    if (r.ok) {
      notify(tr("连接已安全保存", "Connection saved securely"));
      setEdit({ ...edit, id: r.data.id, apiKey: "" });
      load();
    } else notify(r.error || tr("保存失败", "Save failed"));
  }
  return (
    <div className="settings-page">
      <nav className="settings-nav">
        <b>{tr("设置", "Settings")}</b>
        <button
          className={tab === "general" ? "active" : ""}
          onClick={() => setTab("general")}
        >
          {tr("通用", "General")}
        </button>
        <button
          className={tab === "editor" ? "active" : ""}
          onClick={() => setTab("editor")}
        >
          {tr("编辑器", "Editor")}
        </button>
        <button
          className={tab === "appearance" ? "active" : ""}
          onClick={() => setTab("appearance")}
        >
          {tr("外观与背景", "Appearance")}
        </button>
        <button
          className={tab === "ai" ? "active" : ""}
          onClick={() => setTab("ai")}
        >
          {tr("AI 模型", "AI models")}
        </button>
      </nav>
      <div className="settings settings-detail">
        {tab === "general" && (
          <section>
            <h3>{tr("语言与通用设置", "Language & general")}</h3>
            <label>
              {tr("界面语言", "Interface language")}
              <Select
                id="settings-language"
                language={language}
                value={language}
                aria-label={tr("界面语言", "Interface language")}
                onValueChange={(v) => onLanguage(v as UiLanguage)}
                options={[
                  { value: "zh-CN", label: "简体中文" },
                  { value: "en", label: "English" },
                ]}
              />
            </label>
            <p className="hint">
              {tr(
                "语言切换立即生效；AI 与资料库中的专业写作术语仍在持续补充。",
                "Language changes take effect immediately. Specialized terms in AI and the story bible are still being expanded.",
              )}
            </p>
            <h3>{tr("写作目标", "Writing goal")}</h3>
            <label>
              {tr("每日目标字数", "Daily word goal")}
              <input
                type="number"
                min="0"
                max="1000000"
                step="100"
                value={dailyGoal}
                onChange={(e) => onDailyGoal(+e.target.value || 0)}
              />
            </label>
            <h3>{tr("本地数据", "Local data")}</h3>
            <div className="data-health">
              <div>
                <b>{health
                  ? health.healthy
                    ? tr("资料库状态正常", "Database is healthy")
                    : tr("资料库需要检查", "Database needs attention")
                  : tr("检查本地资料库完整性", "Check local database integrity")}</b>
                <small>
                  {health
                    ? tr(
                        `${health.novels} 本作品 · ${health.chapters} 章 · ${Math.max(0.01, health.size / 1024 / 1024).toFixed(2)} MB`,
                        `${health.novels} novels · ${health.chapters} chapters · ${Math.max(0.01, health.size / 1024 / 1024).toFixed(2)} MB`,
                      )
                    : tr(
                        "执行 SQLite 快速完整性检查，不会修改正文。",
                        "Runs a quick SQLite integrity check without modifying your manuscript.",
                      )}
                </small>
              </div>
              <button
                disabled={checkingHealth}
                onClick={async () => {
                  setCheckingHealth(true);
                  const result = await api<AnyRow>("database:health");
                  setCheckingHealth(false);
                  if (result.ok) {
                    setHealth(result.data);
                    notify(result.data.healthy
                      ? tr("资料库检查通过", "Database check passed")
                      : tr("资料库检查发现异常", "Database check found an issue"));
                  } else notify(result.error || tr("资料库检查失败", "Database check failed"));
                }}
              >
                {checkingHealth ? tr("检查中…", "Checking…") : tr("立即检查", "Check now")}
              </button>
            </div>
          </section>
        )}
        {tab === "general" && (
          <PlanSection language={language} />
        )}
        {tab === "ai" && (
          <section>
            <h3>{tr("AI API 连接", "AI API connections")}</h3>
            <p className="hint">
              {tr(
                "铸文 AI 服务已启用。服务地址、模型和密钥由软件统一管理，无需选择连接；下方可调整思考深度、随机程度、输出上限、超时和流式回复。",
                "Zhuwen AI is enabled. The service, model, and credentials are managed by the app; adjust reasoning depth, temperature, output limit, timeout, and streaming below.",
              )}
            </p>
            <div className="connection-list" data-fd-id="settings-connection-list">
              {connections.map((c) => c.locked ? (
                <div className="connection-managed" key={c.id} role="status" data-fd-id="settings-managed-ai">
                  <span className="connection-managed-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" /></svg>
                  </span>
                  <span className="connection-managed-copy">
                    <b>{tr("铸文 AI 服务", "Zhuwen AI service")}</b>
                    <small>{tr("服务器托管 · 模型与密钥由服务端管理", "Server managed · model and credentials stay on the server")}</small>
                  </span>
                  <span className="connection-managed-badge">{tr("已托管", "Managed")}</span>
                </div>
              ) : (
                <button
                  key={c.id}
                  type="button"
                  className={edit.id === c.id ? "connection-option active" : "connection-option"}
                  aria-pressed={edit.id === c.id}
                  onClick={() =>
                    setEdit({
                      id: c.id,
                      name: c.name,
                      baseUrl: c.base_url,
                      model: c.model,
                      temperature: c.temperature,
                      maxTokens: c.max_tokens,
                      timeoutMs: c.timeout_ms,
                      streaming: Boolean(c.streaming),
                      reasoningEffort: c.reasoning_effort || "",
                      apiKey: "",
                      locked: false,
                    })
                  }
                >
                  <b>{c.name}</b>
                  <small>{c.model}</small>
                </button>
              ))}
              {!connections.some((c) => c.locked) && <button
                type="button"
                onClick={() =>
                  setEdit({
                    name: "",
                    baseUrl: "https://api.openai.com/v1",
                    model: "",
                    temperature: 0.7,
                    maxTokens: 2048,
                    timeoutMs: 60000,
                    streaming: true,
                    apiKey: "",
                  })
                }
              >
                {tr("＋ 新连接", "+ New connection")}
              </button>}
            </div>
            {!edit.locked && (
              <div className="settings-provider-fields" data-fd-id="settings-provider-fields">
                <label>
                  {tr("连接名称", "Connection name")}
                  <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                </label>
                <label>
                  {tr("API 基础地址", "API base URL")}
                  <input value={edit.baseUrl} onChange={(e) => setEdit({ ...edit, baseUrl: e.target.value })} />
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    placeholder={edit.id ? tr("留空则保留现有密钥", "Leave blank to keep the saved key") : tr("不会写入数据库或日志", "Never stored in the database or logs")}
                    value={edit.apiKey}
                    onChange={(e) => setEdit({ ...edit, apiKey: e.target.value })}
                  />
                </label>
                <label>
                  {tr("模型 ID", "Model ID")}
                  <Combobox
                    value={edit.model}
                    aria-label={tr("模型 ID", "Model ID")}
                    placeholder="gpt-4.1-mini"
                    onValueChange={(v) => setEdit({ ...edit, model: v })}
                    suggestions={modelOptions.map((m) => ({ value: m, label: m }))}
                  />
                </label>
                <div className="row">
                  <button type="button" onClick={fetchModels} disabled={loadingModels}>
                    {loadingModels ? tr("获取中…", "Loading…") : tr("从服务获取模型列表", "Load models from service")}
                  </button>
                  {modelOptions.length > 0 && (
                    <small className="hint">
                      {tr(`已获取 ${modelOptions.length} 个模型，输入框可下拉选择`, `${modelOptions.length} models loaded; choose one from the input list`)}
                    </small>
                  )}
                </div>
              </div>
            )}
            <div className="settings-generation-heading" data-fd-id="settings-generation-heading">
              <div>
                <b>{tr("生成参数", "Generation settings")}</b>
                <small>{edit.locked ? tr("仅影响写作生成体验，不会更换服务器模型。", "Adjusts generation behavior without changing the server-managed model.") : tr("控制本连接的生成行为。", "Controls generation behavior for this connection.")}</small>
              </div>
              {edit.locked && <span>{tr("服务器托管", "Server managed")}</span>}
            </div>
            <div className="grid2 settings-generation-options" data-fd-id="settings-generation-options">
              <label>
                {tr("随机程度", "Temperature")}
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={edit.temperature}
                  onChange={(e) =>
                    setEdit({ ...edit, temperature: +e.target.value })
                  }
                />
              </label>
              <label>
                {tr("最大输出 tokens", "Maximum output tokens")}
                <input
                  type="number"
                  min="1"
                  max="200000"
                  value={edit.maxTokens}
                  onChange={(e) =>
                    setEdit({ ...edit, maxTokens: +e.target.value })
                  }
                />
              </label>
              <label>
                {tr("超时（毫秒）", "Timeout (ms)")}
                <input
                  type="number"
                  min="1000"
                  max="600000"
                  step="1000"
                  value={edit.timeoutMs}
                  onChange={(e) =>
                    setEdit({ ...edit, timeoutMs: +e.target.value })
                  }
                />
              </label>
              <label data-fd-id="settings-reasoning-field">
                {tr("思考深度", "Reasoning effort")}
                <Select
                  id="settings-reasoning"
                  language={language}
                  value={edit.reasoningEffort || ""}
                  aria-label={tr("思考深度", "Reasoning effort")}
                  onValueChange={(v) => setEdit({ ...edit, reasoningEffort: v })}
                  options={[
                    { value: "", label: tr("不使用（默认）", "Off (default)") },
                    { value: "low", label: tr("低 · 更快", "Low · faster") },
                    { value: "medium", label: tr("中 · 平衡", "Medium · balanced") },
                    { value: "high", label: tr("高 · 更深入", "High · deeper") },
                  ]}
                />
                <small className="hint">
                  {tr(
                    "仅对支持 reasoning_effort 的模型生效（如部分 o 系列 / 推理模型）；不支持的服务会忽略该字段。",
                    "Only sent when the model supports reasoning_effort; other services ignore it.",
                  )}
                </small>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={edit.streaming}
                  onChange={(e) =>
                    setEdit({ ...edit, streaming: e.target.checked })
                  }
                />
                {tr("流式回复", "Stream responses")}
              </label>
            </div>
            <div className="row end settings-ai-actions">
              <button type="button" className="primary" data-fd-id="settings-ai-save" onClick={save}>
                {edit.locked ? tr("保存 AI 设置", "Save AI settings") : tr("保存连接", "Save connection")}
              </button>
              {edit.id && (
                <button
                  type="button"
                  data-fd-id="settings-ai-test-connection"
                  onClick={() =>
                    setConfirmAction({
                      kind: "test-connection",
                      id: edit.id,
                      name: edit.name || "",
                    })
                  }
                >
                  {tr("真实测试", "Live test")}
                </button>
              )}
            </div>
            <h3>{tr("提示词模板", "Prompt templates")}</h3>
            <p className="hint">
              {tr(
                "模板显示在 AI 助手输入框上方，点击即填入。内置模板可恢复默认；自定义模板可删除。",
                "Templates appear above the AI input and can be inserted with one click. Built-ins can be reset; custom templates can be deleted.",
              )}
            </p>
            <p className="hint">
              {tr(
                "支持变量：{当前章节} {选中文字} {人物设定} {世界设定} {章节摘要} {书名} {简介} {日期}——发送时自动替换为对应引用内容，可在「预览发送」中确认。",
                "Variables supported: {当前章节} {选中文字} {人物设定} {世界设定} {章节摘要} {书名} {简介} {日期} — resolved into references on send; verify via Send preview.",
              )}
            </p>
            <div className="prompt-manage">
              {prompts.map((p) => (
                <div className="prompt-row" key={p.id}>
                  <b title={p.content}>
                    {promptNameFor(p.name, p.builtin, language)}
                    {p.builtin ? <small>{tr("内置", "Built-in")}</small> : null}
                  </b>
                  <span>
                    <button
                      onClick={() =>
                        setPromptEdit({
                          id: p.id,
                          name: p.name,
                          content: p.content,
                        })
                      }
                    >
                      {tr("编辑", "Edit")}
                    </button>
                    {!p.builtin && (
                      <button
                        className="danger-text"
                        onClick={() =>
                          setConfirmAction({
                            kind: "delete-prompt",
                            id: p.id,
                            name: p.name,
                          })
                        }
                      >
                        {tr("删除", "Delete")}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {promptEdit ? (
              <div className="prompt-edit">
                <input
                  placeholder={tr("模板名称", "Template name")}
                  value={promptEdit.name}
                  onChange={(e) =>
                    setPromptEdit({ ...promptEdit, name: e.target.value })
                  }
                />
                <textarea
                  rows={4}
                  placeholder={tr("提示词内容", "Prompt content")}
                  value={promptEdit.content}
                  onChange={(e) =>
                    setPromptEdit({ ...promptEdit, content: e.target.value })
                  }
                />
                <div className="row end">
                  <button onClick={() => setPromptEdit(null)}>{tr("取消", "Cancel")}</button>
                  <button className="primary" onClick={savePrompt}>
                    {tr("保存模板", "Save template")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button
                  onClick={() =>
                    setPromptEdit({ id: "", name: "", content: "" })
                  }
                >
                  {tr("＋ 新增模板", "+ New template")}
                </button>
                <button
                  onClick={() => setConfirmAction({ kind: "restore-defaults" })}
                >
                  {tr("恢复默认模板", "Reset built-in templates")}
                </button>
              </div>
            )}
          </section>
        )}
        {tab === "editor" && (
          <section>
            <h3>{tr("编辑与快捷键", "Editing & shortcuts")}</h3>
            <p>{`${modKey}+K 命令面板　${modKey}+S 立即保存　${modKey}+F 查找　${modKey}+H 查找替换　${modKey}+Z 撤销　${modKey}+Y 重做　${modKey}+Shift+F 专注模式`}</p>
            <p className="hint">
              {tr(
                "正文默认按非空白字符统计，包含标点；首行缩进由排版样式实现，不写入空格。",
                "Word count includes non-whitespace characters and punctuation. First-line indentation is visual and does not insert spaces.",
              )}
            </p>
          </section>
        )}
        {tab === "editor" && (
          <section>
            <h3>{tr("正文排版", "Manuscript typography")}</h3>
            <p className="hint">
              {tr(
                "排版只影响显示与阅读体验，不会向正文插入空格或隐藏格式。",
                "Typography only affects display and reading comfort; it never inserts hidden formatting into the manuscript.",
              )}
            </p>
            <div className="grid2">
              <label>
                {tr("正文字体", "Body font")}
                <Select
                  language={language}
                  value={typography.fontFamily}
                  aria-label={tr("正文字体", "Body font")}
                  onValueChange={(v) => onChangeTypography({ fontFamily: v })}
                  options={readerFonts.map((f) => ({
                    value: f.value,
                    label:
                      language === "en"
                        ? ({
                            "宋体（衬线）": "Serif",
                            "黑体（无衬线）": "Sans serif",
                            "楷体": "Kai style",
                            "系统默认": "System default",
                          } as Record<string, string>)[f.label] || f.label
                        : f.label,
                  }))}
                />
              </label>
              <label className="typo-slider">
                {tr("字号", "Font size")} <output className="tabular">{typography.fontSize}px</output>
                <input
                  type="range"
                  min="14"
                  max="30"
                  step="1"
                  value={typography.fontSize}
                  onChange={(e) =>
                    onChangeTypography({ fontSize: +e.target.value })
                  }
                />
              </label>
              <label className="typo-slider">
                {tr("行高（建议 1.5–1.8）", "Line height (1.5–1.8 recommended)")}{" "}
                <output className="tabular">{typography.lineHeight}</output>
                <input
                  type="range"
                  min="1.4"
                  max="2.4"
                  step="0.05"
                  value={typography.lineHeight}
                  onChange={(e) =>
                    onChangeTypography({ lineHeight: +e.target.value })
                  }
                />
              </label>
              <label className="typo-slider">
                {tr("段间距（em）", "Paragraph spacing (em)")}{" "}
                <output className="tabular">{typography.paraSpacing}</output>
                <input
                  type="range"
                  min="0"
                  max="1.2"
                  step="0.05"
                  value={typography.paraSpacing}
                  onChange={(e) =>
                    onChangeTypography({ paraSpacing: +e.target.value })
                  }
                />
              </label>
              <label className="setting-switch">
                <span>
                  <b>{tr("首行缩进 2 字符", "First-line indent 2 chars")}</b>
                  <small>{tr("网文常用；仅影响显示，不写入正文空格", "Display only; does not insert spaces into the manuscript")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={
                    (typography as any).firstLineIndent !== false
                  }
                  onChange={(e) =>
                    onChangeTypography({ firstLineIndent: e.target.checked } as any)
                  }
                />
              </label>
              <label className="typo-slider">
                {tr("阅读宽度（px）", "Reading width (px)")}{" "}
                <output className="tabular">{typography.readingWidth}</output>
                <input
                  type="range"
                  min="480"
                  max="1100"
                  step="10"
                  value={typography.readingWidth}
                  onChange={(e) =>
                    onChangeTypography({ readingWidth: +e.target.value })
                  }
                />
              </label>
            </div>
            <div className="row end">
              <button
                onClick={() =>
                  onChangeTypography({
                    fontFamily: readerFonts[0].value,
                    fontSize: 17,
                    lineHeight: 1.7,
                    paraSpacing: 0.25,
                    readingWidth: 760,
                    firstLineIndent: true,
                  } as any)
                }
              >
                {tr("恢复默认排版", "Reset typography")}
              </button>
            </div>
          </section>
        )}
        {tab === "appearance" && (
          <AppearanceSettings
            value={personalization}
            onChange={onPersonalization}
            notify={notify}
            language={language}
            presetProps={presetProps}
          />
        )}
      </div>
      {confirmAction && (
        <ConfirmDialog
          title={
            confirmAction.kind === "test-connection"
              ? tr("真实测试连接", "Live connection test")
              : confirmAction.kind === "delete-prompt"
                ? tr("删除模板", "Delete template")
                : tr("恢复默认模板", "Reset built-in templates")
          }
          message={
            confirmAction.kind === "test-connection"
              ? tr(
                  `测试「${confirmAction.name}」会发送一个很小的真实请求，可能产生少量用量。继续？`,
                  `Testing “${confirmAction.name}” sends a small real request and may use a small amount of quota. Continue?`,
                )
              : confirmAction.kind === "delete-prompt"
                ? tr(
                    `删除模板「${confirmAction.name}」？`,
                    `Delete template “${confirmAction.name}”?`,
                  )
                : tr(
                    "将内置模板恢复为默认内容，自定义模板不受影响。继续？",
                    "Reset built-in templates to their defaults? Custom templates will not be changed.",
                  )
          }
          confirmLabel={
            confirmAction.kind === "test-connection"
              ? tr("开始测试", "Run test")
              : confirmAction.kind === "delete-prompt"
                ? tr("删除", "Delete")
                : tr("恢复默认", "Reset")
          }
          cancelLabel={tr("取消", "Cancel")}
          danger={confirmAction.kind !== "test-connection"}
          onCancel={() => setConfirmAction(null)}
          onConfirm={async () => {
            const action = confirmAction;
            if (!action) return;
            setConfirmAction(null);
            if (action.kind === "test-connection") {
              const r = await api("connections:test", action.id);
              notify(
                r.ok
                  ? tr("连接测试成功", "Connection test succeeded")
                  : r.error || tr("连接失败", "Connection failed"),
              );
            } else if (action.kind === "delete-prompt") {
              const r = await api("prompts:delete", action.id);
              if (r.ok) loadPrompts();
              else notify(r.error || tr("删除失败", "Delete failed"));
            } else {
              const r = await api("prompts:restoreDefaults");
              if (r.ok) {
                notify(tr("内置模板已恢复默认", "Built-in templates restored"));
                loadPrompts();
              } else notify(r.error || tr("恢复失败", "Restore failed"));
            }
          }}
        />
      )}
    </div>
  );
}

export function AppearanceSettings({
  value,
  onChange,
  notify,
  language,
  presetProps,
}: {
  value: AnyRow;
  onChange: (x: AnyRow) => void;
  notify: (s: string) => void;
  language: UiLanguage;
  presetProps?: PresetSectionProps;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const slider = (key: string, n: number) => onChange({ [key]: n });
  return (
    <section className="appearance-settings">
      {presetProps && (
        <PresetSection
          language={language}
          environment={presetProps.environment}
          previewing={presetProps.previewing}
          previewLabel={presetProps.previewLabel}
          onPreview={presetProps.onPreview}
          onApply={presetProps.onApply}
          onCancelPreview={presetProps.onCancelPreview}
          notify={notify}
        />
      )}
      <h3>{tr("界面主题", "Theme")}</h3>
      <div className="appearance-presets" role="group" aria-label={tr("界面主题", "Theme")}>
        {[
          ["light", "雾白", "#f2f4f5", "#fbfcfd", "#3d6f82"],
          ["warm", "暖纸", "#f3efe6", "#fffdf8", "#4d7a68"],
          ["dark", "墨夜", "#14181a", "#1c2225", "#6fb39a"],
        ].map(([theme, label, chrome, paper, accent]) => (
          <button
            key={theme}
            className={value.theme === theme ? "active" : ""}
            onClick={() => onChange({ theme })}
          >
            <i style={{ background: `linear-gradient(90deg, ${chrome} 32%, ${paper} 32% 72%, ${accent} 72%)` }} />
            <span>
              {language === "en"
                ? ({ 雾白: "Mist", 暖纸: "Warm paper", 墨夜: "Ink night" } as Record<string, string>)[label]
                : label}
            </span>
          </button>
        ))}
      </div>
      <label className="setting-switch">
        <span>
          <b>{tr("减少透明效果", "Reduce transparency")}</b>
          <small>{tr("关闭毛玻璃，使用实色表面，提升对比度", "Use solid surfaces instead of glass for higher contrast")}</small>
        </span>
        <input
          type="checkbox"
          checked={Boolean((value as any).reduceTransparency)}
          onChange={(e) => onChange({ reduceTransparency: e.target.checked } as any)}
        />
      </label>
      <label className="setting-switch">
        <span>
          <b>{tr("减少动态效果", "Reduce motion")}</b>
          <small>{tr("关闭过渡与动画，保留必要的状态变化", "Turn off transitions and animations while keeping essential state changes")}</small>
        </span>
        <input
          type="checkbox"
          data-fd-id="settings-reduce-motion"
          checked={Boolean((value as any).reduceMotion)}
          onChange={(e) => onChange({ reduceMotion: e.target.checked } as any)}
        />
      </label>
      <h3>{tr("界面密度", "Interface density")}</h3>
      <div className="density-options" role="group" aria-label={tr("界面密度", "Interface density")}>
        <button className={value.uiDensity === "compact" ? "active" : ""} onClick={() => onChange({ uiDensity: "compact" })}>
          <b>{tr("紧凑", "Compact")}</b><small>{tr("显示更多章节与工具", "Show more chapters and tools")}</small>
        </button>
        <button className={value.uiDensity === "comfortable" ? "active" : ""} onClick={() => onChange({ uiDensity: "comfortable" })}>
          <b>{tr("舒适", "Comfortable")}</b><small>{tr("更大的间距和点击区域", "Larger spacing and click targets")}</small>
        </button>
      </div>
      <h3>{tr("写作体验", "Writing experience")}</h3>
      <label className="setting-switch">
        <span>
          <b>{tr("打字机模式", "Typewriter mode")}</b>
          <small>{tr("当前输入行始终保持在编辑区中央", "Keep the active line centered in the editor")}</small>
        </span>
        <input
          type="checkbox"
          checked={value.typewriterMode}
          onChange={(e) => onChange({ typewriterMode: e.target.checked })}
        />
      </label>
      <label className="setting-switch">
        <span>
          <b>{tr("专注模式极简化", "Minimal focus mode")}</b>
          <small>{tr("专注时隐藏顶栏与状态栏，鼠标移到屏幕上/下边缘时显示", "Hide top and status bars in focus mode; reveal them by moving the mouse to the screen edges")}</small>
        </span>
        <input
          type="checkbox"
          checked={Boolean(value.focusZen)}
          onChange={(e) => onChange({ focusZen: e.target.checked })}
        />
      </label>
      <label>
        {tr("编辑区缩放", "Editor zoom")} <output>{Math.round(value.editorZoom * 100)}%</output>
        <input
          type="range"
          min="0.7"
          max="1.8"
          step="0.1"
          value={value.editorZoom}
          onChange={(e) => slider("editorZoom", +e.target.value)}
        />
      </label>
      <h3>{tr("个性化背景", "Custom background")}</h3>
      <div className="background-picker">
        <div
          className="background-thumb"
          style={
            value.backgroundImage
              ? { backgroundImage: `url(${value.backgroundImage})` }
              : {}
          }
        >
          {!value.backgroundImage && tr("未设置背景", "No background")}
        </div>
        <div>
          <b>{value.backgroundName || tr("使用纯色纸张", "Using solid paper")}</b>
          <div className="row">
            <button
              onClick={async () => {
                const r = await api<any>("appearance:chooseBackground");
                if (r.ok && r.data)
                  onChange({
                    backgroundImage: r.data.dataUrl,
                    backgroundName: r.data.name,
                  });
                else if (!r.ok)
                  notify(r.error || tr("选择背景失败", "Could not choose background"));
              }}
            >
              {tr("上传背景", "Choose image")}
            </button>
            {value.backgroundImage && (
              <button
                className="danger-text"
                onClick={() =>
                  onChange({ backgroundImage: "", backgroundName: "" })
                }
              >
                {tr("移除", "Remove")}
              </button>
            )}
          </div>
        </div>
      </div>
      <label>
        {tr("背景可见度", "Background visibility")} <output>{Math.round(value.backgroundOpacity * 100)}%</output>
        <input
          type="range"
          min="0"
          max="0.8"
          step="0.02"
          value={value.backgroundOpacity}
          onChange={(e) => slider("backgroundOpacity", +e.target.value)}
        />
      </label>
      <p className="hint">{tr("图片覆盖整个应用；侧栏保持通透，正文使用独立遮罩。开启减少透明度时，面板恢复实色。", "The image spans the app. Panels and manuscript have separate opacity. Reduce transparency restores solid surfaces.")}</p>
      <div className="row background-presets" role="group" aria-label={tr("背景风格", "Background style")}>
        {[
          { name: tr("清晰", "Clear"), backgroundOpacity: 0.8, backgroundBlur: 0, panelOpacity: 0.45, paperOpacity: 0.72 },
          { name: tr("柔和", "Soft"), backgroundOpacity: 0.65, backgroundBlur: 8, panelOpacity: 0.65, paperOpacity: 0.86 },
          { name: tr("专注", "Focus"), backgroundOpacity: 0.3, backgroundBlur: 16, panelOpacity: 0.88, paperOpacity: 0.97 },
        ].map(({ name, ...values }) => <button key={name} type="button" onClick={() => onChange(values)}>{name}</button>)}
      </div>
      <label>
        {tr("面板遮罩（越低越通透）", "Panel opacity")} <output>{Math.round((value.panelOpacity ?? 0.72) * 100)}%</output>
        <input type="range" min="0.35" max="1" step="0.01" value={value.panelOpacity ?? 0.72} onChange={(e) => slider("panelOpacity", +e.target.value)} />
      </label>
      <label>
        {tr("正文纸张遮罩", "Paper opacity")} <output>{Math.round(value.paperOpacity * 100)}%</output>
        <input
          type="range"
          min="0.45"
          max="1"
          step="0.01"
          value={value.paperOpacity}
          onChange={(e) => slider("paperOpacity", +e.target.value)}
        />
      </label>
      <label>
        {tr("背景模糊", "Background blur")} <output>{value.backgroundBlur}px</output>
        <input
          type="range"
          min="0"
          max="24"
          step="1"
          value={value.backgroundBlur}
          onChange={(e) => slider("backgroundBlur", +e.target.value)}
        />
      </label>
      <label>
        {tr("填充方式", "Image fit")}
        <Select
          language={language}
          value={value.backgroundFit}
          aria-label={tr("填充方式", "Image fit")}
          onValueChange={(v) => onChange({ backgroundFit: v })}
          options={[
            { value: "cover", label: tr("填满窗口", "Cover window") },
            { value: "contain", label: tr("完整显示", "Show full image") },
            { value: "tile", label: tr("平铺纹理", "Tile") },
          ]}
        />
      </label>
      <p className="hint">
        {tr(
          "背景图片只保存在本机设置中，不会发送给 AI 或包含在稿件导出里。",
          "The background image stays in local settings and is never sent to AI or included in manuscript exports.",
        )}
      </p>
      <div className="row end">
        <button
          onClick={() =>
            onChange({
              theme: "warm",
              uiDensity: "compact",
              focusZen: false,
              typewriterMode: false,
              editorZoom: 1,
              backgroundImage: "",
              backgroundName: "",
              backgroundOpacity: 0.22,
              backgroundBlur: 0,
              backgroundFit: "cover",
              paperOpacity: 0.9,
              panelOpacity: 0.72,
            })
          }
        >
          {tr("恢复默认外观", "Reset appearance")}
        </button>
      </div>
    </section>
  );
}
