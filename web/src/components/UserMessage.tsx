import { t, useI18n } from "../lib/i18n";
import { memo, useState, type KeyboardEvent, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Check, Copy, Pencil, RotateCw } from "lucide-react";
import type { Message } from "../lib/types";

/** User turn: attachments, the bubble (right-click / long-press menu) and hover tools. The look decides fill, alignment and weight through tokens. */
export const UserMessage = memo(function UserMessage({
  message,
  onEdit,
  onRetry,
  attachments,
}: {
  message: Message;
  onEdit?: (message: Message) => void;
  onRetry?: (message: Message) => void;
  attachments?: ReactNode;
}) {
  useI18n();
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
    event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.right - 16, clientY: rect.bottom - 8 }));
  }
  return (
    <ContextMenu.Root onOpenChange={(open, details) => {
      if (open && details.event.type.startsWith("touch") && "vibrate" in navigator) navigator.vibrate(8);
    }}>
      <div className="user-row">
        <div className="user-wrap">
          {attachments}
          <ContextMenu.Trigger className="user-body" tabIndex={0} aria-label={message.content || t("message.title")} onKeyDown={keyboardMenu}>
            {message.content}
          </ContextMenu.Trigger>
          <div className="user-tools">
            <button className={`icon-btn sm${copied ? " flash" : ""}`} onClick={() => void copy()} aria-label={copied ? t("message.copied") : t("message.copy")} title={t("common.copy")}>
              {copied ? <Check className="ic" /> : <Copy className="ic" />}
            </button>
            {onEdit && <button className="icon-btn sm" onClick={() => onEdit(message)} aria-label={t("chat.editMessage")} title={t("common.edit")}><Pencil className="ic" /></button>}
            {onRetry && <button className="icon-btn sm" onClick={() => onRetry(message)} aria-label={t("message.resend")} title={t("message.resend")}><RotateCw className="ic" /></button>}
          </div>
        </div>
      </div>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="pop-positioner" sideOffset={6} collisionPadding={8} collisionAvoidance={{ side: "flip", align: "shift" }}>
          <ContextMenu.Popup className="pop">
            <div className="menu">
              <ContextMenu.Item className="menu-item" onClick={() => void copy()}><Copy className="ic" />{t("common.copy")}</ContextMenu.Item>
              {onEdit && <ContextMenu.Item className="menu-item" onClick={() => onEdit(message)}><Pencil className="ic" />{t("common.edit")}</ContextMenu.Item>}
              {onRetry && <ContextMenu.Item className="menu-item" onClick={() => onRetry(message)}><RotateCw className="ic" />{t("message.resend")}</ContextMenu.Item>}
            </div>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
