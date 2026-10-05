import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { Streamdown, type PluginConfig } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { normalizeMath } from "../lib/markdown";
import "./markdown.css";

// Streamdown reuses stable rendered blocks. KaTeX and Shiki are
// scoped to the lazy message chunk so an empty chat does not pay their cost.
const basePlugins: PluginConfig = { cjk };
const controls = { code: { copy: true, download: false }, table: false };
const themes: [string, string] = ["github-light", "github-dark"];
let mathPromise: Promise<NonNullable<PluginConfig["math"]>> | undefined;
let codePromise: Promise<NonNullable<PluginConfig["code"]>> | undefined;
function loadMath() {
  return (mathPromise ??= Promise.all([
    import("@streamdown/math"),
    import("katex/dist/katex.min.css"),
  ]).then(([module]) =>
    module.createMathPlugin({
      singleDollarTextMath: false,
      errorColor: "#b42318",
    }),
  ));
}
function loadCode() {
  return (codePromise ??= import("@streamdown/code").then((module) =>
    module.createCodePlugin({ themes: ["github-light", "github-dark"] }),
  ));
}
const components: NonNullable<ComponentProps<typeof Streamdown>["components"]> =
  {
    p: ({ children }) => <p>{children}</p>,
    h1: ({ children }) => <h1>{children}</h1>,
    h2: ({ children }) => <h2>{children}</h2>,
    h3: ({ children }) => <h3>{children}</h3>,
    h4: ({ children }) => <h4>{children}</h4>,
    h5: ({ children }) => <h5>{children}</h5>,
    h6: ({ children }) => <h6>{children}</h6>,
    ul: ({ children }) => <ul>{children}</ul>,
    ol: ({ children, start }) => <ol start={start}>{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    // Code and math nodes are enhanced by the official Streamdown plugins.
    blockquote: ({ children }) => <blockquote>{children}</blockquote>,
    table: ({ children }) => (
      <div className="markdown-table">
        <table>{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children, align }) => (
      <th style={align && align !== "char" ? { textAlign: align } : undefined}>
        {children}
      </th>
    ),
    td: ({ children, align }) => (
      <td style={align && align !== "char" ? { textAlign: align } : undefined}>
        {children}
      </td>
    ),
    a: ({ children, href, title }) =>
      href?.startsWith("streamdown:") ? (
        <span>{children}</span>
      ) : (
        <a
          href={href}
          title={title}
          target="_blank"
          rel="noreferrer"
        >
          {children}
        </a>
      ),
    img: ({ src, alt, title }) =>
      src?.startsWith("streamdown:") ? null : (
        <img
          src={typeof src === "string" ? src : undefined}
          alt={alt ?? ""}
          title={title}
          loading="lazy"
        />
      ),
    hr: () => <hr />,
    strong: ({ children }) => <strong>{children}</strong>,
  };

export default function MarkdownContent({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  const [plugins, setPlugins] = useState(basePlugins);
  const normalized = useMemo(
    () => normalizeMath(content, isStreaming),
    [content, isStreaming],
  );
  const needsMath = normalized.includes("$$");
  const needsCode = /(?:^|\n)(?:```|~~~)/.test(content);
  useEffect(() => {
    let cancelled = false;
    if (needsMath && !plugins.math)
      void loadMath().then((math) => {
        if (!cancelled) setPlugins((current) => ({ ...current, math }));
      });
    if (needsCode && !plugins.code)
      void loadCode().then((code) => {
        if (!cancelled) setPlugins((current) => ({ ...current, code }));
      });
    return () => {
      cancelled = true;
    };
  }, [needsMath, needsCode, plugins.math, plugins.code]);
  // Switching to the static renderer replaces every block and loses selection.
  return (
    <Streamdown
      className="markdown"
      plugins={plugins}
      components={components}
      controls={controls}
      mode="streaming"
      parseIncompleteMarkdown={isStreaming}
      isAnimating={isStreaming}
      shikiTheme={themes}
    >
      {normalized}
    </Streamdown>
  );
}
