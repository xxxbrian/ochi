import { memo, useState, type KeyboardEvent } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import type { Message } from "../lib/types";
import { MarkdownMessage } from "./MarkdownMessage";
import "./user-message.css";

export const UserMessage = memo(function UserMessage({
  message,
  onEdit,
  onRetry,
}: {
  message: Message;
  onEdit?: (message: Message) => void;
  onRetry?: (message: Message) => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access depends on the browser's secure context and permissions.
    }
  }
  function keyboardMenu(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, clientX: rect.right - 16, clientY: rect.bottom - 8,
    }));
  }
  return (
    <ContextMenu.Root onOpenChange={(open, details) => {
      if (open && details.event.type.startsWith("touch") && "vibrate" in navigator) {
        navigator.vibrate(8);
      }
    }}>
      <ContextMenu.Trigger className="user-message-content" tabIndex={0}
        aria-label={message.content || "消息"} onKeyDown={keyboardMenu}>
        <MarkdownMessage message={message} />
        <div className="user-message-actions">
          <button className="icon-button" onClick={() => void copy()}
            aria-label={copied ? "已复制消息" : "复制消息"} title="复制">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          {onEdit && <button className="icon-button" onClick={() => onEdit(message)}
            aria-label="编辑消息" title="编辑"><Pencil size={15} /></button>}
          {onRetry && <button className="icon-button" onClick={() => onRetry(message)}
            aria-label="重新发送" title="重新发送"><RotateCcw size={15} /></button>}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="action-menu-positioner" sideOffset={6}
          collisionPadding={12} collisionAvoidance={{ side: "flip", align: "shift" }}>
          <ContextMenu.Popup className="action-menu user-message-menu">
            <ContextMenu.Item className="action-menu-item" onClick={() => void copy()}>
              <Copy size={16} />复制
            </ContextMenu.Item>
            {onEdit && <ContextMenu.Item className="action-menu-item" onClick={() => onEdit(message)}>
              <Pencil size={16} />编辑
            </ContextMenu.Item>}
            {onRetry && <ContextMenu.Item className="action-menu-item" onClick={() => onRetry(message)}>
              <RotateCcw size={16} />重新发送
            </ContextMenu.Item>}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
