import { describe, expect, it } from "vitest";
import {
  applyReduceMotion,
  appReduceMotionEnabled,
  prefersReducedMotion,
  resolveReducedMotion,
  subscribeReducedMotion,
  systemPrefersReducedMotion,
} from "../src/ui/motion";

describe("reduce motion resolution", () => {
  it("treats the app setting and the system preference as independent OR", () => {
    expect(resolveReducedMotion(false, false)).toBe(false);
    expect(resolveReducedMotion(true, false)).toBe(true);
    expect(resolveReducedMotion(false, true)).toBe(true);
    expect(resolveReducedMotion(true, true)).toBe(true);
  });

  it("coerces truthy input instead of leaking non-booleans", () => {
    expect(resolveReducedMotion(1 as any, 0 as any)).toBe(true);
    expect(resolveReducedMotion(0 as any, "" as any)).toBe(false);
  });

  it("prefersReducedMotion actually consults both sources", () => {
    const on = () => true;
    const off = () => false;
    expect(prefersReducedMotion({ app: off, system: off })).toBe(false);
    expect(prefersReducedMotion({ app: on, system: off })).toBe(true);
    expect(prefersReducedMotion({ app: off, system: on })).toBe(true);
    expect(prefersReducedMotion({ app: on, system: on })).toBe(true);
    // 应用设置关闭时不能掩盖系统偏好
    expect(prefersReducedMotion({ app: off, system: on })).not.toBe(
      prefersReducedMotion({ app: off, system: off }),
    );
  });

  it("reports no motion preference outside a browser", () => {
    expect(typeof window).toBe("undefined");
    expect(systemPrefersReducedMotion()).toBe(false);
    expect(appReduceMotionEnabled()).toBe(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("degrades safely when the DOM is unavailable", () => {
    expect(() => applyReduceMotion(true)).not.toThrow();
    const unsubscribe = subscribeReducedMotion(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});
