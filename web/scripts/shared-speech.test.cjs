const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { Lexer } = require("marked");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");

const { appendDictation, splitSpeechText } = createLoader(require("typescript"), require)(
  path.join(__dirname, "../../shared/speech.ts"),
);
const speak = (markdown, limit) => splitSpeechText(Lexer.lex(markdown), limit);

test("dictation adds to the latest draft without altering its existing bytes", () => {
  assert.equal(appendDictation("edited draft  ", "  hello  "), "edited draft  \nhello");
  assert.equal(appendDictation("原有草稿\n", "新增內容"), "原有草稿\n新增內容");
  assert.equal(appendDictation("draft", " \n "), "draft");
  assert.equal(appendDictation("", "第一句"), "第一句");
});

test("read-aloud preserves public prose and link labels, leaving out code blocks and URLs", () => {
  const markdown = [
    "## **Summary**",
    "",
    "- [Current report](https://example.invalid/report_(1))",
    "> ~~~~python",
    "> internal_call()",
    "> ~~~",
    "> still_code()",
    "> ~~~~",
    "",
    "    indented_code()",
    "",
    "结果使用 `item_id`。 https://example.invalid/result",
    "![chart](https://example.invalid/chart.png)",
    "",
    "[ref]: https://example.invalid/reference",
  ].join("\n");
  assert.deepEqual(speak(markdown, 2000), [
    "Summary\n\nCurrent report\n\n结果使用 item_id。",
  ]);
  assert.deepEqual(speak("```js\nunfinished_code()", 2000), []);
});

test("fences within list items are silent and preserve the prose that follows", () => {
  const examples = [
    "Before.\n\n- ```sh\n  echo hello\n  ```\n\nAfter.",
    "Before.\n\n> 1. ~~~sh\n>    echo hello\n>    ~~~\n\nAfter.",
    "Before.\n\n- ```sh\n  echo hello\n\nAfter.",
    "Before.\n\n- > ```sh\n  > echo hello\n  > ```\n\nAfter.",
    "Before.\n\n> 1. First item\n>    - ```sh\n>      echo hello\n>      ```\n\nAfter.",
  ];
  for (const markdown of examples.slice(0, -1)) {
    assert.deepEqual(speak(markdown, 2000), ["Before.\n\nAfter."]);
  }
  assert.deepEqual(speak(examples.at(-1), 2000), ["Before.\n\nFirst item\n\nAfter."]);
});

test("table prose and checked item labels remain readable", () => {
  assert.deepEqual(speak("- [x] **Finished**\n\n| Name | Value |\n| -- | -- |\n| `item_id` | [Report][ref] |\n\n[ref]: https://example.invalid", 2000), [
    "Finished\n\nName, Value\nitem_id, Report",
  ]);
});

test("synthesis chunks prefer prose boundaries and count Unicode code points", () => {
  assert.deepEqual(speak("一二三。四五六。七八九。", 6), ["一二三。", "四五六。", "七八九。"]);
  assert.deepEqual(speak("First sentence. Another thought.", 22), ["First sentence.", "Another thought."]);
  assert.deepEqual(speak("aaaa😀bbbb😀", 5), ["aaaa😀", "bbbb😀"]);
  assert.deepEqual(speak("a", 0), []);
});
