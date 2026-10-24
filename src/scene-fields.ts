export type SceneCustomField = { key: string; value: string };

/** Optional author-planned word target; keep legacy scene JSON without a value unchanged. */
export function normalizeSceneTargetWords(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(100_000, Math.max(1, Math.floor(number)));
}

export function normalizeSceneCustomFields(value: unknown): SceneCustomField[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((field: any) => {
    const key = String(field?.key || "").trim().slice(0, 40);
    const fieldValue = String(field?.value || "").trim().slice(0, 240);
    const normalizedKey = key.toLocaleLowerCase();
    if (!key || !fieldValue || seen.has(normalizedKey)) return [];
    seen.add(normalizedKey);
    return [{ key, value: fieldValue }];
  }).slice(0, 12);
}
