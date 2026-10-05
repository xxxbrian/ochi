import { Menu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
export function ActionMenu({
  trigger,
  label,
  children,
  className,
  popupClassName,
  side = "bottom",
  align = "end",
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  className?: string;
  popupClassName?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={className ?? "icon-button action-menu-trigger"}
        aria-label={label}
      >
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="action-menu-positioner"
          sideOffset={6}
          collisionPadding={12}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          align={align}
          side={side}
        >
          <Menu.Popup className={`action-menu${popupClassName ? ` ${popupClassName}` : ""}`}>
            {children}
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
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.Item
      className={`action-menu-item${danger ? " danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Menu.Item>
  );
}
