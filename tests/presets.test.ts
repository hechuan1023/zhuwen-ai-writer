import { describe, expect, it } from "vitest";
import {
  buildEnvironment,
  defaultPreset,
  sanitizePresetName,
  validateEnvironment,
} from "../src/ui/presets";

describe("validateEnvironment：字段校验与边界", () => {
  it("panel opacity is compatible with old presets and bounded", () => {
    expect(validateEnvironment({}).panelOpacity).toBe(0.72);
    expect(validateEnvironment({ panelOpacity: 0 }).panelOpacity).toBe(0.35);
    expect(validateEnvironment({ panelOpacity: 3 }).panelOpacity).toBe(1);
    expect(validateEnvironment({ panelOpacity: 0.55 }).panelOpacity).toBe(0.55);
  });
  it("排版字段被钳制到合法范围", () => {
    const env = validateEnvironment({
      fontSize: 999,
      lineHeight: 0.1,
      readingWidth: 50,
      editorZoom: 5,
      paperOpacity: 3,
    });
    expect(env.fontSize).toBe(30);
    expect(env.lineHeight).toBe(1.4);
    expect(env.readingWidth).toBe(480);
    expect(env.editorZoom).toBe(1.8);
    expect(env.paperOpacity).toBe(1);
  });

  it("非法类型回落默认值", () => {
    const env = validateEnvironment({ fontSize: "abc", theme: "neon" });
    expect(env.fontSize).toBe(17);
    expect(env.theme).toBe("warm");
    expect(env.fontFamily).toBeTruthy();
  });

  it("剔除无关字段：语言、密钥、减少动效不进入环境", () => {
    const env = validateEnvironment({
      language: "en",
      aiApiKey: "sk-secret",
      reduceMotion: true,
      backgroundFit: "tile",
      fontSize: 18,
    });
    expect((env as any).language).toBeUndefined();
    expect((env as any).aiApiKey).toBeUndefined();
    expect((env as any).reduceMotion).toBeUndefined();
    expect(env.backgroundFit).toBe("tile");
    expect(env.fontSize).toBe(18);
  });

  it("布尔字段严格收敛", () => {
    const env = validateEnvironment({ typewriterMode: "yes", focusZen: 1 });
    expect(env.typewriterMode).toBe(true);
    expect(env.focusZen).toBe(true);
    const off = validateEnvironment({ typewriterMode: 0, focusZen: null });
    expect(off.typewriterMode).toBe(false);
    expect(off.focusZen).toBe(false);
  });
});

describe("buildEnvironment：真实状态组合", () => {
  it("typography 覆盖 appearance 中的同名排版字段", () => {
    const env = buildEnvironment(
      { theme: "dark", fontSize: 12 },
      { fontSize: 21, lineHeight: 2.4 },
      {},
      false,
    );
    expect(env.theme).toBe("dark");
    expect(env.fontSize).toBe(21);
    expect(env.lineHeight).toBe(2.4);
  });

  it("includeLayout=false 不携带布局字段", () => {
    const env = buildEnvironment({}, {}, { leftWidth: 400, rightWidth: 500 }, false);
    expect(env.leftWidth).toBeUndefined();
    expect(env.rightWidth).toBeUndefined();
  });

  it("includeLayout=true 携带并钳制布局字段", () => {
    const env = buildEnvironment({}, {}, { leftWidth: 9999, rightWidth: 1 }, true);
    expect(env.leftWidth).toBe(520);
    expect(env.rightWidth).toBe(300);
  });

  it("默认预设不含布局字段且可再次通过校验", () => {
    const d = defaultPreset();
    expect(d.includeLayout).toBe(false);
    expect(d.environment.leftWidth).toBeUndefined();
    const again = validateEnvironment(d.environment);
    expect(again).toEqual(d.environment);
  });

  it("预设名称清洗：去空白、限长", () => {
    expect(sanitizePresetName("  夜间小字  ")).toBe("夜间小字");
    expect(sanitizePresetName("长".repeat(60)).length).toBe(40);
    expect(sanitizePresetName("   ")).toBe("");
  });
});
