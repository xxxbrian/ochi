export function appendDictation(draft: string, text: string): string {
  const transcript = text.trim();
  if (!transcript) return draft;
  return draft && !draft.endsWith("\n") ? `${draft}\n${transcript}` : draft + transcript;
}

type SpeechCell = { tokens: readonly SpeechToken[] };

type SpeechToken = {
  type: string;
  tokens?: readonly SpeechToken[];
  text?: string;
  items?: readonly SpeechToken[];
  autolink?: boolean;
  header?: readonly SpeechCell[];
  rows?: readonly (readonly SpeechCell[])[];
};

function spokenInline(tokens: readonly SpeechToken[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "br":
        return "\n";
      case "link":
        return token.autolink ? "" : spokenInline(token.tokens ?? []);
      case "strong":
      case "em":
      case "del":
        return spokenInline(token.tokens ?? []);
      case "text":
      case "escape":
      case "codespan":
        return token.tokens ? spokenInline(token.tokens) : token.text ?? "";
      default:
        return "";
    }
  }).join("");
}

function collectSpokenBlocks(tokens: readonly SpeechToken[], blocks: string[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "list":
        collectSpokenBlocks(token.items ?? [], blocks);
        break;
      case "list_item":
      case "blockquote":
        collectSpokenBlocks(token.tokens ?? [], blocks);
        break;
      case "heading":
      case "paragraph":
      case "text": {
        const text = (token.tokens ? spokenInline(token.tokens) : token.text ?? "").trim();
        if (text) blocks.push(text);
        break;
      }
      case "table": {
        const rows = [token.header ?? [], ...token.rows ?? []];
        const text = rows.map((row) => row.map((cell) => spokenInline(cell.tokens).trim())
          .filter(Boolean).join(", ")).filter(Boolean).join("\n");
        if (text) blocks.push(text);
        break;
      }
    }
  }
}

export function splitSpeechText(tokens: readonly SpeechToken[], maxCharacters: number): string[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) return [];
  const blocks: string[] = [];
  collectSpokenBlocks(tokens, blocks);
  const characters = Array.from(blocks.join("\n\n"));
  const chunks: string[] = [];
  for (let start = 0; start < characters.length;) {
    let end = Math.min(start + maxCharacters, characters.length);
    if (end < characters.length) {
      // Prefer a sentence or line break, then keep a word intact when possible.
      let wordBreak = end;
      const earliest = start + Math.floor(maxCharacters / 2);
      for (let index = end; index > earliest; index--) {
        const before = characters[index - 1]!;
        const after = characters[index]!;
        if (before === "\n" || /[。！？]/u.test(before) || (/[.!?]/.test(before) && /\s/u.test(after))) {
          wordBreak = index;
          break;
        }
        if (wordBreak === end && (/\s/u.test(before) || /\s/u.test(after))) wordBreak = index;
      }
      end = wordBreak;
    }
    const chunk = characters.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    start = end;
    while (start < characters.length && /\s/u.test(characters[start]!)) start++;
  }
  return chunks;
}
