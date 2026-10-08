import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import ini from "highlight.js/lib/languages/ini";
import json from "highlight.js/lib/languages/json";
import pgsql from "highlight.js/lib/languages/pgsql";
import plaintext from "highlight.js/lib/languages/plaintext";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sql", pgsql);
hljs.registerLanguage("json", json);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("text", plaintext);

export interface CodeBlock {
  index: number;
  language: "sql" | "bash" | "other";
  code: string;
  /** Syntax-highlighted HTML, so the client doesn't have to ship highlight.js. */
  html: string;
  /** ```sql run / ```bash run blocks are meant to be executed from the lesson. */
  runnable: boolean;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The marker the lesson HTML carries in place of a code fence. */
export const CODE_MARKER = /<!--dsa-code-(\d+)-->/;

/**
 * Renders lesson markdown to HTML. Code fences are replaced by markers, so the client
 * can render them as interactive blocks (copy, and Run for `sql run` / `bash run`).
 */
export function renderLesson(markdown: string): { html: string; blocks: CodeBlock[] } {
  const blocks: CodeBlock[] = [];
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      code({ text, lang }) {
        const [name = "text", ...flags] = (lang ?? "").trim().split(/\s+/);
        const language = name === "sql" ? "sql" : name === "bash" || name === "sh" || name === "shell" ? "bash" : "other";
        const highlighted = hljs.getLanguage(name) ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : escapeHtml(text);
        blocks.push({ index: blocks.length, language, code: text, html: highlighted, runnable: flags.includes("run") });
        return `<!--dsa-code-${blocks.length - 1}-->`;
      },
      // Markdown in lessons is ours, but links still open safely.
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href);
        return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
      },
    },
  });
  return { html: marked.parse(markdown, { async: false }), blocks };
}

/** Prompts, stories and explanations: inline markdown only (bold, code, links). */
export function renderInline(markdown: string): string {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      codespan({ text }) {
        return `<code>${escapeHtml(text)}</code>`;
      },
    },
  });
  return marked.parseInline(markdown, { async: false });
}

export const highlight = (code: string, language: string) =>
  hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
