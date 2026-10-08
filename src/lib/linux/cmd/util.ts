import { decodeBytesToUtf8, defineCommand } from "just-bash";
import type { ExecResult, ResolvedCommandContext } from "just-bash";
import { shellQuote } from "../system.ts";
import { HELP } from "./help.ts";

export type Ctx = ResolvedCommandContext;

export const ok = (stdout = "", stderr = "", exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });
export const fail = (stderr: string, exitCode = 1, stdout = ""): ExecResult => ({ stdout, stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`, exitCode });

export const stdinText = (ctx: Ctx) => (ctx.stdin ? decodeBytesToUtf8(ctx.stdin) : "");

export interface Parsed {
  flags: Set<string>;
  values: Record<string, string>;
  multi: Record<string, string[]>;
  rest: string[];
}

/**
 * Minimal getopt: `-la` combined flags, `-n 5`/`-n5` values, `--long`, `--long=value`, `--`.
 * `short` lists short options that take a value, `long` the long ones.
 */
export function parseArgs(args: string[], short = "", long: string[] = []): Parsed {
  const p: Parsed = { flags: new Set(), values: {}, multi: {}, rest: [] };
  const set = (k: string, v: string) => {
    p.values[k] = v;
    (p.multi[k] ??= []).push(v);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      p.rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) set(key, a.slice(eq + 1));
      else if (long.includes(key)) set(key, args[++i] ?? "");
      else p.flags.add(key);
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (short.includes(c)) {
          set(c, a.slice(j + 1) || args[++i] || "");
          break;
        }
        p.flags.add(c);
      }
    } else p.rest.push(a);
  }
  return p;
}

export const quoteArgs = (args: string[]) => args.map(shellQuote).join(" ");

/** Fixed-width table with left-aligned text and right-aligned numbers (like ps/df). */
export function table(rows: string[][], rightAlign: number[] = []) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : rightAlign.includes(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
        .join(" ")
        .trimEnd(),
    )
    .join("\n") + "\n";
}

export function relativeTime(t: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

export function longDate(t: number) {
  const d = new Date(t);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return `${day} ${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** defineCommand plus `--help` from the HELP table. */
export const command = (name: string, fn: (args: string[], ctx: Ctx) => Promise<ExecResult>) =>
  defineCommand(name, async (args, ctx) => (args[0] === "--help" && HELP[name] ? ok(`${HELP[name]}\n`) : fn(args, ctx)));
