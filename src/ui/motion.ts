/**
 * 动态效果偏好。
 *
 * 两个来源相互独立，任一开启都应减少动态效果：
 * 1. 系统级 prefers-reduced-motion（用户在操作系统里设置）
 * 2. 应用内「减少动态效果」设置（根元素 reduce-motion class）
 *
 * 注意：CSS 只能禁用 CSS 动画，JS 驱动的动画（如目标数字补间）必须自己读这里的结果，
 * 否则用户开了「减少动态效果」仍会看到数字跳动。
 */

/** 应用内设置对应的根元素 class */
export const REDUCE_MOTION_CLASS = "reduce-motion";

const QUERY = "(prefers-reduced-motion: reduce)";

/** 合并规则：任一来源命中即减少动态效果 */
export function resolveReducedMotion(
  appEnabled: boolean,
  systemEnabled: boolean,
) {
  return Boolean(appEnabled) || Boolean(systemEnabled);
}

/** 系统偏好（非浏览器环境返回 false） */
export function systemPrefersReducedMotion() {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** 应用内设置（读取根元素 class；非浏览器环境返回 false） */
export function appReduceMotionEnabled() {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains(REDUCE_MOTION_CLASS);
}

/** 当前是否应减少动态效果（可注入读取器，便于测试） */
export function prefersReducedMotion(readers?: {
  app?: () => boolean;
  system?: () => boolean;
}) {
  const app = readers?.app ?? appReduceMotionEnabled;
  const system = readers?.system ?? systemPrefersReducedMotion;
  return resolveReducedMotion(app(), system());
}

/** 把应用内设置同步到根元素 class */
export function applyReduceMotion(enabled: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(
    REDUCE_MOTION_CLASS,
    Boolean(enabled),
  );
}

/**
 * 订阅两种来源的变化，返回取消订阅函数。
 * class 变化用 MutationObserver 观察，因为 classList 切换不会触发 matchMedia 事件。
 */
export function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || typeof document === "undefined")
    return () => {};
  const mq =
    typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
  if (mq && typeof mq.addEventListener === "function")
    mq.addEventListener("change", onChange);
  let observer: MutationObserver | null = null;
  if (typeof MutationObserver === "function") {
    observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  return () => {
    if (mq && typeof mq.removeEventListener === "function")
      mq.removeEventListener("change", onChange);
    observer?.disconnect();
  };
}
