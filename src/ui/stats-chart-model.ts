/** Sparse horizontal ticks; always preserve endpoints without dropping daily data. */
export function trendTickIndexes(count: number, width: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const preferred = count <= 7 ? count : count <= 30 ? 6 : 7;
  const ticks = Math.min(count, preferred, Math.max(2, Math.floor(width / 64)));
  return Array.from({ length: ticks }, (_, i) => Math.round(i * (count - 1) / (ticks - 1)));
}

export function trendScale(values: number[]) {
  const positive = Math.max(0, ...values);
  const negative = Math.max(0, ...values.map((v) => -v));
  const limit = Math.max(1, positive, negative);
  const zero = positive && negative ? 50 : negative ? 8 : 92;
  return { limit, zero, span: positive && negative ? 42 : 84, empty: !positive && !negative,
    ticks: positive && negative ? [limit, 0, -limit] : negative ? [0, -limit / 2, -limit] : [limit, limit / 2, 0] };
}

export function recentWritingMonths(now: Date, totals: Map<string, number>) {
  const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const today = dateKey(now);
  return [-1, 0].map((offset) => {
    const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const pad = (first.getDay() + 6) % 7;
    const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const days = Array.from({ length: count }, (_, i) => {
      const date = dateKey(new Date(first.getFullYear(), first.getMonth(), i + 1));
      return { date, day: i + 1, total: date > today ? 0 : totals.get(date) || 0, future: date > today, today: date === today };
    });
    return { key: dateKey(first).slice(0, 7), first, pad, days, total: days.reduce((sum, day) => sum + day.total, 0) };
  });
}
