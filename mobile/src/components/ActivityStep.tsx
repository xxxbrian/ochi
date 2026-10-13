import { memo, useMemo, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { Brain, ChevronDown, ChevronRight, FileText, Globe, Monitor, Terminal, Wrench, type LucideIcon } from "lucide-react-native";
import type { Artifact, Step } from "../lib/types";
import { imageSource } from "../lib/api";
import { searchResults, stepTarget, website, type SearchResult } from "../lib/processTimeline";
import { useTheme } from "../providers/AppProvider";
import { AppText } from "./ScreenChrome";
import { Markdown } from "./Markdown";
import { ArtifactCards } from "./Artifacts";

const names: Record<string, [string, LucideIcon]> = {
  exec: ["运行代码", Terminal],
  files_read: ["读取文件", FileText],
  files_write: ["写入文件", FileText],
  files_list: ["浏览文件", FileText],
  publish_file: ["交付文件", FileText],
  web_search: ["搜索资料", Globe],
  web_fetch: ["读取网页", Globe],
  request_user_input: ["等待回复", Wrench],
  request_computer_permission: ["请求使用电脑", Monitor],
  memory_search: ["查找记忆", Brain],
  memory_save: ["保存记忆", Brain],
  memory_delete: ["删除记忆", Brain],
  schedule_create: ["创建定时任务", Wrench],
  schedule_update: ["更新定时任务", Wrench],
  schedule_list: ["查看定时任务", Wrench],
  generate_image: ["生成图片", FileText],
};
function info(step: Step): [string, LucideIcon] {
  return (
    names[step.name] ??
    (step.name.startsWith("browser_")
      ? ["操作网页", Globe]
      : step.name.startsWith("computer_")
        ? ["操作电脑", Monitor]
        : step.name.startsWith("mcp_")
          ? [step.name.replace(/^mcp_/, "").replace(/_/g, " "), Wrench]
          : step.name.startsWith("skills_")
            ? ["使用 Skill", Wrench]
            : [step.name.replace(/_/g, " "), Wrench])
  );
}
function text(
  object: Record<string, unknown> | null | undefined,
  keys: string[],
): string {
  for (const key of keys)
    if (typeof object?.[key] === "string" && (object[key] as string).trim())
      return object[key] as string;
  return "";
}

export type StepExpansion = { open: boolean; technical: boolean };

export const StepRow = memo(function StepRow({ step, expansion, onExpansionChange }: {
  step: Step;
  expansion?: StepExpansion;
  onExpansionChange?: (id: string, expansion: StepExpansion) => void;
}) {
  const { colors, fonts } = useTheme();
  const [localExpansion, setLocalExpansion] = useState<StepExpansion>({ open: false, technical: false });
  const currentExpansion = expansion ?? localExpansion;
  const { open, technical } = currentExpansion;
  function changeExpansion(change: Partial<StepExpansion>) {
    const next = { ...currentExpansion, ...change };
    if (!expansion) setLocalExpansion(next);
    onExpansionChange?.(step.id, next);
  }
  const [label, Icon] = info(step);
  const search = useMemo(() => searchResults(step), [step.name, step.output, step.arguments]);
  const target = search?.query || stepTarget(step);
  const result = useMemo<Record<string, unknown> | null>(() => {
    if (!open || !step.output) return null;
    try {
      const parsed: unknown = JSON.parse(step.output);
      if (parsed && typeof parsed === "object")
        return Array.isArray(parsed)
          ? { results: parsed }
          : (parsed as Record<string, unknown>);
    } catch {
      /* Plain command output remains plain text. */
    }
    return null;
  }, [open, step.output]);
  const stdout = result
    ? text(result, [
        "stdout",
        "output",
        "content",
        "text",
        "message",
        "instructions",
      ])
    : (step.output ?? "");
  const stderr = result ? text(result, ["stderr", "error"]) : "";
  const collection =
    result?.files ??
    result?.entries ??
    result?.results ??
    result?.tabs ??
    result?.sources ??
    result?.memories ??
    result?.skills;
  const url = text(result, ["url"]);
  const title = text(result, ["title", "name"]);
  const deliveredArtifact =
    result?.artifact && typeof result.artifact === "object"
      ? (result.artifact as Artifact)
      : null;
  return (
    <View collapsable={false} style={styles.step}>
      <View style={styles.stepRail}>
        {step.status === "running" ? (
          <ActivityIndicator size="small" color={colors.muted} />
        ) : (
          <Icon
            size={16}
            color={step.status === "failed" ? colors.error : colors.muted}
            strokeWidth={1.7}
          />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Pressable
          onPress={() => changeExpansion({ open: !open })}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={styles.stepHeader}
        >
          <View style={{ flex: 1 }}>
            <View style={styles.heading}>
              <AppText size={13}>{label}</AppText>
              {step.status === "failed" && (
                <AppText size={11} style={{ color: colors.error }}>失败</AppText>
              )}
            </View>
            {target && (
              <AppText muted size={12} numberOfLines={1}>
                {target}
              </AppText>
            )}
            {search && <SearchSummary results={search.results} />}
          </View>
          {open ? (
            <ChevronDown size={14} color={colors.muted} />
          ) : (
            <ChevronRight size={14} color={colors.subtle} />
          )}
        </Pressable>
        {open && (
          <View
            style={[styles.stepOutput, { backgroundColor: colors.surface }]}
          >
            {step.screenshot && (
              <Image
                source={imageSource(step.screenshot)}
                style={{ width: "100%", height: 160, borderRadius: 8 }}
                resizeMode="contain"
              />
            )}
            {step.name === "files_write" &&
              typeof step.arguments?.content === "string" && (
                <Markdown
                  compact
                  content={
                    /\.md$/i.test(target)
                      ? step.arguments.content
                      : `\`\`\`\n${step.arguments.content.slice(0, 18000)}\n\`\`\``
                  }
                />
              )}
            {search ? (
              <SearchLinks results={search.results} />
            ) : deliveredArtifact ? (
              <ArtifactCards files={[deliveredArtifact]} />
            ) : step.name === "publish_file" &&
              result &&
              typeof result.url === "string" ? (
              <ArtifactCards files={[result as unknown as Artifact]} />
            ) : (
              <>
                {url && (
                  <Pressable
                    onPress={() => {
                      if (/^https?:/.test(url)) void Linking.openURL(url);
                    }}
                  >
                    <AppText size={14} weight="medium">
                      {title || url}
                    </AppText>
                    <AppText muted size={12} numberOfLines={2}>
                      {url}
                    </AppText>
                  </Pressable>
                )}
                {Array.isArray(collection) &&
                  collection.slice(0, 40).map((item, index) => {
                    const row =
                      item && typeof item === "object"
                        ? (item as Record<string, unknown>)
                        : { name: String(item) };
                    return (
                      <View key={index} style={styles.resultRow}>
                        <FileText size={14} color={colors.muted} />
                        <View style={{ flex: 1 }}>
                          <AppText size={13}>
                            {text(row, [
                              "title",
                              "name",
                              "path",
                              "content",
                              "text",
                              "url",
                            ])}
                          </AppText>
                          {typeof row.description === "string" && (
                            <AppText muted size={12}>
                              {row.description}
                            </AppText>
                          )}
                        </View>
                      </View>
                    );
                  })}
                {stdout && (
                  <AppText
                    selectable
                    size={12}
                    style={{ fontFamily: fonts.mono, lineHeight: 20 }}
                  >
                    {stdout.slice(0, 24000)}
                  </AppText>
                )}
                {stderr && (
                  <AppText
                    selectable
                    size={12}
                    style={{ color: colors.error, fontFamily: fonts.mono }}
                  >
                    {stderr.slice(0, 12000)}
                  </AppText>
                )}
                {typeof result?.exit_code === "number" && (
                  <AppText muted size={12}>
                    退出 {result.exit_code}
                  </AppText>
                )}
              </>
            )}
            <Pressable
              onPress={() => changeExpansion({ technical: !technical })}
              style={{ paddingVertical: 4 }}
            >
              <AppText muted size={12}>
                {technical ? "收起技术详情" : "技术详情"}
              </AppText>
            </Pressable>
            {technical && (
              <AppText selectable size={11} style={{ fontFamily: fonts.mono }}>
                {JSON.stringify(
                  { arguments: step.arguments, result: result ?? step.output },
                  null,
                  2,
                ).slice(0, 24000)}
              </AppText>
            )}
          </View>
        )}
      </View>
    </View>
  );
});

const SiteIcon = memo(function SiteIcon({ url }: { url: string }) {
  const { colors } = useTheme();
  const site = website(url);
  const [failed, setFailed] = useState(false);
  return (
    <View style={[styles.siteIcon, { backgroundColor: colors.hover }]} accessibilityElementsHidden>
      {site?.favicon && !failed ? (
        <Image
          // Website icons never use the API's authenticated image source.
          source={{ uri: site.favicon }}
          onError={() => setFailed(true)}
          style={styles.favicon}
          resizeMode="contain"
        />
      ) : (
        <AppText muted size={10} weight="medium">{site?.host.slice(0, 1).toUpperCase() || "·"}</AppText>
      )}
    </View>
  );
});

const SearchSummary = memo(function SearchSummary({ results }: { results: SearchResult[] }) {
  const sites = useMemo(() => {
    const seen = new Set<string>();
    return results.filter((result) => {
      const host = website(result.url)?.host;
      if (!host || seen.has(host)) return false;
      seen.add(host);
      return true;
    }).slice(0, 5);
  }, [results]);
  return (
    <View style={styles.searchSummary}>
      <View style={styles.siteStack}>
        {sites.map((site) => <SiteIcon key={website(site.url)?.host} url={site.url} />)}
      </View>
      <AppText muted size={11}>{results.length ? `${results.length} 个结果` : "没有找到结果"}</AppText>
    </View>
  );
});

const SearchLinks = memo(function SearchLinks({ results }: { results: SearchResult[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.searchLinks}>
      {results.length === 0 && <AppText muted size={12}>没有找到结果</AppText>}
      {results.map((result) => (
        <Pressable
          key={result.url}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(result.url).catch(() => undefined)}
          style={({ pressed }) => [styles.searchLink, pressed && { backgroundColor: colors.hover }]}
        >
          <SiteIcon url={result.url} />
          <View style={{ flex: 1, gap: 2 }}>
            <AppText muted size={11} numberOfLines={1}>{website(result.url)?.host}</AppText>
            <AppText size={13} numberOfLines={2}>{result.title}</AppText>
            {result.description && <AppText muted size={12} numberOfLines={3}>{result.description}</AppText>}
            {result.publishedAt && <AppText muted size={11}>{result.publishedAt}</AppText>}
          </View>
        </Pressable>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  step: { flexDirection: "row", gap: 8 },
  stepRail: { width: 18, paddingTop: 11, alignItems: "center" },
  heading: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepHeader: {
    minHeight: 42,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    paddingVertical: 5,
  },
  stepOutput: {
    padding: 10,
    borderRadius: 9,
    marginTop: 2,
    marginBottom: 4,
    gap: 7,
  },
  resultRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  siteIcon: { width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  favicon: { width: 14, height: 14 },
  searchSummary: { flexDirection: "row", alignItems: "center", gap: 7, paddingTop: 4 },
  siteStack: { flexDirection: "row", gap: 3 },
  searchLinks: { gap: 4 },
  searchLink: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 7, paddingHorizontal: 2, borderRadius: 6 },
});
