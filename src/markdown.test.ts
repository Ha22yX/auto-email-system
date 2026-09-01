import assert from "node:assert/strict";
import test from "node:test";
import { markdownToPlainText } from "./markdown";

test("markdown list previews keep readable text without syntax markers", () => {
  const markdown = [
    "**核心结论**：学校更新了着装要求。",
    "",
    "- **截止时间**：9 月 3 日",
    "- [查看附件](https://example.com/rules.pdf)"
  ].join("\n");

  assert.equal(
    markdownToPlainText(markdown),
    "核心结论：学校更新了着装要求。 截止时间：9 月 3 日 查看附件"
  );
});

test("markdown list previews never expose remote image markup", () => {
  assert.equal(markdownToPlainText("![跟踪图](https://example.com/pixel.gif) **安全提醒**"), "跟踪图 安全提醒");
});
