import { StyleSheet, View, useWindowDimensions } from "react-native";
import { ChevronLeft, X } from "lucide-react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../providers/AppProvider";
import { IconButton } from "../ui/IconButton";
import { AppText } from "./ScreenChrome";

export function SettingsPage({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, {
      backgroundColor: colors.surface,
      paddingLeft: insets.left,
      paddingRight: insets.right,
      paddingBottom: insets.bottom,
    }]}>
      {children}
    </View>
  );
}

export function SettingsHeader({
  title,
  root = false,
  right,
}: {
  title: string;
  root?: boolean;
  right?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height < 500;
  return (
    <View style={[styles.header, { paddingTop: insets.top + (compact ? 4 : 8), paddingBottom: compact ? 6 : 16 }]}>
      <View style={styles.side}>
        <IconButton
          icon={root ? X : ChevronLeft}
          label={root ? "关闭设置" : "返回"}
          variant="glass"
          size={42}
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/")
          }
        />
      </View>
      <AppText size={17} weight="semibold" numberOfLines={1} style={styles.title}>
        {title}
      </AppText>
      <View style={[styles.side, { alignItems: "flex-end" }]}>{right}</View>
    </View>
  );
}

export const settingsStyles = StyleSheet.create({
  content: { width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: 18, paddingTop: 16, paddingBottom: 36 },
  group: { borderRadius: 22, overflow: "hidden" },
  section: { marginTop: 28, marginBottom: 10, paddingHorizontal: 16 },
});

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  side: { width: 52, minHeight: 42, justifyContent: "center" },
  title: { flex: 1, textAlign: "center" },
});
