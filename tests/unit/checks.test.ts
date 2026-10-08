import { describe, expect, it } from "vitest";
import { mismatch } from "../../src/lib/linux/checks.ts";
import { CODE_MARKER, renderInline, renderLesson } from "../../src/lib/markdown.ts";

describe("output matchers", () => {
  it("accepts an exact match ignoring surrounding whitespace", () => {
    expect(mismatch("active\n", { equals: "active" })).toBeUndefined();
    expect(mismatch("inactive\n", { equals: "active" })).toBe('expected "active"');
  });

  it("requires every `contains` string", () => {
    expect(mismatch("nginx is active (running)", { contains: ["nginx", "running"] })).toBeUndefined();
    expect(mismatch("nginx is active", { contains: ["nginx", "running"] })).toContain("running");
  });

  it("rejects anything in `notContains`", () => {
    expect(mismatch("only errors here", { notContains: "listening" })).toBeUndefined();
    expect(mismatch("listening on port 3000", { notContains: "listening" })).toContain("should not be there");
  });

  it("matches a regex per line", () => {
    expect(mismatch("total 12\n0 2 * * * /home/student/scripts/backup.sh", { regex: "^0 2 \\* \\* \\* .*backup\\.sh$" })).toBeUndefined();
    expect(mismatch("0 3 * * * backup.sh", { regex: "^0 2 " })).toBe("the content doesn't match the expected pattern");
  });

  it("combines matchers, failing on the first problem", () => {
    expect(mismatch("a b", { contains: "a", notContains: "b" })).toContain("b");
  });
});

describe("lesson markdown", () => {
  const md = [
    "## What is it?",
    "",
    "Use `ls` to list files.",
    "",
    "```sql run",
    "SELECT 1;",
    "```",
    "",
    "```bash",
    "echo hi",
    "```",
  ].join("\n");

  it("extracts code fences and leaves markers in their place", () => {
    const { html, blocks } = renderLesson(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ language: "sql", runnable: true, code: "SELECT 1;" });
    expect(blocks[1]).toMatchObject({ language: "bash", runnable: false });
    expect(html).toContain("<!--dsa-code-0-->");
    expect(html).toContain("<!--dsa-code-1-->");
    expect(html).not.toContain("SELECT 1;");
    expect(CODE_MARKER.test("<!--dsa-code-0-->")).toBe(true);
  });

  it("highlights code without losing it", () => {
    const { blocks } = renderLesson(md);
    expect(blocks[0].html).toContain("SELECT");
    expect(blocks[0].html).toContain("hljs-keyword");
  });

  it("renders inline markdown without block wrappers", () => {
    expect(renderInline("Use `mkdir -p` first")).toBe("Use <code>mkdir -p</code> first");
    expect(renderInline("**bold**")).toBe("<strong>bold</strong>");
  });

  it("escapes HTML inside code", () => {
    expect(renderInline("`<script>alert(1)</script>`")).toBe("<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>");
  });
});
