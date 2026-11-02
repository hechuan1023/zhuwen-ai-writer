/** 铸文 AI 激活令牌：校验与来源判定（纯函数，便于单元测试）。 */

export const TOKEN_MIN_LENGTH = 8;

export type TokenSource = "env" | "local" | "none";

export type TokenStatus = {
  configured: boolean;
  source: TokenSource;
  /** 环境变量注入的令牌不允许在应用内改写 */
  manageable: boolean;
};

/**
 * 规范化并校验用户输入的激活令牌。
 * 令牌区分大小写，但首尾空白一律去掉；中间不允许空白，避免粘贴时混入换行。
 */
export function normalizeServerToken(input: unknown): string {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("激活令牌不能为空");
  if (/\s/.test(value)) throw new Error("激活令牌不能包含空格或换行");
  if (value.length < TOKEN_MIN_LENGTH)
    throw new Error(`激活令牌至少 ${TOKEN_MIN_LENGTH} 位`);
  if (value.length > 512) throw new Error("激活令牌过长");
  return value;
}

/** 环境变量优先于本地加密存储；两者都没有则视为未激活。 */
export function describeTokenStatus(envToken: string, localToken: string): TokenStatus {
  if (String(envToken || "").trim())
    return { configured: true, source: "env", manageable: false };
  if (String(localToken || "").trim())
    return { configured: true, source: "local", manageable: true };
  return { configured: false, source: "none", manageable: true };
}
