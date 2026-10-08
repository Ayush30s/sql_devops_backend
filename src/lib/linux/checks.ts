/** State checks used to verify Linux exercises. The learner's commands are never compared as text. */

export interface Matcher {
  equals?: string;
  contains?: string | string[];
  notContains?: string | string[];
  regex?: string;
}

export type LinuxCheck = { label: string } & (
  | { type: "FILE_EXISTS"; path: string; exists?: boolean }
  | { type: "DIRECTORY_EXISTS"; path: string; exists?: boolean }
  | ({ type: "FILE_CONTENT"; path: string } & Matcher)
  | { type: "FILE_PERMISSIONS"; path: string; mode: string }
  | { type: "FILE_OWNER"; path: string; user?: string; group?: string }
  | ({ type: "COMMAND_OUTPUT"; command: string; as?: "root" | "student" } & Matcher)
  /** Something the learner printed: matches the matcher, or (sameAs) equals what that command prints now. */
  | ({ type: "USER_OUTPUT"; sameAs?: string } & Matcher)
  | { type: "PROCESS_STATE"; match: string; running: boolean }
  | ({ type: "ENVIRONMENT_VARIABLE"; name: string } & Matcher)
  | { type: "CUSTOM_SCRIPT"; script: string }
);

export const CHECK_TYPES = [
  "FILE_EXISTS", "DIRECTORY_EXISTS", "FILE_CONTENT", "FILE_PERMISSIONS", "FILE_OWNER",
  "COMMAND_OUTPUT", "USER_OUTPUT", "PROCESS_STATE", "ENVIRONMENT_VARIABLE", "CUSTOM_SCRIPT",
] as const;

export interface CheckResult {
  label: string;
  pass: boolean;
  message?: string;
}

const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Returns why `text` fails the matcher, or undefined when it matches. */
export function mismatch(text: string, m: Matcher): string | undefined {
  if (m.equals !== undefined && text.trim() !== m.equals.trim()) return `expected "${m.equals}"`;
  const missing = list(m.contains).find((s) => !text.includes(s));
  if (missing !== undefined) return `"${missing}" is missing`;
  const extra = list(m.notContains).find((s) => text.includes(s));
  if (extra !== undefined) return `"${extra}" should not be there`;
  if (m.regex !== undefined && !new RegExp(m.regex, "m").test(text)) return "the content doesn't match the expected pattern";
  return undefined;
}
