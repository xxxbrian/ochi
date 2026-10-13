import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, View, useWindowDimensions } from "react-native";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react-native";
import { api } from "../lib/api";
import type { Project, Schedule, Session } from "../lib/types";
import { useApp } from "../providers/AppProvider";
import {
  scheduleInstant,
  scheduleWallTime,
} from "../../../web/src/lib/scheduling";
import { Sheet } from "../ui/Sheet";
import {
  AppText,
  Button,
  ErrorNotice,
  Field,
  SettingRow,
  Surface,
} from "./ScreenChrome";
import { SessionSearch } from "./SessionSearch";
import { ScheduleTimePicker } from "./ScheduleTimePicker";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
type Choice = "project" | "model" | "effort" | null;

export function TaskEditor({
  visible,
  task,
  onClose,
  onSaved,
}: {
  visible: boolean;
  task?: Schedule;
  onClose: () => void;
  onSaved: (value: Schedule) => void;
}) {
  const { colors, models } = useApp();
  const { height } = useWindowDimensions();
  const compact = height < 500;
  const [draft, setDraft] = useState<Partial<Schedule>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [sessionSearch, setSessionSearch] = useState(false);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [choice, setChoice] = useState<Choice>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const model =
    models.find((item) => item.id === draft.model_id) ??
    models.find((item) => item.is_default) ??
    models[0];
  useEffect(() => {
    if (!visible) return;
    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    setDraft(
      task ?? {
        name: "",
        prompt: "",
        recurrence: "daily",
        timezone,
        time_of_day: "09:00",
        interval_minutes: 60,
        context_mode: "independent",
        weekdays: [1, 2, 3, 4, 5],
        enabled: true,
      },
    );
    setError("");
    setAdvanced(false);
    setChoice(null);
    setDateOpen(false);
    setTimeOpen(false);
    void api
      .projects()
      .then(setProjects)
      .catch(() => undefined);
    if (task?.session_id)
      void api
        .session(task.session_id)
        .then(setSelectedSession)
        .catch(() => undefined);
    else setSelectedSession(null);
  }, [visible, task?.id]);
  function patch(value: Partial<Schedule>) {
    setDraft((current) => ({ ...current, ...value }));
  }
  async function save() {
    if (!draft.name?.trim() || !draft.prompt?.trim()) return;
    if (draft.recurrence === "weekly" && !draft.weekdays?.length) {
      setError("请选择星期");
      return;
    }
    if (draft.context_mode === "session" && !draft.session_id) {
      setError("请选择对话");
      return;
    }
    if (draft.recurrence === "once" && !draft.once_at) {
      setError("请选择日期与时间");
      return;
    }
    if (
      draft.recurrence === "interval" &&
      (!draft.interval_minutes || draft.interval_minutes < 1)
    ) {
      setError("间隔至少为 1 分钟");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api.saveSchedule({
          ...draft,
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  const wall = scheduleWallTime(
    draft.once_at,
    draft.timezone ?? "Asia/Shanghai",
  );
  const selectedDate =
    wall.split("T")[0] ||
    scheduleWallTime(
      new Date(Date.now() + 86400000).toISOString(),
      draft.timezone ?? "Asia/Shanghai",
    ).split("T")[0] ||
    "";
  const selectedTime =
    draft.recurrence === "once"
      ? wall.split("T")[1] || "09:00"
      : (draft.time_of_day ?? "09:00");
  function setTime(value: string) {
    if (draft.recurrence === "once") {
      try {
        patch({
          once_at: scheduleInstant(
            `${selectedDate}T${value}`,
            draft.timezone ?? "Asia/Shanghai",
          ),
        });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "时间无效");
      }
    } else patch({ time_of_day: value });
  }
  const choiceItems =
    choice === "project"
      ? [
          { id: "", title: "无项目", detail: "" },
          ...projects.map((project) => ({
            id: project.id,
            title: project.name,
            detail: "",
          })),
        ]
      : choice === "model"
        ? [
            { id: "", title: "默认模型", detail: "" },
            ...models.map((item) => ({
              id: item.id,
              title: item.name,
              detail: item.provider_name ?? "",
            })),
          ]
        : [
            { id: "", title: "默认", detail: "" },
            ...(model?.reasoning_kind === "toggle"
              ? ["on", "off"]
              : (model?.efforts ?? [])
            ).map((value) => ({ id: value, title: value, detail: "" })),
          ];
  const saveButton = (
    <View style={[styles.footer, compact && { paddingHorizontal: 0 }]}>
      <Button
        busy={busy}
        disabled={!draft.name?.trim() || !draft.prompt?.trim()}
        onPress={() => void save()}
      >
        保存
      </Button>
    </View>
  );
  return (
    <Sheet
      visible={visible}
      title={task ? "编辑任务" : "创建任务"}
      onClose={onClose}
      height="full"
    >
      <View style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          <Field
            label="名称"
            value={draft.name ?? ""}
            onChangeText={(name) => patch({ name })}
          />
          <Field
            label="任务"
            multiline
            value={draft.prompt ?? ""}
            onChangeText={(prompt) => patch({ prompt })}
          />
          <AppText muted size={13} style={{ marginBottom: 7 }}>
            频率
          </AppText>
          <View style={[styles.segment, { backgroundColor: colors.hover }]}>
            {(
              [
                { value: "once", title: "单次" },
                { value: "daily", title: "每天" },
                { value: "weekly", title: "每周" },
                { value: "interval", title: "间隔" },
              ] as const
            ).map((item) => (
              <Pressable
                key={item.value}
                onPress={() => {
                  if (item.value === "once" && !draft.once_at) {
                    try {
                      patch({
                        recurrence: item.value,
                        once_at: scheduleInstant(
                          `${selectedDate}T${selectedTime}`,
                          draft.timezone ?? "Asia/Shanghai",
                        ),
                      });
                    } catch (reason) {
                      setError(
                        reason instanceof Error ? reason.message : "日期无效",
                      );
                    }
                  } else patch({ recurrence: item.value });
                }}
                style={[
                  styles.segmentItem,
                  draft.recurrence === item.value && {
                    backgroundColor: colors.raised,
                  },
                ]}
              >
                <AppText size={14} weight="medium">
                  {item.title}
                </AppText>
              </Pressable>
            ))}
          </View>
          {draft.recurrence === "interval" ? (
            <Field
              label="间隔（分钟）"
              value={String(draft.interval_minutes ?? 60)}
              keyboardType="number-pad"
              onChangeText={(value) =>
                patch({ interval_minutes: Number(value) })
              }
            />
          ) : (
            <Surface>
              {draft.recurrence === "once" && (
                <SettingRow
                  title="日期"
                  detail={selectedDate}
                  onPress={() => setDateOpen(!dateOpen)}
                />
              )}
              {dateOpen && draft.recurrence === "once" && (
                <DateGrid
                  value={selectedDate}
                  onChange={(value) => {
                    try {
                      patch({
                        once_at: scheduleInstant(
                          `${value}T${selectedTime}`,
                          draft.timezone ?? "Asia/Shanghai",
                        ),
                      });
                      setDateOpen(false);
                    } catch (reason) {
                      setError(
                        reason instanceof Error ? reason.message : "日期无效",
                      );
                    }
                  }}
                />
              )}
              <SettingRow
                title="时间"
                detail={selectedTime}
                onPress={() => setTimeOpen(!timeOpen)}
                last
              />
              {timeOpen && (
                <ScheduleTimePicker value={selectedTime} onChange={setTime} />
              )}
            </Surface>
          )}
          {draft.recurrence === "weekly" && (
            <View style={styles.weekdays}>
              {weekdays.map((day, index) => (
                <Pressable
                  key={day}
                  accessibilityLabel={`星期${day}`}
                  accessibilityState={{
                    selected: draft.weekdays?.includes(index + 1),
                  }}
                  onPress={() =>
                    patch({
                      weekdays: draft.weekdays?.includes(index + 1)
                        ? draft.weekdays.filter((value) => value !== index + 1)
                        : [...(draft.weekdays ?? []), index + 1],
                    })
                  }
                  style={[
                    styles.day,
                    {
                      backgroundColor: draft.weekdays?.includes(index + 1)
                        ? colors.text
                        : colors.hover,
                    },
                  ]}
                >
                  <AppText
                    size={14}
                    style={{
                      color: draft.weekdays?.includes(index + 1)
                        ? colors.canvas
                        : colors.text,
                    }}
                  >
                    {day}
                  </AppText>
                </Pressable>
              ))}
            </View>
          )}
          <Pressable
            onPress={() => setAdvanced(!advanced)}
            style={styles.advanced}
          >
            <AppText muted size={14}>
              高级设置
            </AppText>
            <ChevronDown
              size={16}
              color={colors.muted}
              style={{ transform: [{ rotate: advanced ? "180deg" : "0deg" }] }}
            />
          </Pressable>
          {advanced && (
            <>
              <Field
                label="时区"
                value={draft.timezone ?? "Asia/Shanghai"}
                autoCapitalize="none"
                onChangeText={(timezone) => patch({ timezone })}
              />
              <Surface>
                <SettingRow
                  title="项目"
                  detail={
                    projects.find((item) => item.id === draft.project_id)
                      ?.name ?? "无项目"
                  }
                  onPress={() => setChoice("project")}
                />
                <SettingRow
                  title="模型"
                  detail={draft.model_id ? model?.name : "默认模型"}
                  onPress={() => setChoice("model")}
                />
                {model?.reasoning_kind === "budget" ? (
                  <View style={{ padding: 14 }}>
                    <Field
                      label="思考预算"
                      keyboardType="number-pad"
                      value={
                        draft.effort?.replace("budget:", "") ??
                        String(model.reasoning_budget_default ?? 2048)
                      }
                      onChangeText={(value) =>
                        patch({ effort: `budget:${value}` })
                      }
                    />
                  </View>
                ) : model?.effort_parameter &&
                  ["effort", "toggle"].includes(model.reasoning_kind ?? "") ? (
                  <SettingRow
                    title="思考程度"
                    detail={draft.effort || "默认"}
                    onPress={() => setChoice("effort")}
                  />
                ) : null}
                <SettingRow title="连续对话" last>
                  <Switch
                    accessibilityLabel="复用指定对话"
                    value={draft.context_mode === "session"}
                    onValueChange={(enabled) =>
                      patch({
                        context_mode: enabled ? "session" : "independent",
                      })
                    }
                    trackColor={{ false: colors.border, true: colors.text }}
                    thumbColor={colors.canvas}
                  />
                </SettingRow>
                {draft.context_mode === "session" && (
                  <SettingRow
                    title="对话"
                    detail={selectedSession?.title ?? "选择对话"}
                    onPress={() => setSessionSearch(true)}
                    last
                  />
                )}
              </Surface>
            </>
          )}
          <Surface>
            <SettingRow title="启用" last>
              <Switch
                value={draft.enabled ?? true}
                onValueChange={(enabled) => patch({ enabled })}
                trackColor={{ false: colors.border, true: colors.text }}
                thumbColor={colors.canvas}
              />
            </SettingRow>
          </Surface>
          <ErrorNotice error={error} />
          {compact && saveButton}
        </ScrollView>
        {!compact && saveButton}
      </View>
      <Sheet
        visible={Boolean(choice)}
        title={
          choice === "project"
            ? "项目"
            : choice === "model"
              ? "模型"
              : "思考程度"
        }
        onClose={() => setChoice(null)}
        height={420}
      >
        <ScrollView contentContainerStyle={styles.choiceBody}>
          {choiceItems.map((item) => (
            <SettingRow
              key={item.id}
              title={item.title}
              detail={item.detail}
              onPress={() => {
                if (choice === "project") {
                  patch({ project_id: item.id, session_id: "" });
                  setSelectedSession(null);
                } else if (choice === "model")
                  patch({
                    model_id: item.id,
                    effort:
                      models.find((model) => model.id === item.id)
                        ?.default_effort ?? "",
                  });
                else patch({ effort: item.id });
                setChoice(null);
              }}
              last
            >
              {(choice === "project"
                ? (draft.project_id ?? "")
                : choice === "model"
                  ? (draft.model_id ?? "")
                  : (draft.effort ?? "")) === item.id && (
                <Check size={18} color={colors.text} />
              )}
            </SettingRow>
          ))}
        </ScrollView>
      </Sheet>
      <SessionSearch
        visible={sessionSearch}
        projectId={draft.project_id}
        onClose={() => setSessionSearch(false)}
        onSelect={(session) => {
          setSelectedSession(session);
          patch({ session_id: session.id });
        }}
      />
    </Sheet>
  );
}

function DateGrid({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { colors } = useApp();
  const [month, setMonth] = useState(() => new Date(`${value}T12:00:00`));
  const days = useMemo(() => {
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    const blanks = (start.getDay() + 6) % 7;
    const count = new Date(
      month.getFullYear(),
      month.getMonth() + 1,
      0,
    ).getDate();
    return [
      ...Array.from({ length: blanks }, () => 0),
      ...Array.from({ length: count }, (_, index) => index + 1),
    ];
  }, [month]);
  return (
    <View style={styles.calendar}>
      <View style={styles.month}>
        <Pressable
          onPress={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
          }
          style={styles.calendarArrow}
        >
          <ChevronLeft size={20} color={colors.text} />
        </Pressable>
        <AppText weight="medium" size={15}>
          {month.getFullYear()} 年 {month.getMonth() + 1} 月
        </AppText>
        <Pressable
          onPress={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
          }
          style={styles.calendarArrow}
        >
          <ChevronRight size={20} color={colors.text} />
        </Pressable>
      </View>
      <View style={styles.calendarGrid}>
        {weekdays.map((day) => (
          <View key={day} style={styles.calendarCell}>
            <AppText muted size={12}>
              {day}
            </AppText>
          </View>
        ))}
        {days.map((day, index) => {
          const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          return (
            <Pressable
              key={index}
              disabled={!day}
              onPress={() => onChange(key)}
              style={[
                styles.calendarCell,
                key === value && {
                  backgroundColor: colors.text,
                  borderRadius: 20,
                },
              ]}
            >
              <AppText
                size={14}
                style={{ color: key === value ? colors.canvas : colors.text }}
              >
                {day || ""}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { width: "100%", maxWidth: 680, alignSelf: "center", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20, gap: 8 },
  footer: { width: "100%", maxWidth: 680, alignSelf: "center", paddingHorizontal: 20, paddingBottom: 12, paddingTop: 7 },
  choiceBody: { width: "100%", maxWidth: 680, alignSelf: "center", padding: 12 },
  segment: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 12,
    marginBottom: 10,
  },
  segmentItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 9,
    borderRadius: 9,
  },
  weekdays: {
    width: "100%",
    maxWidth: 400,
    alignSelf: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  day: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  advanced: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  month: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  calendar: { width: "100%", maxWidth: 400, alignSelf: "center", padding: 14 },
  calendarArrow: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  calendarGrid: { flexDirection: "row", flexWrap: "wrap" },
  calendarCell: {
    width: "14.2857%",
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
});
