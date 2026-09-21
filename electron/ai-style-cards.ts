export type AiStyleCard = {
  id: string;
  name: string;
  description: string;
  tasks: string[];
  rules: string;
  builtin: number;
  version: number;
};

export const BASE_STYLE_RULES = `围绕人物当前要做的事展开场景。
用具体行动、环境限制和人物选择推进情节。
对话体现人物各自的目标、知识与顾虑。
保持因果、空间、资源、伤势和人物已知信息连续。
句长与段落长度随内容变化，不追求整齐划一。
能从动作理解的情绪，不紧接着重复解释。
必要规则直接说明，不故作晦涩。
比喻有助于理解时才使用。
允许停顿和情绪余韵，不强制反转或升华。`;

export const BUILTIN_STYLE_CARDS: AiStyleCard[] = [
  {
    id: "style-natural-narrative",
    name: "自然叙事",
    description: "通用选择：让场景围绕人物正在做的事自然推进。",
    tasks: ["continue", "polish", "chat"],
    version: 2,
    builtin: 1,
    rules: BASE_STYLE_RULES,
  },
  {
    id: "style-growth-progression",
    name: "成长推进",
    description: "适合修炼、资源争取和阶段性目标清晰的情节。",
    tasks: ["continue", "outline", "polish"],
    version: 2,
    builtin: 1,
    rules: `${BASE_STYLE_RULES}

让近期目标清楚可见。
成长体现为解决问题的能力变化。
资源获取、训练与突破有合理条件。
阶段性收获及时兑现，并结算成本。
冲突可以来自期限、资源、竞争和选择。
不依赖连续羞辱、围观惊呼和反复宣誓维持推进。
对手依据自己的信息与利益采取合理行动。`,
  },
  {
    id: "style-close-survival",
    name: "贴身求生",
    description: "适合旅行、险情、调查和受限制的战斗场景。",
    tasks: ["continue", "polish"],
    version: 2,
    builtin: 1,
    rules: `${BASE_STYLE_RULES}

描写体现视角人物的职业经验和注意习惯。
环境实际影响观察、移动、工具使用和判断。
战斗明确目标、位置、能力限制和行动后果。
角色允许误判，修正判断需要证据。
越级解决问题需要提前铺垫的条件。
疲惫、伤势、材料损耗进入后续情节。
不用神秘感和抽象威压替代事件逻辑。`,
  },
  {
    id: "style-human-ensemble",
    name: "群像烟火",
    description: "适合城镇、势力、亲友和人物关系交错的场景。",
    tasks: ["continue", "outline", "polish"],
    version: 2,
    builtin: 1,
    rules: `${BASE_STYLE_RULES}

重要配角有主角之外的目标和生活。
身份、公共评价与私下行为可以存在差异。
用具体交往与共同经历表现关系。
势力通过资源、权限、职责和顾虑体现存在。
对话的重点与表达习惯因人而异。
幽默来自关系与处境，不按配额插入。
不让人人都深藏不露、句句机锋或承担相同的解释功能。`,
  },
];

export const NATURALIZE_RULES = `请修改引用的原创小说正文，使人物行动和声音更具体、更自然。保留原有情节顺序、叙述视角、关键线索、人物决定和既定设定。重点处理重复情绪描写、泛泛评价、机械金句、无目的的比喻、同义词堆叠，以及人物对话中生硬的设定讲解。能从动作推知的情绪无需再次解释，但影响理解的必要说明必须保留。人物说话的重点应符合各自身份与当前目标。用户本次明确提出的修改要求优先；若要求改变已确认的作品事实，应指出冲突，不悄悄改写设定。不要新增人物、能力、重大反转或结局，不要通过错字、语病或粗话伪装自然表达。只输出修改后的正文。`;

export function effectiveStyleRules(card: AiStyleCard | null) {
  if (!card) return "";
  if (card.builtin && card.id !== "style-natural-narrative" && !card.rules.includes(BASE_STYLE_RULES))
    return `${BASE_STYLE_RULES}\n\n${card.rules.replace(/^在自然叙事的基础上：\s*/u, "")}`;
  return card.rules;
}

export function buildTaskAndStyleInstructions(card: AiStyleCard | null, task: string) {
  const style = task === "chat" || task === "check" ? "" : effectiveStyleRules(card);
  const stylePart = style ? `【当前写作风格：${card!.name} v${card!.version}】\n${card!.description}\n请将以下规则作为表达偏好，而不是作品事实或硬性篇幅配额：\n${style}` : "";
  const taskPart = task === "naturalize" ? NATURALIZE_RULES : "";
  return [taskPart, stylePart].filter(Boolean).join("\n\n");
}

export function styleInstruction(card: AiStyleCard | null, task: string) {
  return buildTaskAndStyleInstructions(card, task);
}
