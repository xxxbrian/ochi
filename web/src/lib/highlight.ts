// Synchronous source highlighter for the file and artifact viewers (Design Lab hl.js / preview.js).
// It only classifies tokens (tk-c comment, tk-s string, tk-k keyword, tk-n number, tk-f call/type);
// the colours are theme tokens, so light, dark and every look need no extra handling.

export type TokenClass = "tk-c" | "tk-s" | "tk-k" | "tk-n" | "tk-f" | "tk-comma";
export type Token = { text: string; cls?: TokenClass };
export type Flavor = "hash" | "slash" | "dash" | "markup" | "markdown" | "delimited" | "plain";

const KEYWORDS = [
  "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "import", "from", "as", "with",
  "try", "except", "raise", "finally", "None", "True", "False", "lambda", "yield", "self", "async", "await", "const", "let", "var",
  "function", "export", "new", "pass", "break", "continue", "print", "func", "type", "struct", "interface", "package", "go", "defer",
  "range", "switch", "case", "default", "fn", "pub", "impl", "use", "mod", "match", "mut", "enum", "trait", "static", "void", "int",
  "public", "private", "protected", "this", "extends", "implements", "throw", "throws", "catch", "null", "nil", "true", "false",
  "undefined", "typeof", "instanceof", "select", "insert", "update", "delete", "create", "table", "where", "join", "group", "order",
  "by", "limit", "into", "values", "set", "echo", "then", "fi", "do", "done", "esac", "local", "readonly", "end", "module", "require",
  "begin", "unless", "puts", "namespace", "using", "override", "abstract", "final", "volatile",
].join("|");

const COMMENTS: Record<string, string> = {
  hash: "#.*",
  slash: "\\/\\/.*|\\/\\*[\\s\\S]*?\\*\\/",
  dash: "--.*|\\/\\*[\\s\\S]*?\\*\\/",
};
const STRING = `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|\`(?:[^\`\\\\]|\\\\.)*\`|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'`;
const SOURCE_TAIL = `(\\b(?:${KEYWORDS})\\b)|(\\b\\d[\\d_.]*\\b)|(@\\w+|(?<=\\b(?:class|struct|interface|type|enum|trait) )[A-Za-z_]\\w*|[A-Za-z_]\\w*(?=\\())`;
const sourceRe = new Map<string, RegExp>();
function sourcePattern(flavor: keyof typeof COMMENTS) {
  let re = sourceRe.get(flavor);
  if (!re) {
    re = new RegExp(`(${COMMENTS[flavor]})|(${STRING})|${SOURCE_TAIL}`, "g");
    sourceRe.set(flavor, re);
  }
  return re;
}
const SOURCE_CLASSES: TokenClass[] = ["tk-c", "tk-s", "tk-k", "tk-n", "tk-f"];
const MARKUP = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][\w:-]*)|("[^"]*"|'[^']*')|([\w:-]+)(?==)/g;
const MARKUP_CLASSES: TokenClass[] = ["tk-c", "tk-k", "tk-s", "tk-n"];

const HASH = new Set(["py", "rb", "sh", "bash", "zsh", "yaml", "yml", "toml", "ini", "conf", "env", "r", "pl", "dockerfile", "mk", "make"]);
const DASH = new Set(["sql", "lua", "hs"]);
const MARKUP_EXT = new Set(["html", "htm", "xml", "svg", "xhtml", "vue"]);

/** Chooses the token rules for a file name (or a bare extension). */
export function flavorOf(nameOrExt: string): Flavor {
  const ext = (nameOrExt.includes(".") ? nameOrExt.slice(nameOrExt.lastIndexOf(".") + 1) : nameOrExt).toLowerCase();
  if (MARKUP_EXT.has(ext)) return "markup";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "delimited";
  if (ext === "txt" || ext === "log" || ext === "") return "plain";
  if (HASH.has(ext)) return "hash";
  if (DASH.has(ext)) return "dash";
  return "slash";
}

function splitTokens(text: string, classify: (match: RegExpMatchArray) => TokenClass | undefined, re: RegExp): Token[][] {
  const lines: Token[][] = [[]];
  const push = (value: string, cls?: TokenClass) =>
    value.split("\n").forEach((part, index) => {
      if (index) lines.push([]);
      if (part) lines[lines.length - 1].push(cls ? { text: part, cls } : { text: part });
    });
  let last = 0;
  for (const match of text.matchAll(re)) {
    push(text.slice(last, match.index));
    push(match[0], classify(match));
    last = match.index + match[0].length;
  }
  push(text.slice(last));
  return lines;
}

function markdownLine(line: string): Token[] {
  if (/^(```|>)/.test(line)) return [{ text: line, cls: "tk-c" }];
  if (/^#{1,6} /.test(line)) return [{ text: line, cls: "tk-f" }];
  if (/^\s*\|/.test(line)) return line.split(/(\|)/).filter(Boolean).map((part) => (part === "|" ? { text: part, cls: "tk-c" as const } : { text: part }));
  const list = /^(\s*(?:[-*]|\d+\.) )(.*)/.exec(line);
  const inline = (value: string): Token[] =>
    value
      .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
      .filter(Boolean)
      .map((part) => (part.startsWith("**") ? { text: part, cls: "tk-k" as const } : part.startsWith("`") ? { text: part, cls: "tk-s" as const } : { text: part }));
  return list ? [{ text: list[1], cls: "tk-n" }, ...inline(list[2])] : inline(line);
}

/** Per-line tokens for display. The returned array always has one entry per source line. */
export function highlightLines(text: string, flavor: Flavor): Token[][] {
  const source = text.replace(/\r\n?/g, "\n");
  if (flavor === "plain") return source.split("\n").map((line) => (line ? [{ text: line }] : []));
  if (flavor === "delimited") {
    return source.split("\n").map((line) =>
      line.split(/([,\t])/).filter(Boolean).map((part) => (part === "," || part === "\t" ? { text: part, cls: "tk-comma" as const } : { text: part })),
    );
  }
  if (flavor === "markdown") return source.split("\n").map(markdownLine);
  if (flavor === "markup") return splitTokens(source, (match) => MARKUP_CLASSES[match.findIndex((value, index) => index > 0 && value) - 1], MARKUP);
  return splitTokens(source, (match) => SOURCE_CLASSES[match.findIndex((value, index) => index > 0 && value) - 1], sourcePattern(flavor));
}
