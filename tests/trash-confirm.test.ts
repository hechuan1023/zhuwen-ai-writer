import { describe, expect, it } from "vitest";
import {
  PURGE_CONFIRM_WORDS,
  isPurgeConfirmed,
  purgeConfirmWord,
} from "../src/ui/trash-confirm";

describe("永久删除的强确认", () => {
  it("按界面语言给出确认词", () => {
    expect(purgeConfirmWord("zh-CN")).toBe("永久删除");
    expect(purgeConfirmWord("en")).toBe("DELETE");
    // 缺省语言按中文处理
    expect(purgeConfirmWord()).toBe("永久删除");
  });

  it("只接受逐字输入的确认词", () => {
    expect(isPurgeConfirmed("永久删除", "zh-CN")).toBe(true);
    expect(isPurgeConfirmed("DELETE", "en")).toBe(true);
  });

  it("容忍首尾空白，但不接受其他写法", () => {
    expect(isPurgeConfirmed("  永久删除  ", "zh-CN")).toBe(true);
    expect(isPurgeConfirmed("  DELETE ", "en")).toBe(true);

    // 这些一旦通过，强确认就退化成了单击确认
    expect(isPurgeConfirmed("永久", "zh-CN")).toBe(false);
    expect(isPurgeConfirmed("删除", "zh-CN")).toBe(false);
    expect(isPurgeConfirmed("确定", "zh-CN")).toBe(false);
    expect(isPurgeConfirmed("", "zh-CN")).toBe(false);
    expect(isPurgeConfirmed("   ", "zh-CN")).toBe(false);
  });

  it("不接受另一种语言下的确认词", () => {
    expect(isPurgeConfirmed("DELETE", "zh-CN")).toBe(false);
    expect(isPurgeConfirmed("永久删除", "en")).toBe(false);
  });

  it("确认词与服务端 trash:purge 接受的字面量一致", () => {
    // 依据 electron/main.ts: !["永久删除", "DELETE"].includes(p.confirm)
    expect([...PURGE_CONFIRM_WORDS]).toEqual(["永久删除", "DELETE"]);
    for (const word of PURGE_CONFIRM_WORDS) {
      const language = word === "DELETE" ? "en" : "zh-CN";
      expect(purgeConfirmWord(language)).toBe(word);
      expect(isPurgeConfirmed(word, language)).toBe(true);
    }
  });
});
