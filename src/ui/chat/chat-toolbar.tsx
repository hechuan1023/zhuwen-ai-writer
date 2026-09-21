import { IconCollapse, IconExpand, IconFloat, IconHistory, IconMore, IconPlus, IconRename, IconTrash } from "./icons";
import { ChatMenu, type MenuItem } from "./menu";

/**
 * 顶部会话栏：唯一常驻的会话操作区（标题 / 新建 / 历史 / 展开 / 更多）。
 * 不再保留重复的 conversation-bar。
 */
export function ChatToolbar({
  title,
  language,
  float,
  canExpand,
  expanded,
  canRenameDelete,
  generatingLabel,
  onNew,
  onToggleHistory,
  historyOpen,
  onToggleExpand,
  onRename,
  onDelete,
  onOpenFloat,
  onCloseFloat,
}: {
  title: string;
  language: string;
  float?: boolean;
  canExpand?: boolean;
  expanded?: boolean;
  canRenameDelete: boolean;
  generatingLabel?: string | null;
  onNew: () => void;
  onToggleHistory: () => void;
  historyOpen: boolean;
  onToggleExpand?: () => void;
  onRename: () => void;
  onDelete: () => void;
  onOpenFloat?: () => void;
  onCloseFloat?: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const items: MenuItem[] = [
    {
      id: "ai-menu-rename",
      label: tr("重命名对话", "Rename conversation"),
      icon: <IconRename />,
      disabled: !canRenameDelete,
      onSelect: onRename,
    },
    {
      id: "ai-menu-delete",
      label: tr("删除对话", "Delete conversation"),
      icon: <IconTrash />,
      danger: true,
      disabled: !canRenameDelete,
      onSelect: onDelete,
    },
    ...(float
      ? [
          {
            id: "ai-menu-close-float",
            label: tr("收起浮窗", "Close floating window"),
            icon: <IconCollapse />,
            onSelect: () => onCloseFloat?.(),
          } satisfies MenuItem,
        ]
      : [
          {
            id: "ai-menu-float",
            label: tr("在独立窗口打开", "Open in floating window"),
            icon: <IconFloat />,
            onSelect: () => onOpenFloat?.(),
          } satisfies MenuItem,
        ]),
  ];

  return (
    <div className="zchat-toolbar" data-fd-id="ai-toolbar">
      <div className="zchat-toolbar-title" title={title}>
        <b className="zchat-ellipsis">{title}</b>
        {generatingLabel ? (
          <small className="zchat-generating" role="status" aria-live="polite">
            {generatingLabel}
          </small>
        ) : null}
      </div>
      <div className="zchat-toolbar-actions">
        <button
          type="button"
          className="zchat-icon-btn"
          data-fd-id="ai-new-chat"
          aria-label={tr("新建对话", "New conversation")}
          title={tr("新建对话", "New conversation")}
          onClick={onNew}
        >
          <IconPlus />
        </button>
        <button
          type="button"
          className={`zchat-icon-btn ${historyOpen ? "active" : ""}`}
          data-fd-id="ai-history-toggle"
          aria-label={tr("历史对话", "Conversation history")}
          aria-expanded={historyOpen}
          title={tr("历史对话", "Conversation history")}
          onClick={onToggleHistory}
        >
          <IconHistory />
        </button>
        {canExpand && !float ? (
          <button
            type="button"
            className={`zchat-icon-btn ${expanded ? "active" : ""}`}
            data-fd-id="ai-expand-toggle"
            aria-label={expanded ? tr("收起聊天区", "Collapse chat area") : tr("展开聊天区", "Expand chat area")}
            aria-pressed={expanded}
            title={expanded ? tr("收起聊天区", "Collapse chat area") : tr("展开聊天区（占用更大宽度）", "Expand chat area")}
            onClick={onToggleExpand}
          >
            {expanded ? <IconCollapse /> : <IconExpand />}
          </button>
        ) : null}
        <ChatMenu
          ariaLabel={tr("更多会话操作", "More conversation actions")}
          dataFdId="ai-more-menu"
          trigger={<IconMore />}
          items={items}
        />
      </div>
    </div>
  );
}
