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
  historyStatsComplete,
  estimateTokens,
  ruleChars = 0,
  projectInstructionChars = 0,
  payloadChars,
  contextLimitChars = 300000,
  previewMessages,
  previewError,
  onClose,
}: {
  language: string;
  refs: AnyRow[];
  historyChars: number;
  draftChars: number;
  historyCount: number;
  historyStatsComplete: boolean;
  estimateTokens: number;
  ruleChars?: number;
  projectInstructionChars?: number;
  payloadChars?: number | null;
  contextLimitChars?: number;
  previewMessages: AnyRow[] | null;
  previewError?: string | null;
  onClose: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const trimmedMessageCount = Number(
    previewMessages?.find((message) =>
      message.role === "system" && String(message.content || "").startsWith("[Context management:"),
    )?.content?.match(/^\[Context management: (\d+)/)?.[1] || 0,
  );
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
      label: historyStatsComplete
        ? tr("完整对话历史", "Full conversation history")
        : tr("最近已载入消息", "Recently loaded messages"),
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
    {
      label: tr("作品固定指令", "Project instructions"),
      value: `${projectInstructionChars} ${tr("字", "chars")}`,
      chars: projectInstructionChars,
    },
  ];
  const total = rows.reduce((n, r) => n + r.chars, 0) || 1;
  const payloadPercent = payloadChars == null
    ? null
    : Math.round((payloadChars / contextLimitChars) * 100);

  return (
    <Modal title={tr("上下文与发送内容", "Context and payload")} close={onClose}>
      <div className="zchat-context">
        <p className="hint">
          {tr(
            payloadChars == null
              ? `最终发送内容暂无法核对；下方为约 ${estimateTokens.toLocaleString()} tokens 的组成估算。`
              : `最终发送内容 ${payloadChars.toLocaleString()} / ${contextLimitChars.toLocaleString()} 字（${payloadPercent}%）；约 ${estimateTokens.toLocaleString()} tokens，按字符数 ÷2 估算，非服务商精确计费。`,
            payloadChars == null
              ? `The final payload could not be verified; the breakdown below is an estimate of about ${estimateTokens.toLocaleString()} tokens.`
              : `Final payload: ${payloadChars.toLocaleString()} / ${contextLimitChars.toLocaleString()} chars (${payloadPercent}%); about ${estimateTokens.toLocaleString()} tokens by chars ÷ 2, not provider billing.`,
          )}
        </p>
        <p className="hint">{tr("下方分类用于定位内容来源；最终发送长度以上方实际消息预览为准。", "The categories below help locate content; use the actual message preview for the final payload length.")}</p>
        {trimmedMessageCount > 0 && (
          <p className="zchat-context-trim" role="status">
            {tr(
              `本次请求将省略最早的 ${trimmedMessageCount} 条历史消息；完整记录仍保存在本机。`,
              `This request omits the ${trimmedMessageCount} earliest messages; your full history remains on this device.`,
            )}
          </p>
        )}
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
