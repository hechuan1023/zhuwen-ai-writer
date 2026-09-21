import { describe, expect, it } from "vitest";
import { BASE_STYLE_RULES, BUILTIN_STYLE_CARDS, NATURALIZE_RULES, buildTaskAndStyleInstructions, styleInstruction } from "../electron/ai-style-cards";

describe("AI 写作风格卡", () => {
  it("提供四张稳定 ID 的内置卡，且不包含旧式硬性配额", () => {
    expect(BUILTIN_STYLE_CARDS).toHaveLength(4);
    expect(new Set(BUILTIN_STYLE_CARDS.map((x) => x.id)).size).toBe(4);
    const all = BUILTIN_STYLE_CARDS.map((x) => x.rules).join("\n");
    expect(all).not.toMatch(/对话.{0,8}(比例|占比)|每章必须|固定.{0,8}(数量|比例)/);
    for (const card of BUILTIN_STYLE_CARDS) expect(card.rules).toContain(BASE_STYLE_RULES);
  });

  it("普通聊天不注入正文风格，续写只注入一次可审阅规则", () => {
    const card = BUILTIN_STYLE_CARDS[0];
    expect(styleInstruction(card, "chat")).toBe("");
    const instruction = styleInstruction(card, "continue");
    expect(instruction).toContain(card.name);
    expect(instruction.match(/当前写作风格/g)).toHaveLength(1);
  });

  it("自然化规则明确保留原稿事实并禁止未经授权扩写", () => {
    expect(NATURALIZE_RULES).toContain("保留原有情节顺序");
    expect(NATURALIZE_RULES).toContain("不要新增人物、能力、重大反转或结局");
  });

  it("没有风格卡时自然化规则仍独立生效，且只出现一次", () => {
    const instruction = buildTaskAndStyleInstructions(null, "naturalize");
    expect(instruction).toContain(NATURALIZE_RULES);
    expect(instruction.match(/请修改引用的原创小说正文/g)).toHaveLength(1);
    expect(buildTaskAndStyleInstructions(null, "chat")).toBe("");
  });
});
