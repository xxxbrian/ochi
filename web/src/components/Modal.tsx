import { t, useI18n } from "../lib/i18n";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { ToastHost } from "./ui/Toast";

const ModalDepth = createContext(0);

/** Lab scrim + modal. The title is a heading for sighted users and the accessible name; `headerless` surfaces draw their own. */
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
  headerless = false,
  open: openProp = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  fullscreen?: boolean;
  size?: "small" | "form" | "large" | "preview" | "palette";
  footer?: ReactNode;
  bodyClassName?: string;
  className?: string;
  dismissible?: boolean;
  /** The content draws its own header; the title stays available to assistive tech and a corner close button remains. */
  headerless?: boolean;
  /** Lets the owner start the exit transition itself; onClose still fires only after it finished. */
  open?: boolean;
}) {
  useI18n();
  const depth = useContext(ModalDepth) + 1;
  const popup = useRef<HTMLDivElement>(null);
  // Closing plays the exit transition first; the owner's onClose (which unmounts this) runs once it has finished.
  const [dismissed, setDismissed] = useState(false);
  // Base UI only plays the enter transition for an open change, so mount closed and open on the next frame.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const frame = requestAnimationFrame(() => setMounted(true)); return () => cancelAnimationFrame(frame); }, []);
  const open = mounted && openProp && !dismissed;
  return (
    <ModalDepth value={depth}>
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (!dismissible) { details.cancel(); return; }
        setDismissed(true);
      }}
      onOpenChangeComplete={(next) => { if (!next && mounted) onClose(); }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="scrim" />
        <Dialog.Popup
          ref={popup}
          initialFocus={headerless ? popup : undefined}
          className={`modal modal-${size ?? (wide ? "preview" : "form")} ${fullscreen ? "modal-fullscreen" : ""} ${className}`}
        >
          {size === "palette" || headerless ? <>
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            {headerless && <Dialog.Close className="icon-btn modal-corner-close" aria-label={t("common.close")} disabled={!dismissible}><X size={16} /></Dialog.Close>}
          </> : <header className="modal-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-btn sm" aria-label={t("common.close")} disabled={!dismissible}>
              <X size={16} />
            </Dialog.Close>
          </header>}
          <div className={`modal-body ${bodyClassName}`}>{children}</div>
          {footer && <footer className="modal-footer">{footer}</footer>}
          <ToastHost priority={depth} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
    </ModalDepth>
  );
}
