import { useMemo } from "react";
import { AnyRow, kindNameFor, Modal } from "../shared";
import { IconQuote } from "./icons";

/** 上下文占用 + 实际发送内容预览（引用快照与真实请求一致） */
export function ContextDialog({
  language,
  refs,
  historyChars,
  draftChars,
  historyCount,
  estimateTokens,
  ruleChars = 0,
  previewMessages,
  previewError,
  onClose,
}: {
  language: string;
  refs: AnyRow[];
  historyChars: number;
  draftChars: number;
  historyCount: number;
  estimateTokens: number;
  ruleChars?: number;
  previewMessages: AnyRow[] | null;
  previewError?: string | null;
  onClose: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const refChars = useMemo(
    () => refs.reduce((n, x) => n + String(x.content || "").length, 0),
    [refs],
  );
  const rows = [
    {
      label: tr("引用资料", "References"),
      value: `${refs.length} ${tr("项", "items")}`,
      chars: refChars,
    },
    {
      label: tr("对话历史", "Conversation history"),
      value: `${historyCount} ${tr("条消息", "messages")}`,
      chars: historyChars,
    },
    {
      label: tr("当前输入", "Current input"),
      value: `${draftChars} ${tr("字", "chars")}`,
      chars: draftChars,
    },
    {
      label: tr("写作规则", "Writing rules"),
      value: `${ruleChars} ${tr("字", "chars")}`,
      chars: ruleChars,
    },
  ];
  const total = rows.reduce((n, r) => n + r.chars, 0) || 1;

  return (
    <Modal title={tr("上下文与发送内容", "Context and payload")} close={onClose}>
      <div className="zchat-context">
        <p className="hint">
          {tr(
            `本次合计约 ${estimateTokens.toLocaleString()} tokens（按字符数 ÷2 估算，非服务商精确计费）。`,
            `About ${estimateTokens.toLocaleString()} tokens total (chars ÷ 2 estimate, not provider billing).`,
          )}
        </p>
        <div className="zchat-context-rows" data-fd-id="ai-context-breakdown">
          {rows.map((r) => (
            <div className="zchat-context-row" key={r.label}>
              <span className="zchat-context-label">{r.label}</span>
              <span className="zchat-context-value">{r.value}</span>
              <span className="zchat-context-bar" aria-hidden="true">
                <i style={{ width: `${Math.round((r.chars / total) * 100)}%` }} />
              </span>
              <span className="zchat-context-chars">
                {r.chars.toLocaleString()} {tr("字", "chars")}
              </span>
            </div>
          ))}
        </div>
        <h4 className="zchat-context-h4">{tr("引用明细", "Reference details")}</h4>
        {refs.length ? (
          <div className="zchat-context-refs">
            {refs.map((x, i) => (
              <details key={`${x.kind}:${x.sourceId || i}`} className="zchat-context-ref">
                <summary>
                  <IconQuote />
                  <span className="zchat-ellipsis">{x.label}</span>
                  <small>
                    {kindNameFor(x.kind, language as never)} ·{" "}
                    {String(x.content || "").length.toLocaleString()} {tr("字", "chars")}
                  </small>
                </summary>
                <pre>{x.content}</pre>
              </details>
            ))}
          </div>
        ) : (
          <p className="hint">
            {tr(
              "本次没有引用资料，只发送对话历史与当前输入。",
              "No references this time; only history and your input are sent.",
            )}
          </p>
        )}
        <h4 className="zchat-context-h4">{tr("实际发送内容", "Actual payload")}</h4>
        {previewError ? (
          <p className="hint error">{previewError}</p>
        ) : previewMessages ? (
          <div className="zchat-context-preview" data-fd-id="ai-context-preview">
            {previewMessages.map((m, i) => (
              <details key={i} className="zchat-context-ref">
                <summary>
                  <b>{m.role === "user" ? tr("用户", "user") : m.role}</b>
                  <small>{String(m.content || "").length.toLocaleString()} {tr("字", "chars")}</small>
                </summary>
                <pre>{m.content}</pre>
              </details>
            ))}
          </div>
        ) : (
          <p className="hint">{tr("正在生成预览…", "Building preview…")}</p>
        )}
      </div>
    </Modal>
  );
}
