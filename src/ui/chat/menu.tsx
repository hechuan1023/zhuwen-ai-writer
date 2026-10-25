import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  selected?: boolean;
  /** 次要说明，如快捷键或作用范围 */
  hint?: string;
  /** 可选分组标题；分组标题不是可聚焦菜单项 */
  group?: string;
  onSelect: () => void;
};

/**
 * 可访问的下拉菜单（Esc 关闭并归还焦点、点击外部/失焦关闭、方向键导航）。
 * 用于会话“更多”操作与回复“采纳/更多”操作。
 */
export function ChatMenu({
  label,
  items,
  align = "end",
  trigger,
  triggerClassName = "",
  menuClassName = "",
  ariaLabel,
  dataFdId,
}: {
  label?: string;
  items: MenuItem[];
  align?: "start" | "end";
  /** 自定义触发器内容；给出时忽略 label */
  trigger?: ReactNode;
  triggerClassName?: string;
  menuClassName?: string;
  ariaLabel: string;
  dataFdId?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openAtEndRef = useRef(false);

  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const selectionMenu = items.some((it) => typeof it.selected === "boolean");

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) {
      const selectedIndex = items.findIndex((item, index) => item.selected && enabled.includes(index));
      const initial = openAtEndRef.current
        ? enabled[enabled.length - 1]
        : selectedIndex >= 0
          ? selectedIndex
          : enabled[0];
      const first = initial ?? 0;
      openAtEndRef.current = false;
      setActive(first);
      // 打开后聚焦第一项，键盘可直接操作
      requestAnimationFrame(() => itemRefs.current[first]?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function move(dir: 1 | -1) {
    if (!enabled.length) return;
    const cur = enabled.indexOf(active);
    const next =
      cur === -1
        ? enabled[0]
        : enabled[(cur + dir + enabled.length) % enabled.length];
    setActive(next);
    itemRefs.current[next]?.focus();
  }

  function focusEdge(edge: "first" | "last") {
    const index = edge === "first" ? enabled[0] : enabled[enabled.length - 1];
    if (index === undefined) return;
    setActive(index);
    itemRefs.current[index]?.focus();
  }

  return (
    <div className="zchat-menu-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`zchat-icon-btn ${triggerClassName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        title={ariaLabel}
        data-fd-id={dataFdId}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            openAtEndRef.current = e.key === "ArrowUp";
            setOpen(true);
          }
        }}
      >
        {trigger ?? label}
      </button>
      {open && (
        <div
          className={`zchat-menu align-${align} ${menuClassName}`}
          role="menu"
          id={id}
          aria-label={ariaLabel}
          onBlur={(e) => {
            if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) close(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Home") {
              e.preventDefault();
              focusEdge("first");
            } else if (e.key === "End") {
              e.preventDefault();
              focusEdge("last");
            } else if (e.key === "Tab") {
              // Let the browser move focus normally; onBlur closes after it leaves the menu.
            }
          }}
        >
          {items.map((it, i) => (
            <Fragment key={it.id}>
              {it.group && (i === 0 || it.group !== items[i - 1]?.group) ? (
                <div
                  className={`zchat-menu-group ${i > 0 ? "separated" : ""}`}
                  role="presentation"
                  aria-hidden="true"
                >
                  {it.group}
                </div>
              ) : null}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role={selectionMenu ? "menuitemradio" : "menuitem"}
                tabIndex={i === active ? 0 : -1}
                className={`zchat-menu-item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""} ${it.selected ? "selected" : ""}`}
                aria-checked={selectionMenu ? Boolean(it.selected) : undefined}
                aria-disabled={it.disabled || undefined}
                disabled={it.disabled}
                data-fd-id={it.id}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={() => {
                  if (it.disabled) return;
                  close();
                  it.onSelect();
                }}
              >
                {it.icon ? <span className="zchat-menu-icon">{it.icon}</span> : null}
                <span className="zchat-menu-label">{it.label}</span>
                {it.hint ? <small className="zchat-menu-hint">{it.hint}</small> : null}
                {selectionMenu ? <span className="zchat-menu-check" aria-hidden="true">{it.selected ? "✓" : ""}</span> : null}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
