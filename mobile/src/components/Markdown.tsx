import { memo, useMemo, useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from "react-native-enriched-markdown";
import { Copy } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "../providers/AppProvider";
import { Sheet } from "../ui/Sheet";
import { ActionIcon, AppText } from "./ScreenChrome";

// Keep raw model math semantic; Web's special $$inline$$ convention is not shared.
function nativeMath(content: string): string {
  return content.replace(
    /(```[\s\S]*?```|`[^`\n]+`)|\\\[([\s\S]*?)\\\]|\\\((.*?)\\\)/g,
    (
      match,
      code: string | undefined,
      display: string | undefined,
      inline: string | undefined,
    ) =>
      code ??
      (display !== undefined ? `\n\n$$\n${display}\n$$\n\n` : `$${inline}$`),
  );
}

export const Markdown = memo(function Markdown({
  content,
  streaming = false,
  compact = false,
  onLink,
}: {
  content: string;
  streaming?: boolean;
  compact?: boolean;
  onLink?: (url: string) => boolean;
}) {
  const { colors, fonts, dark } = useTheme();
  const [code, setCode] = useState<{ code: string; language?: string } | null>(
    null,
  );
  const markdown = useMemo(
    () => nativeMath(content),
    [content],
  );
  const markdownStyle = useMemo<MarkdownStyle>(() => {
    const base = {
      color: colors.text,
      fontFamily: fonts.regular,
      fontSize: compact ? 14 : 16,
      lineHeight: compact ? 22 : 26,
      marginBottom: compact ? 8 : 14,
    };
    return {
      paragraph: base,
      h1: {
        ...base,
        fontFamily: fonts.semibold,
        fontSize: 25,
        lineHeight: 33,
        marginTop: 16,
        marginBottom: 12,
      },
      h2: {
        ...base,
        fontFamily: fonts.semibold,
        fontSize: 21,
        lineHeight: 29,
        marginTop: 14,
        marginBottom: 10,
      },
      h3: {
        ...base,
        fontFamily: fonts.semibold,
        fontSize: 18,
        lineHeight: 27,
        marginTop: 12,
        marginBottom: 8,
      },
      h4: { ...base, fontFamily: fonts.semibold },
      h5: { ...base, fontFamily: fonts.semibold },
      h6: { ...base, fontFamily: fonts.semibold },
      strong: { fontFamily: fonts.semibold, color: colors.text },
      link: { color: colors.text, underline: true },
      code: {
        fontFamily: fonts.mono,
        color: colors.text,
        backgroundColor: colors.hover,
        fontSize: 14,
      },
      codeBlock: {
        ...base,
        fontFamily: fonts.mono,
        fontSize: 13,
        lineHeight: 21,
        backgroundColor: colors.canvas,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: 14,
        marginTop: 8,
        marginBottom: 14,
        syntaxColors: dark
          ? {
              keyword: "#ff7b72",
              string: "#a5d6ff",
              number: "#79c0ff",
              constant: "#79c0ff",
              comment: "#8b949e",
              function: "#d2a8ff",
              type: "#ffa657",
              operator: "#ff7b72",
              punctuation: "#c9d1d9",
              variable: "#c9d1d9",
              property: "#79c0ff",
              tag: "#7ee787",
              attribute: "#79c0ff",
              embedded: "#c9d1d9",
            }
          : {
              keyword: "#b4232c",
              string: "#067647",
              number: "#8f3f0f",
              constant: "#175cd3",
              comment: "#667085",
              function: "#175cd3",
              type: "#6e3cbc",
              operator: "#b4232c",
              punctuation: "#343b45",
              variable: "#24292f",
              property: "#175cd3",
              tag: "#067647",
              attribute: "#175cd3",
              embedded: "#24292f",
            },
      },
      list: {
        ...base,
        bulletColor: colors.text,
        markerColor: colors.text,
        gapWidth: 8,
        marginLeft: 18,
      },
      blockquote: {
        ...base,
        color: colors.muted,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 3,
        borderRadius: 6,
        padding: 12,
      },
      table: {
        fontFamily: fonts.regular,
        fontSize: 14,
        color: colors.text,
        borderColor: colors.border,
        borderRadius: 12,
        headerBackgroundColor: colors.hover,
        headerFontFamily: fonts.semibold,
        cellPaddingHorizontal: 12,
        cellPaddingVertical: 9,
        rowEvenBackgroundColor: colors.canvas,
        rowOddBackgroundColor: colors.surface,
      },
      math: {
        fontSize: 19,
        color: colors.text,
        backgroundColor: "transparent",
        padding: 10,
        marginBottom: 12,
      },
      inlineMath: { color: colors.text },
      image: { borderRadius: 14, marginBottom: 12 },
      taskList: {
        borderColor: colors.muted,
        checkedColor: colors.text,
        checkmarkColor: colors.canvas,
        checkboxSize: 17,
      },
    };
  }, [colors, fonts, dark, compact]);
  return (
    <>
      <EnrichedMarkdownText
        markdown={markdown}
        flavor="github"
        markdownStyle={markdownStyle}
        streamingAnimation={streaming}
        streamingConfig={{
          tableMode: "progressive",
          codeBlockMode: "progressive",
        }}
        enableTaskListItemToggle={false}
        selectionMenuConfig={{
          copy: { label: "复制" },
          copyAsMarkdown: { label: "复制 Markdown" },
          copyImageUrl: { label: "复制图片链接" },
        }}
        onLinkPress={({ url }) => {
          if (onLink?.(url)) return;
          if (/^https?:|^mailto:|^tel:/i.test(url))
            void Linking.openURL(url).catch(() => undefined);
        }}
        onCodeBlockPress={setCode}
      />
      <Sheet
        visible={Boolean(code)}
        title={code?.language || "代码"}
        onClose={() => setCode(null)}
        height="large"
      >
        <View style={styles.codeToolbar}>
          <AppText muted size={13}>
            {code?.language}
          </AppText>
          <ActionIcon
            icon={Copy}
            label="复制代码"
            onPress={() => {
              if (code) void Clipboard.setStringAsync(code.code);
            }}
          />
        </View>
        <ScrollView horizontal>
          <ScrollView contentContainerStyle={styles.codeBody}>
            <AppText
              selectable
              size={14}
              style={{ fontFamily: fonts.mono, lineHeight: 23 }}
            >
              {code?.code}
            </AppText>
          </ScrollView>
        </ScrollView>
      </Sheet>
    </>
  );
});

const styles = StyleSheet.create({
  codeToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  codeBody: { padding: 18 },
});
