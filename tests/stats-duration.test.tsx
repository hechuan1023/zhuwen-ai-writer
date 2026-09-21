import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsDuration } from "../src/ui/stats-duration";
import { formatFocusDuration } from "../src/ui/shared";

describe("statistics duration typography", () => {
  it.each([0, 30000, 120000, 3600000, 7980000])("keeps the original duration calculation for %i ms", (ms) => {
    for (const language of ["zh-CN", "en"] as const) {
      const html = renderToStaticMarkup(<StatsDuration ms={ms} language={language} />);
      expect(html).toContain(`aria-label="${formatFocusDuration(ms, language)}"`);
      expect(html).toContain("stats-duration-number");
      expect(html).toContain("<small>");
    }
  });
  it("renders hour and minute units separately from their numbers", () => {
    const html = renderToStaticMarkup(<StatsDuration ms={7980000} language="zh-CN" />);
    expect(html).toContain('stats-duration-number">2</span><small>小时</small>');
    expect(html).toContain('stats-duration-number">13</span><small>分</small>');
  });
});
