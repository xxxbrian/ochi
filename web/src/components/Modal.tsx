import { t, useI18n } from "../lib/i18n";
import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  fullscreen = false,
  size,
  footer,
  bodyClassName = "",
  className = "",
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  fullscreen?: boolean;
  size?: "small" | "form" | "large" | "preview";
  footer?: ReactNode;
  bodyClassName?: string;
  className?: string;
  dismissible?: boolean;
}) {
  useI18n();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && dismissible) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup
          className={`modal modal-${size ?? (wide ? "preview" : "form")} ${fullscreen ? "modal-fullscreen" : ""} ${className}`}
        >
          <header className="modal-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("common.close")} disabled={!dismissible}>
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className={`modal-body ${bodyClassName}`}>{children}</div>
          {footer && <footer className="modal-footer">{footer}</footer>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
