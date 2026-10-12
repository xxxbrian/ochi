import { memo, useCallback, useMemo, useState } from "react";
import type { Artifact } from "../lib/types";
import { fileURL } from "../lib/api";
import { ArtifactViewer } from "./Artifacts";
import { Markdown } from "./Markdown";

function comparable(url: string) {
  try {
    const value = new URL(fileURL(url));
    return `${value.origin}${value.pathname}`;
  } catch {
    return url;
  }
}

export const ArtifactMarkdown = memo(function ArtifactMarkdown({
  content,
  files,
  streaming = false,
}: {
  content: string;
  files?: Artifact[];
  streaming?: boolean;
}) {
  const [selected, setSelected] = useState<Artifact | null>(null);
  const rendered = useMemo(() => {
    const images = new Set(
      files
        ?.filter((file) => file.mime_type.startsWith("image/"))
        .map((file) => comparable(file.url)),
    );
    if (!images.size) return content;
    // File cards own authenticated images; don't add a second unauthenticated copy.
    return content.replace(
      /(`{3,}[^\n]*\n[\s\S]*?\n`{3,}|`[^`\n]+`)|!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*["'])?\s*\)/g,
      (
        match,
        code: string | undefined,
        wrapped: string | undefined,
        url: string | undefined,
      ) => code ?? (images.has(comparable(wrapped ?? url ?? "")) ? "" : match),
    );
  }, [content, files]);
  const onLink = useCallback(
    (url: string) => {
      const file = files?.find(
        (item) => comparable(item.url) === comparable(url),
      );
      if (!file) return false;
      setSelected(file);
      return true;
    },
    [files],
  );
  return (
    <>
      <Markdown content={rendered} streaming={streaming} onLink={onLink} />
      {selected && (
        <ArtifactViewer file={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
});
