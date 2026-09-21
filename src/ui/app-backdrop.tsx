import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";

type BackdropSettings = {
  backgroundImage?: string;
  backgroundOpacity?: number;
  backgroundBlur?: number;
  backgroundFit?: string;
  panelOpacity?: number;
  paperOpacity?: number;
  reduceTransparency?: boolean;
};
const bounded = (n: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(n) ? Math.max(min, Math.min(max, n!)) : fallback;

/** One viewport-sized image; only the image is blurred, never the text. */
export function AppBackdrop({ appearance }: { appearance: BackdropSettings }) {
  const image = appearance.backgroundImage?.startsWith("data:image/") ? appearance.backgroundImage : "";
  const reduced = Boolean(appearance.reduceTransparency);
  const panel = bounded(appearance.panelOpacity, 0.72, 0.35, 1);
  const paper = bounded(appearance.paperOpacity, 0.9, 0.45, 1);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("has-app-background", Boolean(image));
    root.classList.toggle("app-background-solid", reduced);
    root.style.setProperty("--app-panel-opacity", `${(reduced ? 1 : panel) * 100}%`);
    root.style.setProperty("--app-paper-opacity", `${(reduced ? 1 : paper) * 100}%`);
    return () => {
      root.classList.remove("has-app-background", "app-background-solid");
      root.style.removeProperty("--app-panel-opacity");
      root.style.removeProperty("--app-paper-opacity");
    };
  }, [image, panel, paper, reduced]);
  if (!image) return null;
  return createPortal(
    <div className="app-backdrop" aria-hidden="true">
      <div style={{
        backgroundImage: `url(${JSON.stringify(image)})`,
        backgroundSize: appearance.backgroundFit === "tile" ? "auto" : appearance.backgroundFit === "contain" ? "contain" : "cover",
        backgroundRepeat: appearance.backgroundFit === "tile" ? "repeat" : "no-repeat",
        opacity: bounded(appearance.backgroundOpacity, 0.22, 0, 0.8),
        filter: `blur(${bounded(appearance.backgroundBlur, 0, 0, 24)}px)`,
      }} />
    </div>, document.body,
  );
}
