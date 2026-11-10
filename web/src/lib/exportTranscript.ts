import { api } from "./api";
import { t } from "./i18n";
import type { Message } from "./types";

/** Reads the whole visible transcript (paged oldest-last) and returns Markdown with user/assistant text and attachment names. */
export async function transcriptMarkdown(sessionId: string, title: string): Promise<string> {
  const pages: Message[][] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await api.messages(sessionId, before);
    if (!page.length) break;
    pages.unshift(page);
    if (page.length < 100) break;
    before = page[0].id;
  }
  const lines = [`# ${title}`, ""];
  for (const message of pages.flat()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    lines.push(`## ${message.role === "user" ? t("export.you") : message.model_name || t("export.assistant")}`, "");
    if (message.content.trim()) lines.push(message.content.trim(), "");
    for (const file of message.attachments ?? []) lines.push(`- ${file.name}`);
    if (message.attachments?.length) lines.push("");
  }
  return lines.join("\n");
}
export async function exportTranscript(sessionId: string, title: string) {
  const markdown = await transcriptMarkdown(sessionId, title);
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "conversation"}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
