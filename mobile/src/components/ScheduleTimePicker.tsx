import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTheme } from "../providers/AppProvider";
import { AppText } from "./ScreenChrome";

const rowHeight = 36;
const pickerHeight = 176;

function TimeColumn({
  value,
  count,
  label,
  onChange,
}: {
  value: string;
  count: number;
  label: string;
  onChange: (value: string) => void;
}) {
  const list = useRef<ScrollView>(null);
  const center = () =>
    list.current?.scrollTo({ y: Number(value) * rowHeight, animated: false });
  useEffect(center, [value]);
  function settled(offset: number) {
    const next = Math.max(
      0,
      Math.min(count - 1, Math.round(offset / rowHeight)),
    );
    const text = String(next).padStart(2, "0");
    if (text !== value) onChange(text);
  }
  return (
    <ScrollView
      ref={list}
      style={styles.column}
      contentContainerStyle={styles.scroll}
      onLayout={center}
      showsVerticalScrollIndicator={false}
      snapToInterval={rowHeight}
      decelerationRate="fast"
      nestedScrollEnabled
      onMomentumScrollEnd={(event) =>
        settled(event.nativeEvent.contentOffset.y)
      }
    >
      {Array.from({ length: count }, (_, index) =>
        String(index).padStart(2, "0"),
      ).map((part) => (
        <Pressable
          key={part}
          accessibilityLabel={`${part} ${label}`}
          accessibilityState={{ selected: value === part }}
          onPress={() => onChange(part)}
          style={styles.cell}
        >
          <AppText
            size={19}
            muted={value !== part}
            weight={value === part ? "medium" : "regular"}
          >
            {part}
          </AppText>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function ScheduleTimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { colors } = useTheme();
  const [hour = "09", minute = "00"] = value.split(":");
  return (
    <View style={styles.picker}>
      <View
        pointerEvents="none"
        style={[styles.selected, { backgroundColor: colors.hover }]}
      />
      <TimeColumn
        value={hour}
        count={24}
        label="时"
        onChange={(part) => onChange(`${part}:${minute}`)}
      />
      <TimeColumn
        value={minute}
        count={60}
        label="分"
        onChange={(part) => onChange(`${hour}:${part}`)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  picker: {
    height: pickerHeight,
    flexDirection: "row",
    marginHorizontal: 18,
    marginBottom: 10,
  },
  column: { flex: 1 },
  scroll: { paddingVertical: (pickerHeight - rowHeight) / 2 },
  cell: { height: rowHeight, alignItems: "center", justifyContent: "center" },
  selected: {
    position: "absolute",
    top: (pickerHeight - rowHeight) / 2,
    left: 0,
    right: 0,
    height: rowHeight,
    borderRadius: 10,
  },
});
