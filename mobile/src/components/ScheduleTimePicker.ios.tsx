import { t, useI18n, getLocale } from "../lib/i18n";
import { useMemo } from "react";
import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, environment, labelsHidden } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../providers/AppProvider";

export function ScheduleTimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  useI18n();
  const { dark, colors } = useTheme();
  const selection = useMemo(() => {
    const [hour = "09", minute = "00"] = value.split(":");
    const date = new Date();
    // The picker edits wall-clock fields; scheduling resolves the selected zone.
    date.setHours(Number(hour), Number(minute), 0, 0);
    return date;
  }, [value]);
  return (
    <Host
      colorScheme={dark ? "dark" : "light"}
      seedColor={colors.text}
      style={{ height: 176, width: "100%" }}
    >
      <DatePicker
        title={t("schedule.time")}
        selection={selection}
        displayedComponents={["hourAndMinute"]}
        modifiers={[datePickerStyle("wheel"), labelsHidden(), environment("locale", getLocale())]}
        onDateChange={(date) =>
          onChange(
            `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
          )
        }
      />
    </Host>
  );
}
