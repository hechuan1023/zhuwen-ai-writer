import { formatFocusDuration, UiLanguage } from "./shared";

/** Keep the existing duration calculation; only separate values and units visually. */
export function StatsDuration({ ms, language }: { ms: number; language: UiLanguage }) {
  const text = formatFocusDuration(ms, language);
  const parts = [...text.matchAll(/(\d+)\s*([^\d]+)/g)];
  return <span className="stats-duration" aria-label={text}>
    {parts.map(([_, value, unit], index) => (
      <span className="stats-duration-part" key={index} aria-hidden="true">
        <span className="stats-duration-number">{value}</span>
        <small>{unit.trim()}</small>
      </span>
    ))}
  </span>;
}
