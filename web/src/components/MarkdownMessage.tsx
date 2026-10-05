import { lazy, memo, Suspense, useMemo } from "react";
import type { Message } from "../lib/types";
import "./chat.css";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

// User text and an empty chat do not load the Markdown parser.
export const MarkdownMessage = memo(function MarkdownMessage({
  message,
  isStreaming = false,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  const content = useMemo(() => {
    let text = message.content;
    for (const file of message.attachments ?? []) {
      const paths = new Set([
        file.path,
        file.source_path ?? "",
        `/data/files/${file.path.replace(/^\/?data\/files\//, "")}`,
      ]);
      for (const path of paths)
        if (path)
          text = text
            .split(`](${path})`)
            .join(`](${file.url})`)
            .split(`](${path} "`)
            .join(`](${file.url} "`);
    }
    return text;
  }, [message.content, message.attachments]);
  return (
    <div
      className={`message-body ${message.role === "user" ? "user-body" : "assistant-body"}`}
    >
      {message.role === "user" ? (
        <p>{message.content}</p>
      ) : (
        <Suspense
          fallback={<p className="markdown-loading">{message.content}</p>}
        >
          <MarkdownContent content={content} isStreaming={isStreaming} />
        </Suspense>
      )}
    </div>
  );
});
