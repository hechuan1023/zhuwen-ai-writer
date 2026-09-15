export type MaterialSuggestion = {
  id: string;
  kind: string;
  title: string;
  content: string;
  matched: string;
  count: number;
};

function parseAliases(contentJson: string): string[] {
  try {
    const alias = String(JSON.parse(contentJson || "{}").alias || "");
    return alias
      .split(/[,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(corpus: string, term: string) {
  if (!term || term.length < 2) return 0;
  return (corpus.match(new RegExp(escapeRegExp(term), "g")) || []).length;
}

/**
 * 从资料库条目中找出与正文关键词相关的推荐引用。
 * 匹配依据：条目标题（人物卡名、设定名等）或人物关系的两端姓名在正文中出现的次数。
 * 关系条目的展示内容为「A — 关系 → B」；其余为 content_json 中的 body。
 */
export function relevantMaterials(
  items: Record<string, any>[],
  corpus: string,
  limit = 12,
): MaterialSuggestion[] {
  const text = corpus || "";
  const out: MaterialSuggestion[] = [];
  const seen = new Set<string>();
  for (const x of items) {
    if (!x || x.deleted_at) continue;
    let terms: string[];
    if (x.kind === "relation") {
      terms = [String(x.from || "").trim(), String(x.to || "").trim()];
    } else if (x.kind === "character") {
      terms = [String(x.title || "").trim(), ...parseAliases(x.content_json)];
    } else {
      terms = [String(x.title || "").trim()];
    }
    let best = 0;
    let matched = "";
    for (const t of new Set(terms)) {
      const n = countOccurrences(text, t);
      if (n > best) {
        best = n;
        matched = t;
      }
    }
    if (!best) continue;
    const key = `${x.kind}:${x.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let content = "";
    if (x.kind === "relation") {
      try {
        const c = JSON.parse(x.content_json || "{}");
        content = `${x.from || "?"} — ${c.label || "关系"} → ${x.to || "?"}${c.body ? `\n${c.body}` : ""}`;
      } catch {
        content = "";
      }
    } else {
      try {
        content = String(JSON.parse(x.content_json || "{}").body || "");
      } catch {
        content = "";
      }
    }
    out.push({
      id: x.id,
      kind: x.kind,
      title: x.kind === "relation" ? `${x.from} 与 ${x.to}` : x.title,
      content,
      matched,
      count: best,
    });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}
