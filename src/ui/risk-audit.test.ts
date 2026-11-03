import { describe, expect, it } from "vitest";
import {
  auditRiskSources,
  findRiskHits,
  normalizeRiskTerms,
} from "./risk-audit";

describe("发布前风险自检", () => {
  it("识别手机号、邮箱、网址、QQ 与微信，并保留原始写法", () => {
    const text = [
      "有事联系 13812345678，邮箱 writer@example.com。",
      "主页 https://example.com/novel 或 www.example.org",
      "QQ群：123456789，微信：wxid_abc123",
    ].join("\n");
    const terms = findRiskHits(text).map((hit) => hit.term);
    expect(terms).toContain("13812345678");
    expect(terms).toContain("writer@example.com");
    expect(terms).toContain("https://example.com/novel");
    expect(terms).toContain("www.example.org");
    expect(terms).toContain("QQ群：123456789");
    expect(terms).toContain("微信：wxid_abc123");
    for (const hit of findRiskHits(text)) expect(hit.category).toBe("contact");
  });

  it("不把普通长数字、年份或章节号误判成手机号", () => {
    const text = "订单号 1234567890123，2026 年第 138 章，存货 1381234567890 件。";
    expect(findRiskHits(text)).toEqual([]);
  });

  it("只在有明确前缀时提示 QQ 号，广告用语单独归类", () => {
    const text = "书友群欢迎加入，私聊可领优惠券。暗号 987654321。";
    const hits = findRiskHits(text);
    expect(hits.map((hit) => hit.term)).toEqual(
      expect.arrayContaining(["书友群", "私聊", "优惠券"]),
    );
    expect(hits.every((hit) => hit.category === "promotion")).toBe(true);
    expect(hits.some((hit) => hit.term.includes("987654321"))).toBe(false);
  });

  it("自定义词支持换行/中英文逗号分隔、去重与长度上限", () => {
    expect(normalizeRiskTerms("甲方, 甲方\n乙方、乙方；丙方")).toEqual([
      "甲方",
      "乙方",
      "丙方",
    ]);
    expect(normalizeRiskTerms([" x ", "X", "", "a".repeat(41)])).toEqual(["x"]);
    expect(normalizeRiskTerms(Array.from({ length: 300 }, (_, i) => `词${i}`))).toHaveLength(200);
    const hits = findRiskHits("甲方说甲方不改，乙方同意。", ["甲方", "乙方"]);
    expect(hits).toEqual([
      { term: "甲方", category: "custom", count: 2, sources: [] },
      { term: "乙方", category: "custom", count: 1, sources: [] },
    ]);
  });

  it("跨章节汇总同一词，按类别、次数与词面稳定排序", () => {
    const result = auditRiskSources(
      [
        { id: "c1", label: "第一章", text: "加群领红包，联系 13812345678。" },
        { id: "c2", label: "第二章", text: "加群再说，微信：wxid_abc123。" },
        { id: "c3", label: "第三章", text: "甲方未出现。" },
      ],
      ["甲方"],
    );
    expect(result.sourceCount).toBe(3);
    expect(result.totalHits).toBe(6);
    expect(
      result.findings.find((hit) => hit.term === "加群"),
    ).toMatchObject({
      term: "加群",
      category: "promotion",
      count: 2,
      sources: ["第一章", "第二章"],
    });
    expect(result.findings.map((hit) => hit.category)).toEqual([
      "contact",
      "contact",
      "promotion",
      "promotion",
      "custom",
    ]);
    expect(result.findings.find((hit) => hit.term === "甲方")?.count).toBe(1);
  });

  it("空文本与无自定义词时安全返回", () => {
    expect(findRiskHits("")).toEqual([]);
    expect(auditRiskSources([])).toEqual({
      findings: [],
      sourceCount: 0,
      totalHits: 0,
    });
  });
});
