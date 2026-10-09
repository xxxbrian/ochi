function wallTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

export function scheduleWallTime(iso: string | undefined, timezone: string) {
  if (!iso) return "";
  try {
    return wallTime(new Date(iso), timezone);
  } catch {
    return "";
  }
}

export function scheduleInstant(value: string, timezone: string) {
  if (!value) return "";
  const desired = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(desired)) throw new Error("日期或时间无效");
  let instant = desired;
  // Resolve a selected-zone wall clock without inheriting the device timezone.
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const visible = Date.parse(
        `${wallTime(new Date(instant), timezone)}:00Z`,
      );
      const shift = desired - visible;
      if (!shift) return new Date(instant).toISOString();
      instant += shift;
    }
  } catch {
    throw new Error("时区无效");
  }
  throw new Error("此时间在所选时区不存在");
}
