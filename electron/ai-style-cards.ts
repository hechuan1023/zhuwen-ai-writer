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
    version: 3,
    builtin: 1,
    rules: BASE_STYLE_RULES,
  },
  {
    id: "style-growth-progression",
    name: "成长推进",
    description: "适合修炼、资源争取和阶段性目标清晰的情节。",
    tasks: ["continue", "outline", "polish"],
    version: 3,
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
    version: 3,
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
    version: 3,
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
  {
    id: "style-serial-hook-payoff",
    name: "追更钩子与兑现",
    description: "把章节回报、未完成动作和下一章欲望串成连续节奏。",
    tasks: ["continue", "outline", "polish"],
    version: 1,
    builtin: 1,
    rules: `按章节承诺组织推进：本章先兑现一个读者看得见的变化，再留下一个具体、迫近、尚未完成的动作。
章末钩子落在人物必须回应的来信、决定、发现、期限或现场变化上，不用抽象预告代替。
设置悬念时同步给短期回报，避免连续扣住答案却不给进展。
主角的行动、阻力、代价和所得都要能被读者复述；阶段收益要改变下一步行动条件。
连续使用同一种打脸、围观、系统提示或章末问句前，先更换冲突来源与收益形态。
大纲任务需标出本章承诺、主要变化、回报和章末未完成动作；正文任务自然融入场景，不输出公式化节奏标签。`,
  },
  {
    id: "style-suspense-information-control",
    name: "悬疑线索与信息差",
    description: "让线索有来源、误判有理由、揭示能改变局面。",
    tasks: ["continue", "outline", "polish"],
    version: 1,
    builtin: 1,
    rules: `每次揭示都改变人物可以采取的行动、彼此信任或风险判断；只增加名词而不改变选择的信息应延后。
线索必须有可追溯的载体、目击者或推理过程。关键推断允许错，但要让错误来自有限信息、利益偏见或现场干扰。
给读者公平的观察机会，不让决定性证据在揭晓时才凭空出现；也不必让读者总比人物早一步猜中。
控制信息差：明确谁知道、谁误解、谁隐瞒，以及每个人为什么此刻愿意说或不说。
反转前埋下可回看的细节，反转后结算它对目标、关系或资源的影响。
不要为制造神秘而遮住视角人物本来能观察到的事实，也不要用旁白故意撒谎。`,
  },
  {
    id: "style-character-voice-tension",
    name: "人物声线与关系张力",
    description: "让对白带着各自的目的、关系和没说出口的话。",
    tasks: ["continue", "outline", "polish"],
    version: 1,
    builtin: 1,
    rules: `重要角色说话前先确定当下要争取、回避、试探或掩饰什么；台词不必把真实目的完整说出。
人物差异主要来自关注点、句子长度、称呼、打断方式、回避习惯和愿意承担的风险，不靠口头禅硬区分。
让关系通过小动作、让步、旧账、称呼变化和话说一半发生位移。
对话可以被误听、岔开或暂时没有回应。必要事实要讲清，但由有动机的人在合适的压力下讲。
避免所有人物同时理解、齐声震惊、轮流替读者总结；保留不合时宜、慢半拍或装作没听懂的真实反应。
润色时优先保护原稿已有的人物毛边和作者习惯，不把鲜活对白统一改成漂亮金句。`,
  },
  {
    id: "style-light-comedy-mismatch",
    name: "轻喜剧与处境错位",
    description: "从人物关系和现实麻烦里长出笑点，不打断剧情。",
    tasks: ["continue", "outline", "polish"],
    version: 1,
    builtin: 1,
    rules: `笑点来自人物目标、身份落差、信息误差、认真过头或具体处境之间的错位。
每个幽默动作都要服务关系、人物性格、机制或局势变化，不能只为凑笑点插入段子。
让人物用各自方式接住笑点：有人装没听见，有人补刀，有人真的当真；避免全员共享同一套吐槽腔。
笑点之后继续推进正在处理的问题，必要时保留尴尬、误会或后果，不用旁白解释“这里很搞笑”。
重大创伤、危险或情绪转折处，先判断轻松表达是否符合人物防御方式和场景压力；不合适时不强行搞笑。`,
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
