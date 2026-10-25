import { normalizeSceneCustomFields } from "./scene-fields";

export type MaterialSuggestion = {
  id: string;
  kind: string;
  title: string;
  content: string;
  matched: string;
  matchedSnippet?: string;
  count: number;
  score: number;
  reasons: string[];
};

type Material = Record<string, any>;
export type MaterialMatchContext = {
  chapterId?: string | null;
  selectionText?: string;
  chapterTitles?: Record<string, string>;
  chapterOrder?: Record<string, number>;
  language?: string;
};

function parseObject(value: unknown): Record<string, any> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseAliases(contentJson: string): string[] {
  const alias = String(parseObject(contentJson).alias || "");
  return alias.split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);
}

function parseTags(tagsJson: unknown): string[] {
  try {
    const parsed = typeof tagsJson === "string" ? JSON.parse(tagsJson || "[]") : tagsJson;
    if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    // Old/hand-edited rows may contain comma-separated tags rather than JSON.
  }
  return String(tagsJson || "").split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(corpus: string, term: string) {
  if (!term || term.length < 2) return 0;
  return (corpus.match(new RegExp(escapeRegExp(term), "g")) || []).length;
}

function excerptAroundMatch(source: string, rawTerm: string, maxLength = 132) {
  const term = String(rawTerm || "").trim();
  if (!source || !term || term.length > maxLength - 8) return "";
  const lowerSource = source.toLocaleLowerCase();
  const lowerTerm = term.toLocaleLowerCase();
  let start = lowerSource.indexOf(lowerTerm);
  let end = start < 0 ? -1 : start + lowerTerm.length;
  let excerptSource = source;
  if (start < 0) {
    excerptSource = source.normalize("NFKC");
    start = excerptSource.toLocaleLowerCase().indexOf(term.normalize("NFKC").toLocaleLowerCase());
    if (start < 0) return "";
    end = start + term.normalize("NFKC").length;
  }
  const context = Math.max(16, Math.floor((maxLength - (end - start)) / 2));
  const from = Math.max(0, start - context);
  const to = Math.min(excerptSource.length, end + context);
  let excerpt = excerptSource.slice(from, to).replace(/\s+/g, " ").trim();
  if (from > 0) excerpt = `…${excerpt}`;
  if (to < excerptSource.length) excerpt = `${excerpt}…`;
  if (excerpt.length > maxLength) excerpt = `${excerpt.slice(0, maxLength - 1).trimEnd()}…`;
  return excerpt;
}

const KEYWORD_FIELDS: Record<string, string[]> = {
  character: ["body", "goal", "motive", "conflict", "personality", "speech", "knowledge", "taboo", "checklist"],
  world: ["body"],
  scene: ["body", "coolPoint", "hook"],
  foreshadow: ["body", "prereq", "payoff", "effect"],
  timeline: ["body"],
  relation: ["body"],
  outline: ["body"],
  inspiration: ["body"],
};

const COMMON_KEYWORDS = new Set([
  "一个", "一些", "这个", "那个", "自己", "可以", "因为", "所以", "但是", "然后", "如果", "已经", "还是", "只是", "没有", "不是", "需要", "进行", "出现", "发生", "能够", "通过", "对于", "关于", "其中", "之后", "之前", "时候", "地方", "东西", "人物", "角色", "故事", "章节", "场景", "正文", "设定",
]);

/** Extract bounded, locally searchable phrases; CJK uses overlapping bigrams/trigrams without claiming semantic understanding. */
function contentKeywords(kind: string, content: Record<string, any>): string[] {
  const values = (KEYWORD_FIELDS[kind] || ["body"])
    .flatMap((field) => {
      const value = content[field];
      return Array.isArray(value) ? value.map((item) => String(item || "")) : [String(value || "")];
    })
    .join(" ")
    .slice(0, 2400);
  const keywords = new Set<string>();
  const chunks = values.split(/[\s，,。.!！?？；;：:、（）()\[\]【】{}<>“”‘’"'—–-]+/u);
  for (const chunk of chunks) {
    const normalized = normalize(chunk);
    if (!normalized) continue;
    for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu)) {
      const token = match[0];
      if (/^[\p{Script=Han}]+$/u.test(token)) {
        for (let index = 0; index <= token.length - 2; index += 1) {
          const phrase = token.slice(index, index + 2);
          if (!COMMON_KEYWORDS.has(phrase)) keywords.add(phrase);
          if (keywords.size >= 160) return [...keywords];
        }
        for (let index = 0; index <= token.length - 3; index += 1) {
          const phrase = token.slice(index, index + 3);
          if (!COMMON_KEYWORDS.has(phrase)) keywords.add(phrase);
          if (keywords.size >= 160) return [...keywords];
        }
      } else if (!COMMON_KEYWORDS.has(token)) {
        keywords.add(token);
      }
      if (keywords.size >= 160) return [...keywords];
    }
  }
  return [...keywords];
}

type CachedMaterialKeywords = { kind: string; source: unknown; terms: string[] };
const materialKeywordCache = new WeakMap<object, CachedMaterialKeywords>();

/** Cache extracted terms per immutable library row; context edits reuse this work. */
function indexedContentKeywords(material: Material): string[] {
  const kind = String(material.kind || "");
  const source = material.content_json;
  const cached = materialKeywordCache.get(material);
  if (cached && cached.kind === kind && cached.source === source) return cached.terms;
  const terms = contentKeywords(kind, parseObject(source));
  materialKeywordCache.set(material, { kind, source, terms });
  return terms;
}

function chinesePhraseCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/[\p{Script=Han}]+/gu)) {
    const run = match[0];
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        const phrase = run.slice(index, index + size);
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }
  return counts;
}

function contextContent(
  item: Material,
  maxChars = 6000,
  chapterTitles: Record<string, string> = {},
  chapterOrder: Record<string, number> = {},
  currentChapterId?: string | null,
) {
  const c = parseObject(item.content_json);
  const fields: Record<string, string[]> = {
    character: ["alias", "body", "goal", "motive", "conflict", "personality", "speech", "knowledge", "taboo", "checklist"],
    world: ["category", "alias", "body"],
    scene: ["when", "targetWords", "pov", "plotlines", "customFields", "plotRole", "cast", "coolPoint", "hook", "body"],
    foreshadow: ["body", "plantAt", "planAt", "prereq", "payoff", "effect", "importance"],
    timeline: ["when", "body"],
    relation: ["label", "body"],
    outline: ["body"],
    inspiration: ["body"],
  };
  const labels: Record<string, string> = {
    body: "说明", goal: "目标", motive: "动机", conflict: "矛盾", personality: "性格",
    speech: "语言习惯", knowledge: "知识边界", taboo: "底线", checklist: "核对项",
    category: "分类", alias: "别名", when: "位置/时间", targetWords: "目标字数", pov: "视角人物", plotlines: "剧情线", customFields: "自定义属性", plotRole: "剧情作用", cast: "出场人物",
    coolPoint: "回报", hook: "钩子", plantAt: "埋设位置", planAt: "计划回收",
    prereq: "回收前提", payoff: "回收方式", effect: "回收影响", importance: "重要度",
    label: "关系",
  };
  const parts = (fields[item.kind] || ["body"])
    .map((key) => [labels[key] || key, (key === "customFields"
      ? normalizeSceneCustomFields(c.customFields).map((field) => `${field.key}：${field.value}`).join("；")
      : Array.isArray(c[key])
        ? c[key].map((value: unknown) => String(value || "").trim()).filter(Boolean).join("、")
        : String(c[key] || "")).trim()] as const)
    .filter(([, value]) => value);
  const hasWorldTimeline = item.kind === "world" && ["地点", "势力"].includes(String(c.category || ""));
  if ((item.kind === "character" || hasWorldTimeline) && Array.isArray(c.progressions) && c.progressions.length) {
    const currentOrder = currentChapterId ? chapterOrder[currentChapterId] : undefined;
    const progressions = c.progressions
      .slice()
      .filter((entry: any) => entry && (String(entry.change || "").trim() || String(entry.evidence || "").trim()))
      .filter((entry: any) => {
        const entryChapterId = String(entry.chapterId || "");
        const entryOrder = entryChapterId ? chapterOrder[entryChapterId] : undefined;
        return currentOrder === undefined || entryOrder === undefined || entryOrder <= currentOrder;
      })
      .sort((left: any, right: any) => {
        const leftOrder = chapterOrder[String(left.chapterId || "")] ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = chapterOrder[String(right.chapterId || "")] ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder;
      })
      .map((entry: any) => {
        const chapterTitle = chapterTitles[String(entry.chapterId || "")] || String(entry.chapterTitle || "").trim() || "未关联章节";
        const change = String(entry.change || "").trim();
        const evidence = String(entry.evidence || "").trim();
        return `- ${chapterTitle}：${change || "阶段记录"}${evidence ? `（依据：${evidence}）` : ""}`;
      });
    if (progressions.length)
      parts.push([
        hasWorldTimeline ? "作者确认的地点 / 势力沿革" : "作者确认的阶段变化",
        progressions.join("\n"),
      ]);
  }
  const tags = parseTags(item.tags_json);
  if (tags.length) parts.push(["标签", tags.join("、")]);
  if (item.kind === "relation") {
    const from = String(item.from || "?").trim();
    const to = String(item.to || "?").trim();
    parts.unshift(["人物", `${from} — ${to}`]);
  }
  const status = item.status === "confirmed" ? "已确认" : "待确认";
  const text = [`【${String(item.title || "未命名资料").trim()} · ${status}】`, ...parts.map(([label, value]) => `${label}：${value}`)].join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[资料片段已截断]` : text;
}

/**
 * 在本地从正文与选区的实体提及、资料标签、人物别名和章节关联中，给出可解释的引用候选。
 * 这里只排序建议，不会自动把候选写入 AI 上下文。
 */
export function relevantMaterials(
  items: Material[],
  corpus: string,
  limit = 12,
  context: MaterialMatchContext = {},
): MaterialSuggestion[] {
  const text = normalize(corpus || "");
  const selection = normalize(context.selectionText || "");
  if (!text && !selection) return [];
  const textChinesePhrases = chinesePhraseCounts(text);
  const selectionChinesePhrases = chinesePhraseCounts(selection);
  const out: MaterialSuggestion[] = [];
  const seen = new Set<string>();
  const keywordTermsByMaterial = new Map<string, string[]>();
  const keywordDocumentFrequency = new Map<string, number>();
  for (const material of items) {
    if (!material || material.deleted_at || !material.id) continue;
    const key = `${material.kind}:${material.id}`;
    const terms = indexedContentKeywords(material);
    if (!terms.length) continue;
    keywordTermsByMaterial.set(key, terms);
    for (const term of terms) keywordDocumentFrequency.set(term, (keywordDocumentFrequency.get(term) || 0) + 1);
  }
  const keywordDocumentCount = keywordTermsByMaterial.size;
  for (const item of items) {
    if (!item || item.deleted_at || !item.id) continue;
    const content = parseObject(item.content_json);
    const title = String(item.title || "").trim();
    const participantTerms = item.kind === "relation"
      ? [String(item.from || "").trim(), String(item.to || "").trim()]
      : item.kind === "scene"
        ? [String(content.pov || "").trim(), ...String(content.cast || "").split(/[,，、;；]+/).map((s) => s.trim())]
        : [];
    const plotlines = item.kind === "scene"
      ? (Array.isArray(content.plotlines) ? content.plotlines : String(content.plotlines || "").split(/[,，、;；\n]+/))
          .map((value: unknown) => String(value || "").trim()).filter(Boolean)
      : [];
    const customFields = item.kind === "scene" ? normalizeSceneCustomFields(content.customFields) : [];
    const aliases = item.kind === "character" || item.kind === "world" ? parseAliases(item.content_json) : [];
    const tags = parseTags(item.tags_json);
    const terms = new Map<string, "title" | "alias" | "tag" | "person" | "plotline" | "custom" | "keyword">();
    if (title) terms.set(title, "title");
    for (const term of aliases) if (!terms.has(term)) terms.set(term, "alias");
    for (const term of participantTerms) if (term && !terms.has(term)) terms.set(term, "person");
    for (const term of plotlines) if (term && !terms.has(term)) terms.set(term, "plotline");
    for (const field of customFields) {
      if (!terms.has(field.key)) terms.set(field.key, "custom");
      if (!terms.has(field.value)) terms.set(field.value, "custom");
    }
    for (const term of tags) if (term && !terms.has(term)) terms.set(term, "tag");
    for (const term of keywordTermsByMaterial.get(`${item.kind}:${item.id}`) || [])
      if (term && !terms.has(term)) terms.set(term, "keyword");

    let score = 0;
    let count = 0;
    let matched = "";
    let bestWeighted = 0;
    let matchedSnippet = "";
    let snippetWeight = 0;
    const reasons: string[] = [];
    let participantsHit = 0;
    const en = context.language === "en";
    const commonKeywordLimit = Math.max(5, Math.ceil(keywordDocumentCount * 0.3));
    for (const [rawTerm, type] of terms) {
      const term = normalize(rawTerm);
      if (type === "keyword" && (keywordDocumentFrequency.get(term) || 0) > commonKeywordLimit) continue;
      const isChinesePhrase = type === "keyword" && /^[\p{Script=Han}]{2,3}$/u.test(term);
      const fullCount = isChinesePhrase
        ? textChinesePhrases.get(term) || 0
        : countOccurrences(text, term);
      const selectionCount = isChinesePhrase
        ? selectionChinesePhrases.get(term) || 0
        : countOccurrences(selection, term);
      const weight = type === "title" ? 3 : type === "tag" ? 1 : 2;
      const documentFrequency = keywordDocumentFrequency.get(term) || 1;
      const keywordWeight = Math.min(2.25, 0.55 + Math.log2((keywordDocumentCount + 1) / (documentFrequency + 1)) * 0.3);
      const weighted = type === "keyword"
        ? Math.min(fullCount, 4) * keywordWeight + Math.min(selectionCount, 3) * 3
        : fullCount * weight + selectionCount * 3;
      if (!fullCount && !selectionCount) continue;
      score += weighted;
      if (type === "person") participantsHit += 1;
      if (fullCount > count || (fullCount === count && selectionCount && !matched)) {
        count = fullCount;
        matched = rawTerm;
      }
      bestWeighted = Math.max(bestWeighted, weighted);
      if ((fullCount || selectionCount) && weighted > snippetWeight) {
        const snippetSource = selectionCount ? context.selectionText || corpus : corpus;
        const snippet = excerptAroundMatch(snippetSource, rawTerm);
        if (snippet) {
          matchedSnippet = snippet;
          snippetWeight = weighted;
        }
      }
      if (selectionCount) reasons.push(en ? `Selection mentions “${rawTerm}” ${selectionCount} time(s)` : `选区提及「${rawTerm}」${selectionCount} 次`);
      else if (type === "title") reasons.push(en ? `Text mentions “${rawTerm}” · ${fullCount}` : `正文提及「${rawTerm}」${fullCount} 次`);
      else if (type === "alias") reasons.push(en ? `Alias match “${rawTerm}” · ${fullCount}` : `命中别名「${rawTerm}」${fullCount} 次`);
      else if (type === "person") reasons.push(en ? `Mentioned character “${rawTerm}” · ${fullCount}` : `提及人物「${rawTerm}」${fullCount} 次`);
      else if (type === "plotline") reasons.push(en ? `Plotline match “${rawTerm}” · ${fullCount}` : `命中剧情线「${rawTerm}」${fullCount} 次`);
      else if (type === "custom") reasons.push(en ? `Custom property match “${rawTerm}” · ${fullCount}` : `命中自定义属性「${rawTerm}」${fullCount} 次`);
      else if (type === "keyword") reasons.push(en ? `Material keyword fragment “${rawTerm}” · ${fullCount}` : `命中资料关键词片段「${rawTerm}」${fullCount} 次`);
      else reasons.push(en ? `Tag match “${rawTerm}” · ${fullCount}` : `命中标签「${rawTerm}」${fullCount} 次`);
    }
    if (item.kind === "relation" && participantsHit >= 2) {
      score += 4;
      reasons.unshift(en ? "Both sides of this relationship appear in the text" : "关系双方均在正文出现");
    }
    if (item.kind === "scene" && context.chapterId && item.chapter_id === context.chapterId) {
      score += 8;
      reasons.unshift(en ? "Linked to the current chapter" : "已关联当前章节");
    }
    if (score <= 0) continue;
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: item.id,
      kind: item.kind,
      title: item.kind === "relation" ? `${item.from || "?"} 与 ${item.to || "?"}` : title || "未命名资料",
      content: contextContent(item, 6000, context.chapterTitles, context.chapterOrder, context.chapterId),
      matched: matched || String(item.title || "").trim(),
      matchedSnippet: matchedSnippet || undefined,
      count,
      score: score + bestWeighted * 0.01,
      reasons: [...new Set(reasons)].slice(0, 3),
    });
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count).slice(0, Math.max(0, limit));
}

/** 统一构造手动引用与推荐引用的资料内容，避免只发送人物卡的一句简介。 */
export function materialReferenceContent(
  item: Material,
  maxChars = 6000,
  chapterTitles: Record<string, string> = {},
  chapterOrder: Record<string, number> = {},
  currentChapterId?: string | null,
) {
  return contextContent(item, maxChars, chapterTitles, chapterOrder, currentChapterId);
}
