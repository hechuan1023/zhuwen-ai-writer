import { useEffect, useMemo, useState } from "react";
import { AnyRow, Modal, ConfirmDialog, api } from "../shared";
import { ChatMenu, type MenuItem } from "./menu";
import { IconCheck, IconChevronDown, IconCopy, IconDoc, IconDownload, IconRename, IconSearch, IconSparkle, IconTrash, IconUpload } from "./icons";

export type StyleCard = AnyRow & { tasks: string[]; version: number };
export type StyleIntensity = "light" | "balanced" | "strong";
type StyleComposition = { id: string; name: string; description: string; styleIds: string[]; updatedAt?: string };
type StyleCardFilter = "all" | "continue" | "outline" | "polish" | "naturalize" | "custom";
const PERSONAL_SAMPLE_MARKER = "\n\n[ZHUWEN_PERSONAL_STYLE_SAMPLE_V1]\n";
const PERSONAL_SAMPLE_GUIDE = "作者提供的个人样文，仅用于抽象句长、节奏、视角距离和修辞密度；不得复用原句、人物、设定或情节。";

function splitPersonalSample(storedRules: string) {
  const markerIndex = storedRules.indexOf(PERSONAL_SAMPLE_MARKER);
  if (markerIndex < 0) return { rules: storedRules, sample: "" };
  const tail = storedRules.slice(markerIndex + PERSONAL_SAMPLE_MARKER.length);
  const guidePrefix = `${PERSONAL_SAMPLE_GUIDE}\n`;
  return {
    rules: storedRules.slice(0, markerIndex),
    sample: tail.startsWith(guidePrefix) ? tail.slice(guidePrefix.length) : tail,
  };
}

function joinPersonalSample(rules: string, sample: string) {
  const cleanRules = rules.trim();
  const cleanSample = sample.trim();
  return cleanSample
    ? `${cleanRules}${PERSONAL_SAMPLE_MARKER}${PERSONAL_SAMPLE_GUIDE}\n${cleanSample}`
    : cleanRules;
}

function styleLabel(card: StyleCard, language: string) {
  if (language !== "en" || !card.builtin) return { name: card.name, description: card.description };
  const labels: Record<string, [string, string]> = {
    "style-natural-narrative": ["Natural narrative", "A general-purpose style centered on what characters are doing."],
    "style-growth-progression": ["Growth progression", "For training, resources, and clear short-term goals."],
    "style-close-survival": ["Close survival", "For travel, danger, investigation, and constrained combat."],
    "style-human-ensemble": ["Lived-in ensemble", "For towns, factions, friends, and intersecting relationships."],
    "style-serial-hook-payoff": ["Serial hooks & payoff", "Connect chapter rewards, unresolved actions, and the next reading impulse."],
    "style-scene-visual-payoff": ["Visual scene anchors & emotional aftermath", "Sharpen action and spatial clarity while preserving interiority and emotional resonance."],
    "style-suspense-information-control": ["Clues & information control", "Keep clues traceable and reveals consequential."],
    "style-multipov-ensemble": ["Multi-POV ensemble & information gaps", "Use bounded viewpoint shifts to reveal distinct motives, information, and consequences."],
    "style-character-voice-tension": ["Character voice & tension", "Give dialogue a character-specific agenda and subtext."],
    "style-light-comedy-mismatch": ["Situational comedy", "Build humor from character relationships and mismatched situations."],
    "style-grounded-mystery": ["Grounded mystery", "Anchor investigation in daily routines, interests, and verifiable evidence."],
    "style-cultural-modernization": ["Cultural translation", "Put traditional culture into character action and modern emotional stakes."],
    "style-urban-workplace-agency": ["Urban work & lived detail", "Ground urban stories in concrete work processes, interests, and life choices."],
    "style-professional-knowledge-causality": ["Professional knowledge & story causality", "Turn work experience and expertise into readable action, risk, collaboration, and character choices."],
    "style-fantasy-social-fusion": ["Fantasy & social systems", "Make institutions, resources, and social pressures part of a coherent fantasy world."],
    "style-high-stakes-game-theory": ["High-stakes strategy & limited agency", "Build tense choices from scarce resources, harsh rules, uncertain allies, and consequences that carry forward."],
    "style-system-agency-gameplay": ["System strategy & agency", "Let characters understand, negotiate with, exploit, or resist rules—and bear the consequences."],
    "style-lived-realism": ["Everyday realism & lived texture", "Use small, observable details to ground characters without turning themes into slogans."],
    "style-resource-management-loop": ["Resource & settlement loop", "Connect investment, work, visible gains, costs, and the next bottleneck."],
    "style-relationship-progression": ["Relationship progression", "Use goals, boundaries, choices, and concrete actions to move relationships."],
    "style-rule-instance-progression": ["Rule-based instances", "Use verifiable rules, active testing, staged payoffs, and a persistent arc."],
    "style-short-form-closure": ["Short-form closure & pacing", "Focus causal progression and a satisfying resolution within a bounded length."],
    "style-authorial-genre-bending": ["Genre-bending & authorial voice", "Keep the genre promise while breaking formula through character choices and story-world causality."],
    "style-road-journey-healing": ["Road journey & gradual healing", "Connect episodic stops, evolving relationships, and slow, earned change through a journey."],
  };
  const [name, description] = labels[card.id] || [card.name, card.description];
  return { name, description };
}
function taskLabel(task: string, language: string) {
  const map: Record<string, [string, string]> = { continue: ["续写", "Continuation"], polish: ["润色", "Polish"], naturalize: ["自然化润色", "Naturalize"], outline: ["构思", "Outline"], chat: ["对话", "Chat"], check: ["检查", "Check"] };
  return map[task]?.[language === "en" ? 1 : 0] || task;
}

const TECHNIQUE_PRESETS = [
  {
    id: "genre-multipov-suspense",
    name: ["多视角悬疑群像", "Multi-POV ensemble suspense"],
    description: ["视点纪律 + 线索信息差 + 人物关系", "Viewpoint discipline + clue distribution + character dynamics"],
    cardIds: ["style-multipov-ensemble", "style-suspense-information-control", "style-character-voice-tension"],
  },
  {
    id: "genre-authorial-fantasy",
    name: ["作者性幻想连载", "Authorial fantasy serial"],
    description: ["类型破格 + 世界因果 + 连载回报", "Genre-bending + world causality + serial payoff"],
    cardIds: ["style-authorial-genre-bending", "style-fantasy-social-fusion", "style-serial-hook-payoff"],
  },
  {
    id: "genre-road-journey-healing",
    name: ["公路漫游疗愈", "Road journey & gradual healing"],
    description: ["旅途单元 + 群像关系 + 生活肌理", "Episodic journey + ensemble relationships + lived detail"],
    cardIds: ["style-road-journey-healing", "style-human-ensemble", "style-lived-realism"],
  },
  {
    id: "genre-short-form-closure",
    name: ["中短篇现实题材", "Short-form grounded story"],
    description: ["篇幅收束 + 现实肌理 + 人物关系", "Bounded arc + lived detail + character relationships"],
    cardIds: ["style-short-form-closure", "style-lived-realism", "style-character-voice-tension"],
  },
  {
    id: "genre-visual-serial-scenes",
    name: ["强冲突场景连载", "High-impact scene serial"],
    description: ["视觉锚点 + 场景递进 + 章节兑现", "Visual anchors + scene progression + serial payoff"],
    cardIds: ["style-scene-visual-payoff", "style-serial-hook-payoff", "style-character-voice-tension"],
  },
  {
    id: "genre-cultural-growth",
    name: ["国风成长连载", "Guofeng growth serial"],
    description: ["成长推进 + 文化转译 + 追更兑现", "Growth + cultural translation + serial payoff"],
    cardIds: ["style-growth-progression", "style-cultural-modernization", "style-serial-hook-payoff"],
  },
  {
    id: "genre-grounded-mystery",
    name: ["现实悬疑连载", "Grounded mystery serial"],
    description: ["证据链 + 人物声线 + 章节钩子", "Evidence + character voice + chapter hooks"],
    cardIds: ["style-grounded-mystery", "style-suspense-information-control", "style-character-voice-tension", "style-serial-hook-payoff"],
  },
  {
    id: "genre-ensemble-comedy",
    name: ["群像生活轻喜", "Ensemble slice-of-life comedy"],
    description: ["群像烟火 + 关系张力 + 处境错位", "Ensemble + relationship tension + situational comedy"],
    cardIds: ["style-human-ensemble", "style-character-voice-tension", "style-light-comedy-mismatch"],
  },
  {
    id: "genre-professional-workplace",
    name: ["专业知识行业连载", "Professional workplace serial"],
    description: ["职业流程 + 专业行动 + 群像协作 + 连载兑现", "Work processes + expert action + ensemble teamwork + serial payoff"],
    cardIds: ["style-professional-knowledge-causality", "style-urban-workplace-agency", "style-human-ensemble", "style-serial-hook-payoff"],
  },
  {
    id: "genre-knowledge-driven-fantasy",
    name: ["知识驱动幻想成长", "Knowledge-driven fantasy growth"],
    description: ["专业知识 + 幻想规则 + 策略代价 + 阶段回报", "Expertise + fantasy systems + strategic costs + staged payoff"],
    cardIds: ["style-professional-knowledge-causality", "style-fantasy-social-fusion", "style-system-agency-gameplay", "style-serial-hook-payoff"],
  },
  {
    id: "genre-urban-workplace",
    name: ["都市职场群像", "Urban workplace ensemble"],
    description: ["职业流程 + 关系博弈 + 生活选择 + 连载兑现", "Work processes + relationship dynamics + life choices + serial payoff"],
    cardIds: ["style-urban-workplace-agency", "style-human-ensemble", "style-character-voice-tension", "style-serial-hook-payoff"],
  },
  {
    id: "genre-fantasy-social-fusion",
    name: ["现实机制幻想连载", "Social-systems fantasy serial"],
    description: ["世界规则 + 成长代价 + 求生行动 + 阶段回报", "World rules + growth costs + survival actions + staged payoff"],
    cardIds: ["style-fantasy-social-fusion", "style-growth-progression", "style-close-survival", "style-serial-hook-payoff"],
  },
  {
    id: "genre-high-stakes-survival",
    name: ["高压博弈生存连载", "High-stakes survival serial"],
    description: ["有限资源 + 规则博弈 + 信息差 + 连载回报", "Scarce resources + rule-bound strategy + information gaps + serial payoff"],
    cardIds: ["style-high-stakes-game-theory", "style-close-survival", "style-suspense-information-control", "style-serial-hook-payoff"],
  },
  {
    id: "genre-system-agency",
    name: ["系统博弈成长连载", "System-strategy growth serial"],
    description: ["人物能动 + 规则验证 + 信息差 + 连载兑现", "Character agency + rule testing + information gaps + serial payoff"],
    cardIds: ["style-system-agency-gameplay", "style-rule-instance-progression", "style-suspense-information-control", "style-serial-hook-payoff"],
  },
  {
    id: "genre-resource-management",
    name: ["经营建设连载", "Settlement & management serial"],
    description: ["资源循环 + 群像协作 + 阶段回报", "Resource loops + ensemble cooperation + staged payoff"],
    cardIds: ["style-resource-management-loop", "style-human-ensemble", "style-serial-hook-payoff"],
  },
  {
    id: "genre-relationship-serial",
    name: ["关系推进连载", "Relationship-driven serial"],
    description: ["人物声线 + 关系位移 + 章节兑现", "Character voice + relationship shifts + serial payoff"],
    cardIds: ["style-relationship-progression", "style-character-voice-tension", "style-serial-hook-payoff"],
  },
  {
    id: "genre-rule-instance",
    name: ["规则副本生存连载", "Rule-based survival serial"],
    description: ["规则验证 + 求生行动 + 悬念兑现", "Rule testing + survival choices + mystery payoff"],
    cardIds: ["style-rule-instance-progression", "style-close-survival", "style-suspense-information-control", "style-serial-hook-payoff"],
  },
];

export function StyleCardPanel({
  language,
  cards,
  selectedIds,
  onSelectionChange,
  styleIntensity,
  onStyleIntensityChange,
  taskKind,
  previewRules,
  onReload,
  compact = false,
}: {
  language: string;
  cards: StyleCard[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  styleIntensity: StyleIntensity;
  onStyleIntensityChange: (intensity: StyleIntensity) => void;
  taskKind: string;
  previewRules: string;
  onReload: () => void;
  compact?: boolean;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const selected = cards.filter((x) => selectedIds.includes(x.id));
  const selectedLabel = selected.length === 0
    ? tr("不使用风格", "No style")
    : selected.length === 1
      ? styleLabel(selected[0], language).name
      : tr(`组合 ${selected.length} 种技法`, `${selected.length} techniques`);
  const appliesToTask = (card: StyleCard) =>
    taskKind !== "chat" && taskKind !== "check" &&
    (card.tasks.includes(taskKind) || (taskKind === "naturalize" && card.tasks.includes("polish")));
  const applicableSelected = selected.filter(appliesToTask);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StyleCard | null>(null);
  const [edit, setEdit] = useState<StyleCard | null>(null);
  const [deleteCard, setDeleteCard] = useState<StyleCard | null>(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [compositions, setCompositions] = useState<StyleComposition[]>([]);
  const [compositionEditor, setCompositionEditor] = useState<StyleComposition | null>(null);
  const [deleteComposition, setDeleteComposition] = useState<StyleComposition | null>(null);
  const [savingComposition, setSavingComposition] = useState(false);
  const [importingComposition, setImportingComposition] = useState(false);
  const [exportingComposition, setExportingComposition] = useState("");
  const [cardSearch, setCardSearch] = useState("");
  const [cardFilter, setCardFilter] = useState<StyleCardFilter>("all");
  const visibleCards = useMemo(() => {
    const locale = language === "en" ? "en-US" : "zh-CN";
    const query = cardSearch.trim().toLocaleLowerCase(locale);
    return cards.filter((card) => {
      if (cardFilter === "custom" ? Boolean(card.builtin) : cardFilter !== "all" && !(card.tasks.includes(cardFilter) || (cardFilter === "polish" && card.tasks.includes("naturalize")))) return false;
      if (!query) return true;
      const label = styleLabel(card, language);
      const searchable = [label.name, label.description, ...card.tasks.map((task) => taskLabel(task, language))]
        .join(" ")
        .toLocaleLowerCase(locale);
      return searchable.includes(query);
    });
  }, [cards, cardSearch, cardFilter, language]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api<StyleComposition[]>("ai:style-compositions:list").then((result) => {
      if (!live) return;
      if (result.ok) setCompositions(Array.isArray(result.data) ? result.data : []);
      else setError(result.error || tr("读取自定义组合失败", "Could not load saved sets"));
    });
    return () => { live = false; };
  }, [open]);
  const compositionName = (id: string) => {
    const card = cards.find((item) => item.id === id);
    return card ? styleLabel(card, language).name : id;
  };
  const isCompositionSelected = (styleIds: string[]) =>
    styleIds.length === selectedIds.length && styleIds.every((id) => selectedIds.includes(id));
  const items: MenuItem[] = cards.map((card) => ({
    id: `style-${card.id}`,
    label: styleLabel(card, language).name,
    hint: card.builtin ? tr("内置", "Built-in") : tr("自定义", "Custom"),
    group: tr("技法卡", "Techniques"),
    icon: <IconSparkle />,
    selected: selectedIds.includes(card.id),
    onSelect: () => {
      onSelectionChange(selectedIds.includes(card.id)
        ? selectedIds.filter((id) => id !== card.id)
        : [...selectedIds, card.id]);
    },
  }));
  return (
    <div className="zchat-style-entry" data-fd-id="ai-style-entry">
      <ChatMenu
        ariaLabel={tr("写作风格", "Writing style")}
        dataFdId="ai-style-menu"
        menuClassName="open-up style-technique-menu"
        trigger={
          <>
            <IconSparkle />
            <span className="zchat-ellipsis">{selectedLabel}</span>
            {selected.length > 0 && (
              <small className={`zchat-style-state ${applicableSelected.length ? "active" : "inactive"}`}>
                {applicableSelected.length === 0
                  ? tr("本任务不生效", "Inactive")
                  : applicableSelected.length === selected.length
                    ? tr("生效", "Active")
                    : tr(`${applicableSelected.length}/${selected.length} 生效`, `${applicableSelected.length}/${selected.length} active`)}
              </small>
            )}
            <IconChevronDown size={13} />
          </>
        }
        triggerClassName="zchat-pill wide"
        items={[
          { id: "style-none", label: tr("不使用风格卡", "No style card"), selected: selectedIds.length === 0, onSelect: () => onSelectionChange([]) },
          { id: "style-details", label: tr("查看与管理风格卡", "Manage writing styles"), hint: tr("管理", "Manage"), group: tr("风格设置", "Style settings"), icon: <IconDoc />, onSelect: () => setOpen(true) },
          ...items,
        ]}
      />
      {open && (
        <Modal title={tr("AI 写作风格", "AI writing styles")} close={() => setOpen(false)}>
          <p className="hint">{tr("可组合多张技法卡。内置卡抽象通用叙事方法，不复刻单部作品或作者表达；每张卡按适用任务生效，普通聊天和逻辑检查不会注入写作风格。", "Combine techniques. Built-ins abstract general narrative methods rather than copying a specific work or author; cards apply only to enabled writing tasks, not normal chat or logic checks.")}</p>
          <section className="zchat-style-preview" data-fd-id="ai-style-composition-preview">
            <header><b>{tr("本任务实际注入规则", "Rules applied to this task")}</b><small>{taskLabel(taskKind, language)}</small></header>
            <div className="zchat-style-intensity" role="group" aria-label={tr("技法强调度", "Technique emphasis")} data-fd-id="ai-style-intensity">
              <span>{tr("技法强调度", "Technique emphasis")}</span>
              <div>
                {([
                  ["light", tr("轻", "Light")],
                  ["balanced", tr("平衡", "Balanced")],
                  ["strong", tr("强", "Strong")],
                ] as [StyleIntensity, string][]).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={styleIntensity === value ? "active" : ""}
                    aria-pressed={styleIntensity === value}
                    disabled={!selected.length}
                    onClick={() => onStyleIntensityChange(value)}
                  >{label}</button>
                ))}
              </div>
            </div>
            <small className="zchat-style-intensity-hint">{tr("只调节所选技法的强调程度；平衡保持原有规则强度。", "Adjusts emphasis only; Balanced keeps the existing rule strength.")}</small>
            <pre>{previewRules || tr("当前任务不注入写作风格规则。", "No style rules are added for this task.")}</pre>
          </section>
          <section className="zchat-style-presets" data-fd-id="ai-style-presets">
            <header><b>{tr("题材技法组合", "Genre technique sets")}</b><small>{tr("不模仿具体作品或作者", "No imitation of specific works or authors")}</small></header>
            <p>{tr("依据近年题材趋势整理叙事机制。应用会替换当前勾选，之后仍可逐张增删。", "Narrative mechanisms informed by recent genre trends. Applying a set replaces the current selection; you can then add or remove cards.")}</p>
            <div className="zchat-style-presets-grid">
              {TECHNIQUE_PRESETS.map((preset) => {
                const available = preset.cardIds.every((id) => cards.some((card) => card.id === id));
                const selectedPreset = selectedIds.length === preset.cardIds.length && preset.cardIds.every((id) => selectedIds.includes(id));
                return <button
                  type="button"
                  key={preset.id}
                  className={selectedPreset ? "active" : ""}
                  disabled={!available}
                  aria-pressed={selectedPreset}
                  data-fd-id={`ai-style-preset-${preset.id}`}
                  onClick={() => onSelectionChange(preset.cardIds)}
                >
                  <b>{preset.name[language === "en" ? 1 : 0]}</b>
                  <small>{preset.description[language === "en" ? 1 : 0]}</small>
                </button>;
              })}
            </div>
          </section>
          <section className="zchat-style-presets zchat-style-saved" data-fd-id="ai-style-saved-compositions">
            <header>
              <b>{tr("我的技法组合", "My technique sets")}</b>
              <div className="zchat-style-composition-actions">
                <button type="button" disabled={importingComposition} onClick={async () => {
                  setImportingComposition(true); setError("");
                  const result = await api<StyleComposition>("ai:style-compositions:import");
                  setImportingComposition(false);
                  if (!result.ok) setError(result.error || tr("导入组合失败", "Could not import set"));
                  else if (result.data) {
                    setCompositions((current) => [...current.filter((item) => item.id !== result.data.id), result.data].sort((a, b) => a.name.localeCompare(b.name)));
                    onReload();
                  }
                }}><IconUpload />{importingComposition ? tr("导入中…", "Importing…") : tr("导入组合", "Import set")}</button>
                <button type="button" disabled={!selectedIds.length} onClick={() => setCompositionEditor({ id: "", name: "", description: "", styleIds: [...selectedIds] })}>
                  {tr("保存当前组合", "Save current set")}
                </button>
              </div>
            </header>
            <p>{tr("本机可跨作品复用，也可导出 JSON 带到其他设备。保存或导入不会改变当前勾选；应用组合时才会替换。", "Reuse sets across novels on this device, or export JSON to transfer them. Saving or importing leaves the current selection unchanged; applying a set replaces it.")}</p>
            {compositions.length ? (
              <div className="zchat-style-saved-list">
                {compositions.map((composition) => {
                  const active = isCompositionSelected(composition.styleIds);
                  return <article className={active ? "active" : ""} key={composition.id}>
                    <button type="button" className="zchat-style-saved-apply" aria-pressed={active} onClick={() => onSelectionChange(composition.styleIds)}>
                      <b>{composition.name}</b>
                      <small>{composition.description || composition.styleIds.map(compositionName).join(language === "en" ? " + " : " + ")}</small>
                      <small className="zchat-style-tasks">{tr(`${composition.styleIds.length} 张技法卡`, `${composition.styleIds.length} techniques`)}</small>
                    </button>
                    <div className="zchat-style-row-actions">
                      <button type="button" title={tr("导出组合", "Export set")} aria-label={tr(`导出组合 ${composition.name}`, `Export set ${composition.name}`)} disabled={Boolean(exportingComposition)} onClick={async () => {
                        setExportingComposition(composition.id); setError("");
                        const result = await api("ai:style-compositions:export", composition.id);
                        setExportingComposition("");
                        if (!result.ok) setError(result.error || tr("导出组合失败", "Could not export set"));
                      }}><IconDownload /></button>
                      <button type="button" className="zchat-style-icon-action" title={tr("编辑组合", "Edit set")} aria-label={tr(`编辑组合 ${composition.name}`, `Edit set ${composition.name}`)} onClick={() => setCompositionEditor({ ...composition, styleIds: [...composition.styleIds] })}><IconRename /></button>
                      <button type="button" className="zchat-style-icon-action danger-text" title={tr("删除组合", "Delete set")} aria-label={tr(`删除组合 ${composition.name}`, `Delete set ${composition.name}`)} onClick={() => setDeleteComposition(composition)}><IconTrash /></button>
                    </div>
                  </article>;
                })}
              </div>
            ) : <div className="zchat-picker-empty">{tr("还没有保存的组合。先勾选技法卡，再点“保存当前组合”。", "No saved sets yet. Select techniques, then choose “Save current set”.")}</div>}
          </section>
          <div className="zchat-style-toolbar">
            <span>{tr("技法卡可导出为文件，在不同作品或设备间复用。", "Export a technique card to reuse it across projects or devices.")}</span>
            <button type="button" className="secondary" disabled={importing} onClick={async () => {
              setImporting(true); setError("");
              const result = await api<any>("ai:style:import");
              setImporting(false);
              if (!result.ok) setError(result.error || tr("导入失败", "Import failed"));
              else if (result.data) { await onReload(); }
            }} data-fd-id="ai-style-import"><IconUpload />{importing ? tr("导入中…", "Importing…") : tr("导入技法卡", "Import card")}</button>
          </div>
          <div className="zchat-style-browser">
            <label className="zchat-style-search">
              <IconSearch size={14} aria-hidden="true" />
              <input
                type="search"
                value={cardSearch}
                onChange={(event) => setCardSearch(event.target.value)}
                placeholder={tr("搜索技法名称或用途", "Search techniques or use cases")}
                aria-label={tr("搜索写作技法卡", "Search writing techniques")}
              />
            </label>
            <div className="zchat-style-filters" role="group" aria-label={tr("按适用任务筛选", "Filter by task")}>
              {([
                ["all", tr("全部", "All")],
                ["continue", tr("续写", "Continue")],
                ["outline", tr("构思", "Outline")],
                ["polish", tr("润色", "Polish")],
                ["naturalize", tr("自然化", "Naturalize")],
                ["custom", tr("自定义", "Custom")],
              ] as [StyleCardFilter, string][]).map(([filter, label]) => (
                <button
                  type="button"
                  key={filter}
                  className={cardFilter === filter ? "active" : ""}
                  aria-pressed={cardFilter === filter}
                  onClick={() => setCardFilter(filter)}
                >{label}</button>
              ))}
              <small>{tr(`显示 ${visibleCards.length} / ${cards.length} · 已选 ${selected.length}`, `${visibleCards.length} of ${cards.length} · ${selected.length} selected`)}</small>
            </div>
          </div>
          <div className="zchat-style-list">
            <button type="button" className={!selectedIds.length ? "active" : ""} onClick={() => onSelectionChange([])}>
              <b>{tr("不使用风格卡", "No style card")}</b><small>{tr("恢复现有行为，不向普通聊天添加正文规则。", "Keep existing behavior; no writing rules are added to normal chat.")}</small>
            </button>
            {visibleCards.map((card) => (
              <div className={`zchat-style-row ${selectedIds.includes(card.id) ? "active" : ""}`} key={card.id}>
                <button type="button" className="zchat-style-select" aria-pressed={selectedIds.includes(card.id)} onClick={() => onSelectionChange(selectedIds.includes(card.id) ? selectedIds.filter((id) => id !== card.id) : [...selectedIds, card.id])}>
                  <span className={`zchat-style-check ${selectedIds.includes(card.id) ? "selected" : ""}`} aria-hidden="true">{selectedIds.includes(card.id) ? <IconCheck size={13} /> : null}</span>
                  <span className="zchat-style-copy"><b>{styleLabel(card, language).name}</b><small>{styleLabel(card, language).description}</small><small className="zchat-style-tasks">{tr("适用：", "Tasks: ")}{card.tasks.map((x) => taskLabel(x, language)).join(language === "en" ? ", " : "、")}{!appliesToTask(card) ? ` · ${tr("当前任务不生效", "inactive for this task")}` : ` · ${tr("当前任务生效", "active for this task")}`}</small></span>
                </button>
                <div className="zchat-style-row-actions">
                  <button type="button" className="zchat-style-icon-action" title={tr("查看规则", "View rules")} aria-label={tr(`查看「${styleLabel(card, language).name}」规则`, `View rules for ${styleLabel(card, language).name}`)} onClick={() => setDetail(card)}><IconDoc /></button>
                  <button type="button" className="zchat-style-icon-action" title={tr("复制为自定义", "Copy as custom")} aria-label={tr(`复制「${styleLabel(card, language).name}」为自定义`, `Copy ${styleLabel(card, language).name} as custom`)} onClick={() => setEdit({ ...card, id: "", name: `${styleLabel(card, language).name}${tr("（自定义）", " (custom)")}`, builtin: 0 })}><IconCopy /></button>
                  {!card.builtin && <>
                    <button type="button" className="zchat-style-icon-action" title={tr("导出技法卡", "Export technique card")} aria-label={tr(`导出「${styleLabel(card, language).name}」`, `Export ${styleLabel(card, language).name}`)} data-fd-id="ai-style-export" onClick={async () => { const result = await api<any>("ai:style:export", card.id); if (!result.ok) setError(result.error || tr("导出失败", "Export failed")); }}><IconDownload /></button>
                    <button type="button" className="zchat-style-icon-action" title={tr("编辑", "Edit")} aria-label={tr(`编辑「${styleLabel(card, language).name}」`, `Edit ${styleLabel(card, language).name}`)} onClick={() => setEdit(card)}><IconRename /></button>
                  </>}
                  {!card.builtin && <button type="button" className="zchat-style-icon-action danger-text" title={tr("删除", "Delete")} aria-label={tr(`删除「${styleLabel(card, language).name}」`, `Delete ${styleLabel(card, language).name}`)} onClick={() => setDeleteCard(card)}><IconTrash /></button>}
                </div>
              </div>
            ))}
            {!visibleCards.length && <p className="zchat-style-no-results">{tr("没有匹配的技法卡。试试其他关键词或筛选条件。", "No techniques match. Try another search or filter.")}</p>}
          </div>
          {error && <p className="hint error">{error}</p>}
          <div className="row end"><button type="button" onClick={() => setEdit({ id: "", name: "", description: "", rules: "", tasks: ["continue", "polish"], builtin: 0, version: 1 })}>{tr("新建自定义卡", "New custom card")}</button></div>
        </Modal>
      )}
      {detail && <Modal title={styleLabel(detail, language).name} close={() => setDetail(null)}><p className="hint">{styleLabel(detail, language).description}</p><p className="hint">{tr("适用任务：", "Tasks: ")}{detail.tasks.map((x) => taskLabel(x, language)).join(language === "en" ? ", " : "、")}</p><pre className="zchat-style-rules">{detail.rules}</pre></Modal>}
      {compositionEditor && (
        <Modal title={tr(compositionEditor.id ? "编辑技法组合" : "保存技法组合", compositionEditor.id ? "Edit technique set" : "Save technique set")} close={() => !savingComposition && setCompositionEditor(null)}>
          <div className="zchat-style-editor">
            <label>{tr("名称", "Name")}<input value={compositionEditor.name} maxLength={80} onChange={(event) => setCompositionEditor({ ...compositionEditor, name: event.target.value })} /></label>
            <label>{tr("说明（可选）", "Description (optional)")}<input value={compositionEditor.description} maxLength={240} onChange={(event) => setCompositionEditor({ ...compositionEditor, description: event.target.value })} /></label>
            <fieldset className="zchat-style-task-options">
              <legend>{tr(`选择技法卡（${compositionEditor.styleIds.length}/6）`, `Choose techniques (${compositionEditor.styleIds.length}/6)`)}</legend>
              {cards.map((card) => {
                const checked = compositionEditor.styleIds.includes(card.id);
                return <label key={card.id}><input type="checkbox" checked={checked} disabled={!checked && compositionEditor.styleIds.length >= 6} onChange={(event) => setCompositionEditor({ ...compositionEditor, styleIds: event.target.checked ? [...compositionEditor.styleIds, card.id] : compositionEditor.styleIds.filter((id) => id !== card.id) })} />{styleLabel(card, language).name}</label>;
              })}
            </fieldset>
          </div>
          {error && <p className="hint error" role="alert">{error}</p>}
          <div className="row end">
            <button type="button" disabled={savingComposition} onClick={() => setCompositionEditor(null)}>{tr("取消", "Cancel")}</button>
            <button type="button" className="primary" disabled={savingComposition || !compositionEditor.name.trim() || compositionEditor.styleIds.length < 1} onClick={async () => {
              setSavingComposition(true); setError("");
              const result = await api<StyleComposition>("ai:style-compositions:save", compositionEditor);
              setSavingComposition(false);
              if (!result.ok) { setError(result.error || tr("保存失败", "Save failed")); return; }
              setCompositions((current) => [...current.filter((item) => item.id !== result.data.id), result.data].sort((a, b) => a.name.localeCompare(b.name)));
              onSelectionChange(result.data.styleIds);
              setCompositionEditor(null);
            }}>{savingComposition ? tr("保存中…", "Saving…") : tr("保存组合", "Save set")}</button>
          </div>
        </Modal>
      )}
      {deleteComposition && <ConfirmDialog title={tr("删除技法组合", "Delete technique set")} message={tr(`删除「${deleteComposition.name}」？不会删除组合中的技法卡。`, `Delete “${deleteComposition.name}”? The technique cards themselves will remain.`)} confirmLabel={tr("删除", "Delete")} cancelLabel={tr("取消", "Cancel")} danger onCancel={() => setDeleteComposition(null)} onConfirm={async () => {
        const result = await api("ai:style-compositions:delete", deleteComposition.id);
        if (!result.ok) setError(result.error || tr("删除失败", "Delete failed"));
        else setCompositions((current) => current.filter((item) => item.id !== deleteComposition.id));
        setDeleteComposition(null);
      }} />}
      {edit && <StyleEditor card={edit} language={language} onCancel={() => setEdit(null)} onSaved={() => { setEdit(null); onReload(); }} onError={setError} />}
      {deleteCard && <ConfirmDialog title={tr("删除自定义风格", "Delete custom style")} message={tr(`删除「${deleteCard.name}」？使用它的作品只会移除此卡，其他已选技法会保留。`, `Delete “${deleteCard.name}”? Novels using it will remove only this card; other selected techniques will remain.`)} confirmLabel={tr("删除", "Delete")} cancelLabel={tr("取消", "Cancel")} danger onCancel={() => setDeleteCard(null)} onConfirm={async () => { const r = await api("ai:style:delete", deleteCard.id); setDeleteCard(null); if (!r.ok) setError(r.error || "Delete failed"); else { setCompositions((current) => current.flatMap((item) => { const styleIds = item.styleIds.filter((id) => id !== deleteCard.id); return styleIds.length ? [{ ...item, styleIds }] : []; })); onReload(); } }} />}
    </div>
  );
}

function StyleEditor({ card, language, onCancel, onSaved, onError }: { card: StyleCard; language: string; onCancel: () => void; onSaved: () => void; onError: (s: string) => void }) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const taskOptions: [string, string, string][] = [
    ["continue", "续写", "Continuation"],
    ["polish", "润色", "Polish"],
    ["naturalize", "自然化润色", "Naturalize"],
    ["outline", "构思 / 起草", "Outline / Draft"],
  ];
  const parsedRules = splitPersonalSample(card.rules || "");
  const [name, setName] = useState(card.name);
  const [description, setDescription] = useState(card.description || "");
  const [rules, setRules] = useState(parsedRules.rules);
  const [sample, setSample] = useState(parsedRules.sample);
  const [tasks, setTasks] = useState(card.tasks.filter((task) => taskOptions.some(([id]) => id === task)));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const storedRules = joinPersonalSample(rules, sample);
  const overLimit = storedRules.length > 20000;

  async function save() {
    setSaving(true);
    setError("");
    const result = await api("ai:style:save", {
      id: card.id || undefined,
      name: name.trim(),
      description: description.trim(),
      rules: storedRules,
      tasks,
    });
    setSaving(false);
    if (result.ok) onSaved();
    else {
      const message = result.error || tr("保存失败", "Save failed");
      setError(message);
      onError(message);
    }
  }

  return (
    <Modal title={tr("编辑写作风格", "Edit writing style")} close={onCancel}>
      <div className="zchat-style-editor">
        <label>
          {tr("名称", "Name")}
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
        </label>
        <label>
          {tr("说明", "Description")}
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={240} />
        </label>
        <fieldset className="zchat-style-task-options">
          <legend>{tr("适用任务", "Apply to tasks")}</legend>
          {taskOptions.map(([id, zh, en]) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={tasks.includes(id)}
                onChange={(event) => setTasks((current) => event.target.checked
                  ? [...current, id]
                  : current.filter((task) => task !== id))}
              />
              {tr(zh, en)}
            </label>
          ))}
        </fieldset>
        <label>
          {tr("规则", "Rules")}
          <textarea
            aria-label={tr("技法规则", "Technique rules")}
            placeholder={tr(
              "例如：先依据视角人物掌握的证据行动；规则冲突时不临时增加设定解围。",
              "Example: Let the viewpoint character act on available evidence; don't invent a new rule to escape a contradiction.",
            )}
            value={rules}
            onChange={(event) => setRules(event.target.value)}
            maxLength={20000}
            rows={8}
          />
        </label>
        <label className="zchat-style-sample-field">
          {tr("个人样文参考（可选）", "Personal writing sample (optional)")}
          <small>
            {tr(
              "只放入你自己的文字。AI 会参考句长、节奏、视角距离和修辞密度，不复用样文中的句子、人物、设定或情节。",
              "Use your own writing. AI will reference sentence length, rhythm, narrative distance, and rhetorical density without reusing its wording, characters, setting, or plot.",
            )}
          </small>
          <textarea
            aria-label={tr("个人样文参考", "Personal writing sample")}
            placeholder={tr(
              "粘贴一小段你希望延续语感的自有正文",
              "Paste a short passage of your own writing whose voice you want to carry forward",
            )}
            value={sample}
            onChange={(event) => setSample(event.target.value)}
            maxLength={8000}
            rows={5}
          />
        </label>
        <small className={overLimit ? "zchat-style-rule-count error" : "zchat-style-rule-count"}>
          {tr("总计", "Total")} {storedRules.length.toLocaleString(language === "en" ? "en-US" : "zh-CN")} / 20,000
          {overLimit ? tr(" · 超出上限", " · over the limit") : ""}
        </small>
        <p className="hint zchat-style-editor-help">
          {tr(
            "规则和样文会在所选任务中生效；它们影响表达方式，不会替作品新增事实或覆盖作者设定。",
            "Rules and samples apply to the selected tasks. They guide expression without adding story facts or overriding your canon.",
          )}
        </p>
      </div>
      {error && <p className="hint error">{error}</p>}
      <div className="row end">
        <button type="button" onClick={onCancel} disabled={saving}>{tr("取消", "Cancel")}</button>
        <button
          type="button"
          className="primary"
          disabled={saving || !name.trim() || !rules.trim() || !tasks.length || overLimit}
          onClick={() => void save()}
        >
          {saving ? tr("保存中…", "Saving…") : tr("保存", "Save")}
        </button>
      </div>
    </Modal>
  );
}
