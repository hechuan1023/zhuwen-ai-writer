import { parseJson, parseTags } from "./shared";

/** DB content_json → 编辑模型 */
export function libraryContentToEditor(row: {
  kind?: string;
  content_json?: string;
  tags_json?: string;
  [k: string]: any;
}): any {
  const c = parseJson(row.content_json || "{}");
  const next: any = { ...row, ...c };
  const kind = row.kind || next.kind;
  if (kind === "character")
    next.progressions = Array.isArray(next.progressions)
      ? next.progressions.filter((entry: any) => entry && typeof entry === "object" && !Array.isArray(entry))
      : [];
  if (kind === "relation") {
    next.body = c.label ?? c.body ?? "";
    next.from = c.from ?? "";
    next.to = c.to ?? "";
    next.label = next.body;
  }
  if (kind === "scene") {
    next.plotlinesText = Array.isArray(c.plotlines) ? c.plotlines.join("，") : String(c.plotlines || "");
  }
  if (!next.tagsText) next.tagsText = parseTags(row.tags_json || "[]");
  return next;
}

/** 编辑模型 → library:save 的 content 对象 */
export function editorToLibraryContent(kind: string, editing: any): any {
  if (kind === "timeline")
    return { when: editing.when || "", body: editing.body || "" };
  if (kind === "foreshadow")
    return {
      body: editing.body || "",
      payoff: editing.payoff || "",
      resolved: Boolean(editing.resolved),
      // 生命周期扩展（对齐长篇伏笔管理）
      plantAt: editing.plantAt || "",
      planAt: editing.planAt || "",
      prereq: editing.prereq || "",
      effect: editing.effect || "",
      importance: editing.importance || "",
    };
  if (kind === "scene")
    return {
      body: editing.body || "",
      hook: editing.hook || "",
      plotRole: editing.plotRole || "",
      coolPoint: editing.coolPoint || "",
      cast: editing.cast || "",
      pov: String(editing.pov || "").trim().slice(0, 120),
      plotlines: [...new Set(String(editing.plotlinesText ?? editing.plotlines ?? "")
        .split(/[,，、;；\n]+/)
        .map((value) => value.trim().slice(0, 80))
        .filter(Boolean))]
        .slice(0, 20),
      when: editing.when || "",
    };
  if (kind === "relation")
    return {
      from: editing.from ?? "",
      to: editing.to ?? "",
      label:
        typeof editing.body === "string"
          ? editing.body
          : typeof editing.label === "string"
            ? editing.label
            : "",
    };
  if (kind === "character")
    return {
      body: editing.body || "",
      alias: editing.alias || "",
      appearance: editing.appearance || "",
      personality: editing.personality || "",
      goal: editing.goal || "",
      motive: editing.motive || "",
      conflict: editing.conflict || "",
      speech: editing.speech || "",
      note: editing.note || "",
      // 防崩 / 扮演约束
      temperament: editing.temperament || "",
      taboo: editing.taboo || "",
      knowledge: editing.knowledge || "",
      checklist: editing.checklist || "",
      progressions: (Array.isArray(editing.progressions) ? editing.progressions : [])
        .slice(0, 100)
        .map((entry: any) => ({
          chapterId: String(entry?.chapterId || ""),
          chapterTitle: String(entry?.chapterTitle || "").trim().slice(0, 120),
          change: String(entry?.change || "").trim().slice(0, 160),
          evidence: String(entry?.evidence || "").trim().slice(0, 1200),
        }))
        .filter((entry: any) => entry.change || entry.evidence),
    };
  if (kind === "world")
    return { body: editing.body || "", category: editing.category || "", alias: editing.alias || "" };
  return { body: editing.body || "" };
}

export function normalizeLibraryDraft(kind: string, d: any) {
  if (!d) return "";
  return JSON.stringify({
    id: d.id || "",
    kind,
    title: String(d.title || "").trim(),
    status: d.status || "idea",
    body: String(d.body || ""),
    when: String(d.when || ""),
    from: String(d.from || ""),
    to: String(d.to || ""),
    payoff: String(d.payoff || ""),
    resolved: Boolean(d.resolved),
    plantAt: String(d.plantAt || ""),
    planAt: String(d.planAt || ""),
    prereq: String(d.prereq || ""),
    effect: String(d.effect || ""),
    importance: String(d.importance || ""),
    hook: String(d.hook || ""),
    plotRole: String(d.plotRole || ""),
    coolPoint: String(d.coolPoint || ""),
    cast: String(d.cast || ""),
    pov: String(d.pov || ""),
    plotlinesText: String(d.plotlinesText ?? (Array.isArray(d.plotlines) ? d.plotlines.join("，") : d.plotlines || "")),
    alias: String(d.alias || ""),
    appearance: String(d.appearance || ""),
    personality: String(d.personality || ""),
    goal: String(d.goal || ""),
    motive: String(d.motive || ""),
    conflict: String(d.conflict || ""),
    speech: String(d.speech || ""),
    note: String(d.note || ""),
    temperament: String(d.temperament || ""),
    taboo: String(d.taboo || ""),
    knowledge: String(d.knowledge || ""),
    checklist: String(d.checklist || ""),
    progressions: (Array.isArray(d.progressions) ? d.progressions : []).map((entry: any) => ({
      chapterId: String(entry?.chapterId || ""),
      chapterTitle: String(entry?.chapterTitle || ""),
      change: String(entry?.change || ""),
      evidence: String(entry?.evidence || ""),
    })),
    category: String(d.category || ""),
    tagsText: String(d.tagsText || ""),
    chapterId: d.chapter_id || d.chapterId || "",
  });
}

/** 灵感命名：本地词库，不调用外部 AI */
export const NAME_SEEDS: Record<string, { zh: string; en: string; items: string[] }> = {
  person: {
    zh: "人名",
    en: "Character names",
    items: ["沈砚清", "顾长风", "洛清欢", "萧景行", "叶知秋", "白微澜", "陆沉舟", "苏晚晴", "霍临川", "温言", "裴照", "江浸月"],
  },
  place: {
    zh: "地名",
    en: "Places",
    items: ["青岚宗", "听雪城", "万剑冢", "落星滩", "无妄海", "长夜关", "白鹭书院", "鬼市", "沉香渡", "剑冢峰"],
  },
  faction: {
    zh: "势力",
    en: "Factions",
    items: ["天机阁", "巡夜司", "药王谷", "铁衣卫", "无相殿", "商会总会", "守夜人", "剑心斋"],
  },
  item: {
    zh: "物品/法宝",
    en: "Items",
    items: ["断水剑", "青玉盏", "玄铁令牌", "沧海镜", "九转金丹", "寒潭珠", "龙鳞甲", "追魂香"],
  },
  skill: {
    zh: "功法/技能",
    en: "Skills",
    items: ["踏雪无痕", "听风辨位", "破军枪", "凝血诀", "空明掌", "引雷术", "缩地成寸"],
  },
  monster: {
    zh: "怪物/异种",
    en: "Creatures",
    items: ["赤目狼王", "雾隐蟒", "噬魂鸦", "石傀", "夜叉", "冰魄蜂后"],
  },
};

export function pickNames(kind: string, count = 8): string[] {
  const pool = NAME_SEEDS[kind]?.items || NAME_SEEDS.person.items;
  const out: string[] = [];
  const used = new Set<string>();
  while (out.length < Math.min(count, pool.length)) {
    const x = pool[Math.floor(Math.random() * pool.length)];
    if (used.has(x)) continue;
    used.add(x);
    out.push(x);
  }
  return out;
}

/** 资料体检：缺字段 / 重名 / 伏笔未回收 —— 不读正文 */
export type HealthIssue = {
  level: "info" | "warn" | "error";
  message: string;
};
export function scanLibraryHealth(items: any[], language: "zh-CN" | "en" = "zh-CN"): HealthIssue[] {
  const zh = language !== "en";
  const issues: HealthIssue[] = [];
  const seenTitle = new Map<string, number>();
  for (const raw of items || []) {
    const c = parseJson(raw.content_json || "{}");
    const kind = raw.kind || "";
    const title = String(raw.title || "").trim();
    const key = `${kind}:${title}`;
    seenTitle.set(key, (seenTitle.get(key) || 0) + 1);
    if (!title)
      issues.push({
        level: "warn",
        message: zh ? `${kind} 存在空标题条目` : `Empty title in ${kind}`,
      });
    if (kind === "character" && !String(c.alias || c.body || "").trim())
      issues.push({
        level: "info",
        message: zh ? `人物「${title || "未命名"}」缺少别名或简介` : `Character "${title}" missing alias/summary`,
      });
    if (kind === "foreshadow" && !c.resolved && !String(c.payoff || c.planAt || "").trim())
      issues.push({
        level: "warn",
        message: zh ? `伏笔「${title || "未命名"}」未回收且无回收说明` : `Foreshadow "${title}" unresolved without payoff note`,
      });
    if (kind === "relation" && !(c.from && c.to))
      issues.push({
        level: "error",
        message: zh ? `人物关系「${title || "未命名"}」缺少双方` : `Relation "${title}" missing endpoints`,
      });
  }
  for (const [key, n] of seenTitle) {
    if (n > 1)
      issues.push({
        level: "info",
        message: zh ? `存在 ${n} 条同名条目：${key.split(":").slice(1).join(":")}` : `${n} duplicate titles: ${key}`,
      });
  }
  if (!items?.length)
    issues.push({ level: "info", message: zh ? "资料库为空" : "Story bible is empty" });
  return issues;
}
