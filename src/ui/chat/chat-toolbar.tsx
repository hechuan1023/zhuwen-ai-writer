import { IconArchive, IconCollapse, IconDockLeft, IconDockRight, IconDoc, IconDownload, IconExpand, IconFloat, IconHistory, IconMore, IconPlus, IconRename, IconRestore, IconTrash } from "./icons";
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
  canExport,
  canArchive,
  archived,
  dockSide,
  hasProjectInstructions,
  generatingLabel,
  onNew,
  onToggleHistory,
  historyOpen,
  onToggleExpand,
  onRename,
  onExport,
  onToggleArchive,
  onOpenProjectInstructions,
  onDockSideChange,
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
  canExport: boolean;
  canArchive: boolean;
  archived: boolean;
  dockSide: "left" | "right";
  hasProjectInstructions: boolean;
  generatingLabel?: string | null;
  onNew: () => void;
  onToggleHistory: () => void;
  historyOpen: boolean;
  onToggleExpand?: () => void;
  onRename: () => void;
  onExport: () => void;
  onToggleArchive: () => void;
  onOpenProjectInstructions: () => void;
  onDockSideChange: (side: "left" | "right") => void;
  onDelete: () => void;
  onOpenFloat?: () => void;
  onCloseFloat?: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const items: MenuItem[] = [
    {
      id: "ai-menu-project-instructions",
      label: tr("作品 AI 指令", "Project AI instructions"),
      icon: <IconDoc />,
      hint: hasProjectInstructions ? tr("每轮生效", "Active") : tr("未设置", "Not set"),
      group: tr("作品", "Project"),
      onSelect: onOpenProjectInstructions,
    },
    {
      id: "ai-menu-rename",
      label: tr("重命名对话", "Rename conversation"),
      icon: <IconRename />,
      group: tr("对话", "Conversation"),
      disabled: !canRenameDelete,
      onSelect: onRename,
    },
    {
      id: "ai-menu-export",
      label: tr("导出为 Markdown", "Export as Markdown"),
      icon: <IconDownload />,
      group: tr("对话", "Conversation"),
      disabled: !canExport,
      onSelect: onExport,
    },
    {
      id: "ai-menu-archive",
      label: archived ? tr("从归档中恢复", "Restore conversation") : tr("归档对话", "Archive conversation"),
      icon: archived ? <IconRestore /> : <IconArchive />,
      group: tr("对话", "Conversation"),
      disabled: !canArchive,
      onSelect: onToggleArchive,
    },
    {
      id: "ai-menu-delete",
      label: tr("删除对话", "Delete conversation"),
      icon: <IconTrash />,
      group: tr("对话", "Conversation"),
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
            group: tr("窗口", "Window"),
            onSelect: () => onCloseFloat?.(),
          } satisfies MenuItem,
        ]
      : [
          {
            id: "ai-menu-float",
            label: tr("在独立窗口打开", "Open in floating window"),
            icon: <IconFloat />,
            group: tr("窗口", "Window"),
            onSelect: () => onOpenFloat?.(),
          } satisfies MenuItem,
        ]),
    ...(!float
      ? [{
          id: "ai-menu-dock-side",
          label: dockSide === "right" ? tr("移到左侧", "Move to left side") : tr("移到右侧", "Move to right side"),
          icon: dockSide === "right" ? <IconDockLeft /> : <IconDockRight />,
          group: tr("布局", "Layout"),
          onSelect: () => onDockSideChange(dockSide === "right" ? "left" : "right"),
        } satisfies MenuItem]
      : []),
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
