export type StyleBundleCard = {
  id: string;
  builtin: boolean;
  name: string;
  description: string;
  tasks: string[];
  rules: string;
};

export type StyleCompositionBundle = {
  name: string;
  description: string;
  cards: StyleBundleCard[];
};

const STYLE_TASKS = new Set(["continue", "polish", "naturalize", "outline"]);

/** Validate the portable format before any database writes take place. */
export function parseStyleCompositionBundle(input: unknown): StyleCompositionBundle {
  const bundle = input as any;
  if (!bundle || typeof bundle !== "object" || bundle.format !== "zhuwen-ai-style-composition" || bundle.version !== 1)
    throw new Error("文件格式不受支持或版本不兼容");
  const composition = bundle.composition;
  if (!composition || typeof composition !== "object") throw new Error("组合文件缺少组合数据");
  if (typeof composition.name !== "string" || !composition.name.trim() || composition.name.trim().length > 80)
    throw new Error("组合名称需为 1 到 80 个字符");
  if (composition.description != null && (typeof composition.description !== "string" || composition.description.length > 240))
    throw new Error("组合说明不能超过 240 个字符");
  if (!Array.isArray(composition.cards) || composition.cards.length < 1 || composition.cards.length > 6)
    throw new Error("组合需包含 1 到 6 张技法卡");

  const seen = new Set<string>();
  const cards = composition.cards.map((raw: any): StyleBundleCard => {
    if (!raw || typeof raw !== "object") throw new Error("组合中含有无效技法卡");
    if (typeof raw.id !== "string" || !raw.id.trim() || raw.id.length > 120 || seen.has(raw.id))
      throw new Error("技法卡 ID 缺失或重复");
    seen.add(raw.id);
    if (typeof raw.builtin !== "boolean") throw new Error("技法卡类型字段无效");
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 80)
      throw new Error("技法卡名称需为 1 到 80 个字符");
    if (raw.description != null && (typeof raw.description !== "string" || raw.description.length > 240))
      throw new Error("技法卡说明不能超过 240 个字符");
    if (typeof raw.rules !== "string" || !raw.rules.trim() || raw.rules.length > 20000)
      throw new Error("技法卡规则需为 1 到 20000 个字符");
    if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > STYLE_TASKS.size ||
        raw.tasks.some((task: unknown) => typeof task !== "string" || !STYLE_TASKS.has(task)) ||
        new Set(raw.tasks).size !== raw.tasks.length)
      throw new Error("技法卡适用任务无效");
    return {
      id: raw.id.trim(),
      builtin: raw.builtin,
      name: raw.name.trim(),
      description: String(raw.description || "").trim(),
      tasks: [...raw.tasks],
      rules: raw.rules.trim(),
    };
  });

  return {
    name: composition.name.trim(),
    description: String(composition.description || "").trim(),
    cards,
  };
}
