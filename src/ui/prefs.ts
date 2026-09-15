import { api, AnyRow } from "./shared";

/** 合并更新 appearance，避免整项覆盖清掉字体/背景/语言等字段。 */
export async function patchAppearance(
  over: AnyRow,
): Promise<{ ok: boolean; error?: string }> {
  const r = await api("preferences:set", {
    key: "appearance",
    value: over,
    merge: true,
  });
  if (!r.ok)
    return { ok: false, error: r.error || "Could not save appearance" };
  return { ok: true };
}

/** 合并更新 writing 偏好（每日目标等）。 */
export async function patchWriting(
  over: AnyRow,
): Promise<{ ok: boolean; error?: string }> {
  const r = await api("preferences:set", {
    key: "writing",
    value: over,
    merge: true,
  });
  if (!r.ok) return { ok: false, error: r.error || "Could not save writing prefs" };
  return { ok: true };
}

export async function markOnboardingDone(): Promise<{ ok: boolean; error?: string }> {
  const r = await api("preferences:set", {
    key: "onboarding",
    value: { done: true, at: new Date().toISOString() },
  });
  if (!r.ok) return { ok: false, error: r.error || "Could not save onboarding" };
  return { ok: true };
}

export type StatsPayload = {
  start: string;
  end: string;
  days: number;
  novelId: string | null;
  rows: { date: string; total: number }[];
};
