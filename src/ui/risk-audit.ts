/**
 * 发布前风险自检：只做本地提示，不联网、不自动改稿。
 *
 * 覆盖码字软件常见的「导出/发布前检查」场景：
 * - 联系方式与站外导流（手机号、邮箱、网址、QQ、微信）
 * - 明显的广告/交易用语
 * - 作者自定义词表
 *
 * 结果仅供作者核对，命中不代表内容违规，也不会被写回正文。
 */

export type RiskCategory = "contact" | "promotion" | "custom";

export type RiskSource = { id: string; label: string; text: string };

export type RiskFinding = {
  term: string;
  category: RiskCategory;
  count: number;
  /** 命中过的来源标签，按首次出现顺序去重 */
  sources: string[];
};

export type RiskAuditResult = {
  findings: RiskFinding[];
  /** 扫描的来源数量，便于界面说明覆盖范围 */
  sourceCount: number;
  totalHits: number;
};

export const RISK_CATEGORY_LABEL: Record<RiskCategory, [string, string]> = {
  contact: ["联系方式 / 站外导流", "Contact details / off-platform links"],
  promotion: ["广告或交易用语", "Advertising or transaction wording"],
  custom: ["自定义词", "Custom term"],
};

const BUILTIN_PATTERNS: Array<{
  category: RiskCategory;
  pattern: RegExp;
}> = [
  // 大陆手机号：前后不能紧邻数字，避免把订单号、年份串误判
  { category: "contact", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { category: "contact", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    category: "contact",
    pattern: /(?:https?:\/\/|www\.)[^\s，。；、！？）)】」』"']+/gi,
  },
  // QQ 只在有明确前缀时提示，避免把普通数字串当成账号
  { category: "contact", pattern: /(?:QQ|qq|企鹅号|企鹅群)\s*(?:[:：号群]\s*){0,2}[1-9]\d{4,10}/g },
  {
    category: "contact",
    pattern: /(?:微信|weixin|wechat|vx|VX)\s*[:：号]?\s*[A-Za-z][-_A-Za-z0-9]{5,19}/g,
  },
  {
    category: "promotion",
    pattern: /(?:加群|进群|书友群|粉丝群|交流群|私聊|私信|代写|代发|刷单|刷量|返利|领红包|优惠券)/g,
  },
];

const MAX_CUSTOM_TERMS = 200;
const MAX_CUSTOM_TERM_LENGTH = 40;

/** 规范化自定义词：去空白、去重、限制数量与长度。 */
export function normalizeRiskTerms(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : String(input ?? "").split(/[\n,，、;；]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const term = String(item ?? "").trim();
    if (!term || term.length > MAX_CUSTOM_TERM_LENGTH) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_CUSTOM_TERMS) break;
  }
  return out;
}

function patternHits(text: string) {
  const hits: Array<{ term: string; category: RiskCategory }> = [];
  for (const { category, pattern } of BUILTIN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const term = String(match[0] || "").trim();
      if (term) hits.push({ term, category });
    }
  }
  return hits;
}

function customHits(text: string, terms: readonly string[]) {
  const hits: Array<{ term: string; category: RiskCategory }> = [];
  if (!terms.length) return hits;
  const lower = text.toLocaleLowerCase();
  for (const term of terms) {
    const needle = term.toLocaleLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      hits.push({ term, category: "custom" });
      from = at + Math.max(1, needle.length);
    }
  }
  return hits;
}

/** 统计单段文本的风险词命中，返回按首次出现排序的结果。 */
export function findRiskHits(text: string, customTerms: unknown = []): RiskFinding[] {
  const source = String(text ?? "");
  if (!source) return [];
  const terms = normalizeRiskTerms(customTerms);
  const merged = new Map<string, RiskFinding>();
  for (const hit of [...patternHits(source), ...customHits(source, terms)]) {
    const key = hit.term.toLocaleLowerCase();
    const current = merged.get(key);
    if (current) current.count += 1;
    else
      merged.set(key, {
        term: hit.term,
        category: hit.category,
        count: 1,
        sources: [],
      });
  }
  return [...merged.values()];
}

/**
 * 汇总多个来源（章节）的风险词命中。
 * 同一词在不同章节分别计数，但只展示一行，避免长书结果爆炸。
 */
export function auditRiskSources(
  sources: readonly RiskSource[],
  customTerms: unknown = [],
): RiskAuditResult {
  const merged = new Map<string, RiskFinding>();
  let totalHits = 0;
  for (const source of sources) {
    for (const hit of findRiskHits(source.text, customTerms)) {
      totalHits += hit.count;
      const key = hit.term.toLocaleLowerCase();
      const current = merged.get(key);
      if (current) {
        current.count += hit.count;
        if (!current.sources.includes(source.label))
          current.sources.push(source.label);
      } else {
        merged.set(key, {
          term: hit.term,
          category: hit.category,
          count: hit.count,
          sources: [source.label],
        });
      }
    }
  }
  const order: Record<RiskCategory, number> = {
    contact: 0,
    promotion: 1,
    custom: 2,
  };
  const findings = [...merged.values()].sort(
    (a, b) =>
      order[a.category] - order[b.category] ||
      b.count - a.count ||
      a.term.localeCompare(b.term),
  );
  return { findings, sourceCount: sources.length, totalHits };
}
