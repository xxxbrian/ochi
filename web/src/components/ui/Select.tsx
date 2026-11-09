import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export type Choice = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  icon?: ReactNode;
};
export function SelectField({
  value,
  onChange,
  options,
  label,
  disabled,
  compact,
  icon,
  triggerClassName,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Choice[];
  label?: string;
  disabled?: boolean;
  compact?: boolean;
  icon?: ReactNode;
  triggerClassName?: string;
  title?: string;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      items={options}
      disabled={disabled}
    >
      <Select.Trigger
        className={`choice-trigger select-btn${compact ? " choice-compact" : ""}${triggerClassName ? ` ${triggerClassName}` : ""}`}
        aria-label={label}
        title={title}
      >
        {icon}
        <Select.Value className="choice-value">
          {(current) =>
            options.find((option) => option.value === current)?.label ??
            label ??
            current
          }
        </Select.Value>
        <Select.Icon className="choice-chevron">
          <ChevronDown size={14} className="ic" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="pop-positioner"
          sideOffset={7}
          collisionPadding={12}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="pop pop-select">
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  className="menu-item rich choice-item"
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                >
                  {option.icon}
                  <span className="mi-text">
                    <Select.ItemText className="choice-item-text">{option.label}</Select.ItemText>
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                  <Select.ItemIndicator className="choice-check">
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
