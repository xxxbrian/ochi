import { useCallback, useEffect, useState } from "react";
import { clipText, fetchPrivate } from "../lib/files";
import { t } from "../lib/i18n";
import type { Artifact } from "../lib/types";

export type FileContent =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; text: string; truncated: boolean; bytes: ArrayBuffer | null };

/**
 * Private bytes come through the authenticated API (same origin, session cookie, never a bearer
 * header). "text" decodes and clips for the source viewers; "bytes" hands the raw buffer to the PDF
 * renderer, which draws to canvas so a mislabeled file can never run as same-origin HTML.
 */
export function useFileContent(file: Pick<Artifact, "url" | "mime_type"> | null, as: "text" | "bytes") {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<FileContent>({ status: "loading" });
  const url = file?.url;
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await fetchPrivate(url, controller.signal);
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        if (as === "bytes") setState({ status: "ready", text: "", truncated: false, bytes });
        else {
          const { text, truncated } = clipText(new TextDecoder("utf-8").decode(bytes));
          setState({ status: "ready", text, truncated, bytes: null });
        }
      } catch (reason) {
        if (controller.signal.aborted || (reason as Error).name === "AbortError") return;
        setState({ status: "error", error: reason instanceof Error && reason.message ? reason.message : t("file.loadError") });
      }
    })();
    return () => controller.abort();
  }, [url, as, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { content: state, retry };
}
