import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { prefersReducedMotion, subscribeReducedMotion } from "./motion";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** 附加说明，如“当前章节未分卷” */
  hint?: string;
};

export type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  size?: "compact" | "standard";
  searchable?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
  /** 当前值不在列表时的显示（不静默改选） */
  missingLabel?: string;
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(
    () => subscribeReducedMotion(() => setReduced(prefersReducedMotion())),
    [],
  );
  return reduced;
}

/** 固定选项选择器（可选可搜索）。高亮不提交，确认才 onValueChange。 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = "—",
  disabled,
  size = "standard",
  searchable,
  id,
  className,
  missingLabel,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const listboxId = `${id || autoId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const typeahead = useRef({ buffer: "", at: 0 });

  const selected = options.find((o) => o.value === value);
  const display =
    selected?.label ||
    (value ? missingLabel || value : placeholder);

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.hint?.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q),
    );
  }, [options, searchable, query]);

  const enabledIndexes = useMemo(
    () => filtered.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [filtered],
  );
  const selectedIndex = filtered.findIndex((o) => o.value === value && !o.disabled);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 6;
    const minH = 120;
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const ideal = Math.min(220, Math.max(minH, options.length * 36));
    const openUp = below < ideal && above > below;
    // 可用空间极小时贴边压缩，不因最小高度越界
    const available = Math.max(openUp ? above : below, 0);
    const maxHeight = Math.max(40, Math.min(available, 320));
    const width = Math.min(Math.max(r.width, 180), window.innerWidth - 24);
    let left = r.left;
    if (left + width > window.innerWidth - 12)
      left = Math.max(12, window.innerWidth - width - 12);
    setRect({
      top: openUp ? r.top - margin - maxHeight : r.bottom + margin,
      left,
      width,
      maxHeight,
    });
  }, [options.length]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    place();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : enabledIndexes[0] ?? 0);
    setQuery("");
    setOpen(true);
  }, [disabled, place, filtered, selectedIndex, enabledIndexes]);

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      setQuery("");
      if (restoreFocus) triggerRef.current?.focus();
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = () => place();
    const onKey = (e: KeyboardEvent) => {
      // 输入法合成中（拼音未上屏）：不处理方向键/Enter/打字，
      // 避免选字回车被误当成确认选项；仅放行 Escape 关闭
      if (e.isComposing || e.keyCode === 229) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === "Tab") {
        close(false);
        return;
      }
      const list = filtered;
      if (!enabledIndexes.length) return;
      const move = (dir: 1 | -1) => {
        e.preventDefault();
        const current = enabledIndexes.indexOf(activeIndex);
        const position = current < 0 ? (dir > 0 ? -1 : 0) : current;
        const i = enabledIndexes[(position + dir + enabledIndexes.length) % enabledIndexes.length];
        setActiveIndex(i);
        document.getElementById(`${listboxId}-option-${i}`)?.scrollIntoView({ block: "nearest" });
      };
      if (e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowUp") move(-1);
      else if (e.key === "Home") {
        e.preventDefault();
        setActiveIndex(enabledIndexes[0]);
      } else if (e.key === "End") {
        e.preventDefault();
        setActiveIndex(enabledIndexes[enabledIndexes.length - 1]);
      } else if (e.key === "Enter" || e.key === " ") {
        if (searchable && e.key === " " && document.activeElement === searchRef.current)
          return;
        e.preventDefault();
        const opt = list[activeIndex];
        if (opt && !opt.disabled) {
          onValueChange(opt.value);
          close();
        }
      } else if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        const now = Date.now();
        if (now - typeahead.current.at > 800) typeahead.current.buffer = "";
        typeahead.current.buffer += e.key.toLowerCase();
        typeahead.current.at = now;
        const i = list.findIndex(
          (o) =>
            !o.disabled && o.label.toLowerCase().startsWith(typeahead.current.buffer),
        );
        if (i >= 0) setActiveIndex(i);
      }
    };
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("resize", onScroll);
    // 捕获阶段 Esc，避免关闭外层弹窗
    document.addEventListener("keydown", onKey, true);
    const scroller = triggerRef.current?.closest(".modal-content, .left-panel, .right-panel, .settings-detail, body");
    scroller?.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("keydown", onKey, true);
      scroller?.removeEventListener("scroll", onScroll, true);
    };
  }, [open, activeIndex, filtered, enabledIndexes, listboxId, onValueChange, close, place, searchable]);

  useEffect(() => {
    if (!open) return;
    if (searchable) searchRef.current?.focus();
    else listRef.current?.focus();
  }, [open, searchable]);

  return (
    <div className={`zw-select ${size} ${className || ""}`} data-fd-id={id || rest["aria-label"] || "select"}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`zw-select-trigger ${open ? "open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={rest["aria-label"]}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            if (!open) {
              e.preventDefault();
              openMenu();
            }
          }
        }}
      >
        <span className="zw-select-value">{display}</span>
        <svg className="zw-select-arrow" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && rect && (
        <div
          className={`zw-select-pop ${reducedMotion ? "no-motion" : ""}`}
          style={{
            position: "fixed",
            top: rect.top,
            left: rect.left,
            width: rect.width,
            maxHeight: rect.maxHeight,
            zIndex: 120,
          }}
        >
          {searchable && (
            <input
              ref={searchRef}
              className="zw-select-search"
              role="combobox"
              aria-label={rest["aria-label"]}
              aria-expanded={open}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={filtered[activeIndex] && !filtered[activeIndex].disabled ? `${listboxId}-option-${activeIndex}` : undefined}
              placeholder="搜索…"
              value={query}
              onChange={(e) => {
                const nextQuery = e.target.value;
                const q = nextQuery.trim().toLowerCase();
                const next = !q ? options : options.filter((o) =>
                  o.label.toLowerCase().includes(q) ||
                  o.hint?.toLowerCase().includes(q) ||
                  o.value.toLowerCase().includes(q),
                );
                setQuery(nextQuery);
                setActiveIndex(Math.max(0, next.findIndex((option) => !option.disabled)));
              }}
            />
          )}
          <div
            ref={listRef}
            className="zw-select-list"
            role="listbox"
            id={listboxId}
            aria-labelledby={id}
            tabIndex={searchable ? undefined : 0}
            aria-activedescendant={!searchable && filtered[activeIndex] && !filtered[activeIndex].disabled ? `${listboxId}-option-${activeIndex}` : undefined}
          >
            {filtered.length === 0 && (
              <div className="zw-select-empty" role="presentation">
                无匹配项
              </div>
            )}
            {filtered.map((o, i) => (
              <div
                key={o.value === "" ? "__empty" : o.value}
                id={`${listboxId}-option-${i}`}
                role="option"
                data-index={i}
                aria-selected={o.value === value}
                aria-disabled={o.disabled}
                className={[
                  "zw-select-option",
                  o.value === value ? "selected" : "",
                  i === activeIndex ? "active" : "",
                  o.disabled ? "disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (o.disabled) return;
                  onValueChange(o.value);
                  close();
                }}
              >
                <span className="zw-select-check" aria-hidden="true">
                  {o.value === value ? (
                    <svg width="14" height="14" viewBox="0 0 24 24">
                      <path
                        d="M5 12l5 5L19 7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span className="zw-select-label">
                  {o.label}
                  {o.hint ? <small className="zw-select-hint">{o.hint}</small> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export type ComboboxProps = {
  value: string;
  onValueChange: (value: string) => void;
  suggestions: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  size?: "compact" | "standard";
};

/** 自由输入 + 建议列表。建议可点，也可提交列表外的值。 */
export function Combobox({
  value,
  onValueChange,
  suggestions,
  placeholder,
  disabled,
  id,
  size = "standard",
  ...rest
}: ComboboxProps) {
  const autoId = useId();
  const inputId = id || autoId;
  const listId = `${inputId}-list`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [active, setActive] = useState(0);
  const composing = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const shown = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return suggestions.slice(0, 12);
    return suggestions
      .filter((s) => s.label.toLowerCase().includes(q) || s.value.toLowerCase().includes(q))
      .slice(0, 12);
  }, [draft, suggestions]);

  function commit(v: string) {
    onValueChange(v);
    setOpen(false);
  }

  return (
    <div
      ref={wrapRef}
      className={`zw-select combobox ${size}`}
      data-fd-id={rest["aria-label"] || "combobox"}
    >
      <input
        ref={inputRef}
        id={inputId}
        className="zw-select-trigger input"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-label={rest["aria-label"]}
        disabled={disabled}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (composing.current) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setDraft(value);
            return;
          }
          if (e.key === "Tab") {
            commit(draft);
            return;
          }
          if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
            setOpen(true);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && shown[active]) commit(shown[active].value);
            else commit(draft);
          }
        }}
        onBlur={() => {
          window.setTimeout(() => {
            if (!wrapRef.current?.contains(document.activeElement)) commit(draft);
          }, 0);
        }}
      />
      {open && shown.length > 0 && (
        <div className="zw-select-pop static" role="listbox" id={listId}>
          {shown.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`zw-select-option ${i === active ? "active" : ""} ${o.value === value ? "selected" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(o.value);
              }}
            >
              <span className="zw-select-label">{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
