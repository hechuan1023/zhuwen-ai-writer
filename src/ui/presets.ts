/**
 * 写作环境预设：组合现有 appearance / typography / layout 字段，
 * 不建立平行设置系统。所有入口（保存、应用、预览、默认值）共用
 * validateEnvironment 一份字段定义与校验规则。
 *
 * 边界：语言、AI 连接、密钥、系统减少动效偏好不属于环境预设；
 * 系统减少动效始终由 motion.ts 按系统偏好生效，预设不能绕过。
 */
import { api, AnyRow, readerFonts } from "./shared";
import { patchAppearance } from "./prefs";

export type WritingEnvironment = {
  theme: "light" | "warm" | "dark";
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  paraSpacing: number;
  readingWidth: number;
  typewriterMode: boolean;
  editorZoom: number;
  backgroundImage: string;
  backgroundName: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundFit: string;
  paperOpacity: number;
  panelOpacity: number;
  reduceTransparency: boolean;
  uiDensity: "compact" | "comfortable";
  focusZen: boolean;
  /** 布局字段：仅在 includeLayout 时捕获与应用 */
  leftWidth?: number;
  rightWidth?: number;
};

export type WritingPreset = {
  id: string;
  name: string;
  environment: WritingEnvironment;
  /** 是否包含侧栏宽度等布局项；必须真实作用于捕获与应用 */
  includeLayout: boolean;
};

const PRESET_KEY = "writingPresets";
const MAX_NAME_LEN = 40;

function clampNum(x: any, min: number, max: number, fallback: number) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function clampStr(x: any, fallback = "") {
  return typeof x === "string" ? x : fallback;
}

/** 唯一的字段校验入口：类型收敛 + 数值钳制 + 无关字段剔除 */
export function validateEnvironment(x: any): WritingEnvironment {
  return {
    theme:
      x?.theme === "light" || x?.theme === "dark" || x?.theme === "warm"
        ? x.theme
        : "warm",
    fontFamily:
      clampStr(x?.fontFamily) || readerFonts[0].value,
    fontSize: clampNum(x?.fontSize, 14, 30, 17),
    lineHeight: clampNum(x?.lineHeight, 1.4, 3, 2),
    paraSpacing: clampNum(x?.paraSpacing, 0, 2, 0.45),
    readingWidth: clampNum(x?.readingWidth, 480, 1100, 760),
    typewriterMode: Boolean(x?.typewriterMode),
    editorZoom: clampNum(x?.editorZoom, 0.7, 1.8, 1),
    backgroundImage: clampStr(x?.backgroundImage),
    backgroundName: clampStr(x?.backgroundName),
    backgroundOpacity: clampNum(x?.backgroundOpacity, 0, 0.8, 0.22),
    backgroundBlur: clampNum(x?.backgroundBlur, 0, 24, 0),
    backgroundFit:
      x?.backgroundFit === "contain" || x?.backgroundFit === "tile"
        ? x.backgroundFit
        : "cover",
    paperOpacity: clampNum(x?.paperOpacity, 0.45, 1, 0.9),
    panelOpacity: clampNum(x?.panelOpacity, 0.35, 1, 0.72),
    reduceTransparency: Boolean(x?.reduceTransparency),
    uiDensity: x?.uiDensity === "comfortable" ? "comfortable" : "compact",
    focusZen: Boolean(x?.focusZen),
  };
}

/**
 * 从真实工作区状态组合环境：appearance（含密度/背景等）+ typography
 * + 布局字段。includeLayout 为 false 时不携带布局字段。
 */
export function buildEnvironment(
  appearance: AnyRow,
  typography: AnyRow,
  layout: AnyRow,
  includeLayout: boolean,
): WritingEnvironment {
  const env = validateEnvironment({ ...appearance, ...typography });
  // 校验入口不丢布局：有值则保留（范围钳制）
  if (appearance?.leftWidth != null || typography?.leftWidth != null)
    env.leftWidth = clampNum(
      appearance?.leftWidth ?? typography?.leftWidth,
      260,
      520,
      292,
    );
  if (appearance?.rightWidth != null || typography?.rightWidth != null)
    env.rightWidth = clampNum(
      appearance?.rightWidth ?? typography?.rightWidth,
      300,
      520,
      380,
    );
  if (includeLayout) {
    if (env.leftWidth == null)
      env.leftWidth = clampNum(layout?.leftWidth, 260, 520, 292);
    if (env.rightWidth == null)
      env.rightWidth = clampNum(layout?.rightWidth, 300, 520, 380);
  } else {
    delete env.leftWidth;
    delete env.rightWidth;
  }
  return env;
}

export async function listPresets(): Promise<WritingPreset[]> {
  const r = await api<AnyRow[]>("preferences:get", PRESET_KEY);
  if (!r.ok || !Array.isArray(r.data)) return [];
  const out: WritingPreset[] = [];
  for (const x of r.data) {
    if (!x || typeof x !== "object") continue;
    // 兼容 0.4.8 初版：{ appearance } 旧结构 → 迁移为 environment
    const rawEnv = x.environment || x.appearance;
    if (!rawEnv || typeof rawEnv !== "object") continue;
    const name = typeof x.name === "string" && x.name.trim() ? x.name : "预设";
    out.push({
      id: typeof x.id === "string" && x.id ? x.id : `p-${out.length}`,
      name: name.slice(0, MAX_NAME_LEN),
      environment: validateEnvironment(rawEnv),
      includeLayout: Boolean(x.includeLayout) && typeof x.environment?.leftWidth === "number",
    });
  }
  return out;
}

export async function savePresets(presets: WritingPreset[]) {
  return api("preferences:set", { key: PRESET_KEY, value: presets });
}

/** 应用预设：合并写入 appearance（含布局字段，若有） */
export async function applyEnvironment(env: WritingEnvironment) {
  return patchAppearance(env as AnyRow);
}

export const DEFAULT_PRESET_ID = "default-warm";

export function defaultPreset(): WritingPreset {
  return {
    id: DEFAULT_PRESET_ID,
    name: "默认暖纸",
    environment: validateEnvironment({
      theme: "warm",
      fontSize: 17,
      lineHeight: 2,
      paraSpacing: 0.45,
      readingWidth: 760,
      typewriterMode: false,
      editorZoom: 1,
      backgroundOpacity: 0.22,
      backgroundBlur: 0,
      backgroundFit: "cover",
      paperOpacity: 0.9,
      reduceTransparency: false,
      uiDensity: "compact",
      focusZen: false,
    }),
    includeLayout: false,
  };
}

export function sanitizePresetName(x: string) {
  return x.trim().slice(0, MAX_NAME_LEN);
}
