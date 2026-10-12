import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import {
  ArrowLeft,
  ChevronRight,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../providers/AppProvider";
import { GlassSurface } from "../ui/GlassSurface";

export function AppText({
  children,
  muted = false,
  size = 16,
  weight = "regular",
  style,
  ...props
}: React.ComponentProps<typeof Text> & {
  muted?: boolean;
  size?: number;
  weight?: "regular" | "medium" | "semibold";
}) {
  const { colors, fonts } = useTheme();
  return (
    <Text
      {...props}
      style={[
        {
          color: muted ? colors.muted : colors.text,
          fontSize: size,
          lineHeight: size * 1.45,
          fontFamily: fonts[weight],
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function ActionIcon({
  icon: Icon,
  label,
  onPress,
  selected,
  disabled,
  color,
  size = 21,
  style,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  color?: string;
  size?: number;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={3}
      style={({ pressed }) => [
        styles.iconButton,
        selected && { backgroundColor: colors.hover },
        pressed && { opacity: 0.6 },
        disabled && { opacity: 0.35 },
        style,
      ]}
    >
      <Icon size={size} color={color ?? colors.text} strokeWidth={1.8} />
    </Pressable>
  );
}

export function PageHeader({
  title,
  back = true,
  right,
  onBack,
}: {
  title: string;
  back?: boolean;
  right?: React.ReactNode;
  onBack?: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 3,
          paddingLeft: insets.left + 12,
          paddingRight: insets.right + 12,
          minHeight: height < 500 ? 52 : 58,
          backgroundColor: colors.canvas,
        },
      ]}
    >
      <View style={styles.headerSide}>
        {back && (
          <ActionIcon
            icon={ArrowLeft}
            label="返回"
            onPress={
              onBack ??
              (() => (router.canGoBack() ? router.back() : router.replace("/")))
            }
          />
        )}
      </View>
      <AppText
        weight="medium"
        size={17}
        numberOfLines={1}
        style={styles.headerTitle}
      >
        {title}
      </AppText>
      <View style={[styles.headerSide, { alignItems: "flex-end" }]}>
        {right}
      </View>
    </View>
  );
}

export function Surface({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.surface, { backgroundColor: colors.surface }, style]}>
      {children}
    </View>
  );
}

export function SettingRow({
  icon: Icon,
  title,
  detail,
  children,
  onPress,
  danger = false,
  last = false,
}: {
  icon?: LucideIcon;
  title: string;
  detail?: string;
  children?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      <View style={styles.rowLeading}>
        {Icon && (
          <Icon
            size={21}
            color={danger ? colors.error : colors.muted}
            strokeWidth={1.8}
          />
        )}
        <AppText style={[styles.rowTitle, danger && { color: colors.error }]}>
          {title}
        </AppText>
      </View>
      <View style={styles.rowTrailing}>
        {detail && (
          <AppText muted size={14} numberOfLines={1} style={{ maxWidth: 150 }}>
            {detail}
          </AppText>
        )}
        {children}
        {onPress && <ChevronRight size={17} color={colors.subtle} />}
      </View>
    </>
  );
  const style = [
    styles.settingRow,
    !last && {
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
  ];
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...style, pressed && { opacity: 0.55 }]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={style}>{content}</View>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.sectionTitle}>
      <AppText muted size={13} weight="medium">
        {children}
      </AppText>
      {right}
    </View>
  );
}

export function Button({
  children,
  onPress,
  disabled = false,
  busy = false,
  secondary = false,
  danger = false,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondary?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  const foreground = secondary
    ? danger
      ? colors.error
      : colors.text
    : colors.canvas;
  return (
    <Pressable
      disabled={disabled || busy}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: secondary
            ? colors.hover
            : danger
              ? colors.error
              : colors.text,
        },
        (disabled || busy) && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={foreground} />
      ) : typeof children === "string" ? (
        <AppText weight="medium" size={15} style={{ color: foreground }}>
          {children}
        </AppText>
      ) : (
        children
      )}
    </Pressable>
  );
}

export function Field({
  label,
  style,
  multiline,
  ...props
}: TextInputProps & { label: string }) {
  const { colors, fonts } = useTheme();
  return (
    <View style={styles.field}>
      <AppText muted size={13}>
        {label}
      </AppText>
      <TextInput
        disableFullscreenUI
        {...props}
        accessibilityLabel={props.accessibilityLabel ?? label}
        multiline={multiline}
        placeholderTextColor={colors.subtle}
        selectionColor={colors.text}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.input,
            borderColor: colors.border,
            fontFamily: fonts.regular,
          },
          multiline && { minHeight: 106, textAlignVertical: "top" },
          style,
        ]}
      />
    </View>
  );
}

export function ErrorNotice({
  error,
  retry,
  safeArea = false,
}: {
  error?: string | null;
  retry?: () => void;
  safeArea?: boolean;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!error) return null;
  return (
    <View accessibilityRole="alert" style={[styles.error, safeArea && { paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
      <AppText size={14} style={{ color: colors.error, flex: 1 }}>
        {error}
      </AppText>
      {retry && (
        <Pressable onPress={retry}>
          <AppText size={14} weight="medium">
            重试
          </AppText>
        </Pressable>
      )}
    </View>
  );
}

export function EmptyState({
  icon: Icon,
  text,
}: {
  icon: LucideIcon;
  text: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <Icon size={30} color={colors.subtle} strokeWidth={1.5} />
      <AppText muted size={15}>
        {text}
      </AppText>
    </View>
  );
}

export function LoadingState() {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.muted} />
    </View>
  );
}

export function FloatingClose({ onPress }: { onPress: () => void }) {
  return (
    <GlassSurface style={{ borderRadius: 24 }}>
      <ActionIcon icon={X} label="关闭" onPress={onPress} />
    </GlassSurface>
  );
}

export function usePageContentStyle({
  horizontal = 20,
  top = 16,
  bottom = 32,
  gap = 16,
  maxWidth = 720,
} = {}): ViewStyle {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // A centered narrow column already supplies part (or all) of the notch inset.
  const gutter = Math.max(0, (width - maxWidth) / 2);
  return {
    width: "100%",
    maxWidth,
    alignSelf: "center",
    paddingLeft: horizontal + Math.max(0, insets.left - gutter),
    paddingRight: horizontal + Math.max(0, insets.right - gutter),
    paddingTop: top,
    paddingBottom: insets.bottom + bottom,
    gap,
  };
}

export const screenStyles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
});

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 5,
    minHeight: 58,
    gap: 4,
  },
  headerSide: { width: 48, justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center" },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
  },
  surface: { borderRadius: 18, overflow: "hidden" },
  settingRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowLeading: { flexDirection: "row", alignItems: "center", gap: 13, flex: 1 },
  rowTitle: { flex: 1 },
  rowTrailing: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: -6,
    paddingHorizontal: 3,
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  field: { gap: 6, marginBottom: 12 },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 22,
  },
  empty: {
    flex: 1,
    minHeight: 140,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  error: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 12,
    flexDirection: "row",
    alignItems: "center",
  },
});
