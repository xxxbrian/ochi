import { FileArchive, FileCode, FileImage, FileSpreadsheet, FileText } from "lucide-react";
import { fileKind } from "../lib/files";
import type { Artifact } from "../lib/types";

const icons = {
  code: FileCode,
  html: FileCode,
  svg: FileCode,
  markdown: FileText,
  pdf: FileText,
  csv: FileSpreadsheet,
  image: FileImage,
  binary: FileArchive,
} as const;

/** Type tile (Design Lab .pv-tile): the file kind picks the icon and the tint, both from tokens. */
export function FileTile({ file, small = false }: { file: Pick<Artifact, "name" | "mime_type">; small?: boolean }) {
  const kind = fileKind(file);
  const Icon = icons[kind];
  return (
    <span className={`pv-tile${small ? " xs" : ""}`} data-kind={kind} aria-hidden="true">
      <Icon className="ic" strokeWidth={1.7} />
    </span>
  );
}
