import { Menu } from "@base-ui/react/menu";
import type { ReactNode } from "react";

/** Lab popover menu: Base UI supplies focus, keyboard and collision handling; `.pop`/`.menu-item` supply the surface. */
export function ActionMenu({
  trigger,
  label,
  children,
  className,
  popupClassName,
  side = "bottom",
  align = "end",
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  className?: string;
  popupClassName?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger className={className ?? "icon-btn"} aria-label={label}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="pop-positioner" sideOffset={6} collisionPadding={8} collisionAvoidance={{ side: "flip", align: "shift" }} align={align} side={side}>
          <Menu.Popup className={`pop${popupClassName ? ` ${popupClassName}` : ""}`}>
            <div className="menu">{children}</div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function MenuAction({
  children,
  onClick,
  danger,
  disabled,
  hint,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <Menu.Item className={`menu-item${danger ? " danger" : ""}`} onClick={onClick} disabled={disabled}>
      {children}
      {hint ? <small>{hint}</small> : null}
    </Menu.Item>
  );
}
export const MenuSeparator = () => <div className="menu-sep" role="separator" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>;
