/**
 * 永久删除（回收站彻底清除）的强确认词。
 *
 * 这是不可逆操作，保护分两层，两层的字面量必须一致：
 *   1. 前端：PromptDialog 要求用户逐字输入确认词（本文件）
 *   2. 主进程：`trash:purge` 校验 `confirm` 字段，不匹配直接失败
 *
 * 修改确认词时必须同步三处：
 *   - electron/main.ts 的 trash:purge 校验
 *   - 本文件的 purgeConfirmWord()
 *   - trash-panel.tsx / shelf.tsx 的 PromptDialog
 */

/** 主进程 trash:purge 接受的全部字面量 */
export const PURGE_CONFIRM_WORDS = ["永久删除", "DELETE"] as const;

/** 当前界面语言下，用户必须逐字输入的确认词 */
export function purgeConfirmWord(language?: string): string {
  return language === "en" ? "DELETE" : "永久删除";
}

/**
 * 判断输入是否构成有效确认。
 *
 * 仅容忍首尾空白（原生 prompt 不支持），不接受任何其他写法——
 * 「确定」「取消」这类顺手输入必须被拒绝，否则等同于单击确认。
 */
export function isPurgeConfirmed(input: string, language?: string): boolean {
  return input.trim() === purgeConfirmWord(language);
}
