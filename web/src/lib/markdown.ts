export function markdownImageUrls(source: string): Set<string> {
  const urls = new Set<string>();
  transformProse(source, (part) => {
    for (const image of part.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*["'])?\s*\)/g)) {
      const url = image[1] ?? image[2];
      if (url) urls.add(url);
    }
    return part;
  });
  return urls;
}

function escaped(source: string, index: number) {
  let slashes = 0;
  while (index > 0 && source[--index] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

type ProseTransform = (
  part: string,
  lineBounds: { startsLine: boolean; endsLine: boolean },
) => string;

function transformInlineProse(source: string, transform: ProseTransform) {
  let result = "",
    start = 0,
    cursor = 0;
  const transformSlice = (end: number) =>
    transform(source.slice(start, end), {
      startsLine: start === 0 || source[start - 1] === "\n",
      endsLine: end === source.length || source[end] === "\n",
    });
  while (cursor < source.length) {
    if (source[cursor] !== "`" || escaped(source, cursor)) {
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (source[end] === "`") end += 1;
    const length = end - cursor;
    let close = -1,
      next = end;
    while ((next = source.indexOf("`", next)) >= 0) {
      let runEnd = next;
      while (source[runEnd] === "`") runEnd += 1;
      if (runEnd - next === length) {
        close = next;
        break;
      }
      next = runEnd;
    }
    if (close < 0) {
      cursor = end;
      continue;
    }
    const after = close + length;
    result +=
      transformSlice(cursor) + source.slice(cursor, after);
    start = cursor = after;
  }
  return result + transformSlice(source.length);
}

// Match fence lengths instead of splitting on triple backticks: code examples
// may contain their own Markdown fences, and inline code may contain backticks.
function transformProse(source: string, transform: ProseTransform) {
  let result = "",
    prose = "";
  let fence: { character: string; length: number } | undefined;
  let indented = false,
    previousBlank = true;
  let math: "dollars" | "brackets" | undefined;
  const flush = () => {
    result += transformInlineProse(prose, transform);
    prose = "";
  };
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const body = line.replace(/\r?\n$/, "");
    const blank = /^\s*$/.test(body);
    if (fence) {
      result += line;
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(body);
      if (
        closing?.[1][0] === fence.character &&
        closing[1].length >= fence.length
      )
        fence = undefined;
      previousBlank = blank;
      continue;
    }
    const opening = !math && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
      flush();
      result += line;
      fence = { character: opening[1][0], length: opening[1].length };
      indented = false;
    } else if (
      !math &&
      ((/^(?: {4}|\t)/.test(body) && (indented || previousBlank)) ||
        (indented && blank))
    ) {
      flush();
      result += line;
      indented = true;
    } else {
      indented = false;
      prose += line;
      if (math === "brackets") {
        if (body.includes("\\]")) math = undefined;
      } else if (math === "dollars") {
        if (body.includes("$$")) math = undefined;
      } else {
        const trimmed = body.trimStart();
        if (trimmed.startsWith("\\[") && !trimmed.includes("\\]"))
          math = "brackets";
        else if (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$"))
          math = "dollars";
      }
    }
    previousBlank = blank;
  }
  flush();
  return result;
}

// Only normalize prose. Dollar amounts and code must remain byte-for-byte.
export function normalizeMath(source: string, streaming = false): string {
  return transformProse(source, (part, lineBounds) => {
    let normalized = part
      .replace(
        /\\\[([\s\S]*?)\\\]/g,
        (_, expression: string) => `\n$$\n${expression}\n$$\n`,
      )
      .replace(
        /\\\(([\s\S]*?)\\\)/g,
        (_, expression: string) => `$$${expression}$$`,
      )
      .replace(
        /(?<![\\$\w])\$(?!\$)([^$\n]+)\$(?!\$)/g,
        (whole, expression: string, offset: number, context: string) => {
          const value = expression.trim();
          if (
            /^[-+]?\d/.test(value) &&
            /^\d/.test(context.slice(offset + whole.length))
          )
            return whole;
          const isMath =
            /[\\^_=+{}]|^[-+]?\d[\d.,\s]*$|^[a-zA-Z](?:[\d, ()+\-*/]|[a-zA-Z]){0,8}$/.test(
              value,
            );
          return isMath ? `$$${value}$$` : whole;
        },
      );
    if (streaming)
      normalized = normalized
        .replace(
          /\\\[([^]*?)$/,
          (_, expression: string) => `\n$$\n${expression}`,
        )
        .replace(
          /\\\(([^]*?)$/,
          (_, expression: string) => `$$${expression}`,
        );
    // A standalone formula is a display block even when the model puts its
    // delimiters on one line. Inline-code fragment boundaries are not lines.
    normalized = normalized.replace(
      /^ {0,3}\$\$([^\n]+?)\$\$[ \t]*$/gm,
      (whole, expression: string, offset: number, context: string) => {
        if (
          (offset === 0 && !lineBounds.startsLine) ||
          (offset + whole.length === context.length && !lineBounds.endsLine)
        )
          return whole;
        return `$$\n${expression}\n$$`;
      },
    );
    return normalized;
  });
}
