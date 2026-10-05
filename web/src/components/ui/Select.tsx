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
        className={`choice-trigger${compact ? " choice-compact" : ""}${triggerClassName ? ` ${triggerClassName}` : ""}`}
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
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="choice-positioner"
          sideOffset={7}
          collisionPadding={12}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="choice-popup">
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  className="choice-item"
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                >
                  <span className="choice-check">
                    <Select.ItemIndicator>
                      <Check size={15} />
                    </Select.ItemIndicator>
                  </span>
                  {option.icon}
                  <Select.ItemText className="choice-item-text">
                    <span>{option.label}</span>
                    {option.detail && <small>{option.detail}</small>}
                  </Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
