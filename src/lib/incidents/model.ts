import type { HttpRoute } from "../linux/system.ts";
import { rng } from "../linux/system.ts";
import { splitStatements } from "../sql/split.ts";

/**
 * The hidden half of an incident: how the system behaves. After every change to the incident's
 * database a trusted `probe` query reads the system back as one row. Its `state` column picks one
 * of `states`, and its other columns fill that state's alerts, metrics, log lines and HTTP answers,
 * so the system answers whatever the learner does, right or wrong. Everything here is data from
 * the incident_scenarios table; this file only interprets it.
 */
export interface IncidentModel {
  /** The systemd unit whose HTTP answers come from the state's routes. */
  service: string;
  /** Log name → file on the server. */
  logs: Record<string, string>;
  /** Tables of the incident database, for friendly "does not exist" errors. */
  tables: string[];
  /** Trusted SQL run after every change to the database: one row, `state` names the state (incidents in the data). */
  probe?: string;
  /**
   * A read-only bash script run as root after every command or file save: it prints `key=value` lines,
   * `state=…` among them (incidents on the server). An unresolved machine state beats the data's state.
   */
  machineProbe?: string;
  /** Log lines written per story minute. */
  linesPerMinute: number;
  /** The story before the alert, oldest first: each phase writes log lines up to the next one (the last, up to the alert). */
  history: { from: string; state: string; once?: Record<string, string> }[];
  /** The state while the service is stopped, or when the probe itself fails (a dropped table, say). */
  down?: string;
  states: Record<string, IncidentState>;
}

export interface IncidentState {
  /** The incident can be closed only while the system is in a state marked resolved. */
  resolved?: boolean;
  /** A state the learner made worse than it was (data given away, secrets exposed, backups deleted): it costs the safe-fix points. */
  harmful?: boolean;
  /** How the timeline names the system entering this state. */
  label?: string;
  alerts: string[];
  metrics: { label: string; value: string; status?: MetricStatus }[];
  events: LogEvent[];
  routes: RouteTemplate[];
}

export type MetricStatus = "ok" | "warn" | "bad";

export interface LogEvent {
  /** Relative frequency: a number, or the name of a probe value. */
  weight: number | string;
  /** Values drawn once per event and shared by its lines: name → template. */
  vars?: Record<string, string>;
  /** Log name → line template (it may span several lines, like a stack trace). */
  lines: Record<string, string>;
}

export type RouteTemplate = Omit<HttpRoute, "any" | "log"> & {
  /** Name of a probe value holding a comma-separated list. */
  any?: string;
  /** Log name and line the service writes when it serves the route. */
  log?: { to: string; line: string };
};

export type Values = Record<string, string | number | null>;

/**
 * The system as last probed: the data's state (`state`, `values`), the machine's (`machine`), whether
 * the service runs. `initial` is the first probe, which the story before the alert is told with.
 */
export interface Health {
  state: string;
  values: Values;
  serviceUp: boolean;
  initial: Values;
  machine?: { state: string; values: Values };
}

export interface Question {
  question: string;
  options: { id: string; text: string }[];
  answer: string;
}

/** The questions that close an incident; the answers never leave the server before it is finished. */
export type Diagnosis = Question & { prevention?: Question };

/** How a run is scored, beyond what every incident shares. */
export interface Scoring {
  /** What a good investigation finds: an item counts once a command or query matches one of its patterns. */
  evidence: { label: string; any: string[] }[];
  /** Commands or queries that check the recovery, once the system has recovered. */
  verify: string[];
  /** Risky actions that are part of this incident's fix, so they cost nothing. */
  expected: string[];
}

/** One thing that happened, in story time: the postmortem's timeline is made of these. */
export interface IncidentEvent {
  at: number;
  kind: "start" | "command" | "file" | "sql" | "hint" | "diagnosis" | "state" | "resolved" | "gave-up";
  text: string;
  /** restart, dangerous, change, error, wrong, resolved, harmful */
  tags?: string[];
}

type Rand = ReturnType<typeof rng>;

/**
 * Fills a template: `{{name}}` from the event's own values or the probe's, and the generators
 * `{{int:10-99}}`, `{{hex:8}}`, `{{pick:name}}` (one item of a comma-separated value) and `{{one:a|b}}`.
 */
export function render(template: string, values: Values, rand: Rand, own: Record<string, string> = {}): string {
  return template.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (_, name: string, arg: string | undefined) => {
    if (arg === undefined) return name in own ? own[name] : String(values[name] ?? "");
    if (name === "int") {
      const [lo, hi] = arg.split("-").map(Number);
      return String(rand.int(lo, hi));
    }
    if (name === "hex") return Array.from({ length: Number(arg) }, () => rand.int(0, 15).toString(16)).join("");
    if (name === "pick") {
      const items = String(own[arg] ?? values[arg] ?? "").split(",").filter(Boolean);
      return items.length ? rand.pick(items) : "";
    }
    if (name === "one") return rand.pick(arg.split("|"));
    return "";
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-07 02:13:05.123", how the application logs (UTC, like the server). */
export const appTime = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 23);
/** "07/Oct/2026:02:13:05 +0000", nginx's access-log time. */
export const clfTime = (t: number) => {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${d.toISOString().slice(11, 19)} +0000`;
};

export interface LogPhase {
  state: string;
  from: number;
  to: number;
  values: Values;
  once?: Record<string, string>;
}

/** Log lines for stretches of story time: file → text to append. `cap` bounds the lines per phase. */
export function writeLogs(model: IncidentModel, phases: LogPhase[], seed: number, cap = 4000): Record<string, string> {
  const rand = rng(seed);
  const out: Record<string, string> = {};
  const add = (log: string, text: string) => {
    const file = model.logs[log];
    if (file) out[file] = `${out[file] ?? ""}${text}\n`;
  };
  const at = (t: number): Record<string, string> => ({
    ts: appTime(t),
    clf: clfTime(t),
    ngx: appTime(t).slice(0, 19).replace(/-/g, "/"),
    ip: `${rand.int(11, 223)}.${rand.int(0, 255)}.${rand.int(0, 255)}.${rand.int(1, 254)}`,
  });
  for (const p of phases) {
    const state = model.states[p.state];
    if (!state || p.to <= p.from) continue;
    if (p.once) for (const [log, line] of Object.entries(p.once)) add(log, render(line, p.values, rand, at(p.from)));
    const weights = state.events.map((e) => Math.max(0, Number(typeof e.weight === "number" ? e.weight : p.values[e.weight]) || 0));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!total) continue;
    const n = Math.min(cap, Math.round(((p.to - p.from) / 60_000) * model.linesPerMinute));
    const times = Array.from({ length: n }, () => p.from + rand.next() * (p.to - p.from)).sort((a, b) => a - b);
    for (const t of times) {
      let r = rand.next() * total;
      const event = state.events[weights.findIndex((w) => (r -= w) < 0)] ?? state.events.at(-1)!;
      const own = at(t);
      for (const [name, template] of Object.entries(event.vars ?? {})) own[name] = render(template, p.values, rand, own);
      for (const [log, line] of Object.entries(event.lines)) add(log, render(line, p.values, rand, own));
    }
  }
  return out;
}

/** The service's HTTP answers in a state, filled in (`{ts}`, `{match}` and `{1}` are filled per request on the server). */
export function routesFor(model: IncidentModel, state: string, values: Values, seed: number): HttpRoute[] {
  const rand = rng(seed);
  return (model.states[state]?.routes ?? []).map((r) => ({
    method: r.method,
    path: r.path,
    request: r.request,
    anyPattern: r.anyPattern,
    status: r.status,
    type: r.type,
    body: render(r.body, values, rand),
    ...(r.any !== undefined && { any: String(values[r.any] ?? "").split(",").filter(Boolean) }),
    ...(r.log && model.logs[r.log.to] && { log: { file: model.logs[r.log.to], line: render(r.log.line, values, rand, { ts: "{ts}" }) } }),
  }));
}

/**
 * The state the system is really in: a stopped service beats everything, then a machine that is
 * not right (a full disk, a failed unit), then whatever the data says.
 */
export function effectiveState(model: IncidentModel, h: Health): string {
  if (!h.serviceUp && model.down) return model.down;
  const known = (s?: string) => (s && model.states[s] ? s : undefined);
  const machine = known(h.machine?.state);
  if (machine && !model.states[machine].resolved) return machine;
  return known(model.probe ? h.state : undefined) ?? machine ?? model.down ?? h.state;
}

/** The values templates are filled with: the data's, then the machine's. */
export const valuesOf = (h: Health): Values => ({ ...h.values, ...h.machine?.values });

/** A machine probe's `key=value` lines; the last word wins. */
export function parseProbe(output: string): { state: string; values: Values } {
  const values: Values = {};
  for (const line of output.split("\n")) {
    const m = /^\s*([A-Za-z_]\w*)=(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].trim();
  }
  return { state: String(values.state ?? ""), values };
}

/** What the monitoring shows: the alerts firing and the metrics, filled from the probes. */
export function stateView(model: IncidentModel, h: Health) {
  const name = effectiveState(model, h);
  const state = model.states[name];
  const values = valuesOf(h);
  const rand = rng(1);
  return {
    name,
    resolved: !!state?.resolved,
    harmful: !!state?.harmful,
    label: render(state?.label ?? state?.alerts[0] ?? name, values, rand),
    alerts: (state?.alerts ?? []).map((a) => render(a, values, rand)),
    metrics: (state?.metrics ?? []).map((m) => ({ label: m.label, value: render(m.value, values, rand), status: m.status ?? ("ok" as MetricStatus) })),
  };
}

// ---- risky actions -------------------------------------------------------------------------------

export interface Risk {
  /** A restart is penalised as an unnecessary restart; anything else risky as a dangerous command. */
  kind: "restart" | "dangerous";
  reason: string;
}

const RISKY: [RegExp, Risk][] = [
  [/\b(systemctl|service)\b[^;|&]*\b(restart|stop|reload|kill|disable|mask)\b/, { kind: "restart", reason: "It stops or restarts a service that live users depend on." }],
  [/\b(reboot|shutdown|halt|poweroff)\b|\binit\s+[06]\b/, { kind: "restart", reason: "It restarts or stops the whole server." }],
  [/\bnginx\s+-s\s+(stop|quit|reload|reopen)\b/, { kind: "restart", reason: "It stops or reloads nginx, which every request goes through." }],
  [/\b(kill|pkill|killall)\b/, { kind: "dangerous", reason: "It kills a process." }],
  [/\brm\b/, { kind: "dangerous", reason: "It deletes files, and there is no undo." }],
  [/\b(chmod|chown|chgrp)\b/, { kind: "dangerous", reason: "It changes who can read, write or run files." }],
  [/\b(truncate|dd|mkfs\S*|wipefs|shred)\b/, { kind: "dangerous", reason: "It overwrites data on disk." }],
  [/\b(mv|ln)\b/, { kind: "dangerous", reason: "It moves or relinks files the service may be using." }],
  [/(^|[^>&\d])>(?!>|&)\s*(?!\/dev\/null\b)[^\s|;&]/, { kind: "dangerous", reason: "It overwrites a file." }],
  [/\bcrontab\s+-r\b|\b(userdel|passwd|usermod|iptables|ufw)\b/, { kind: "dangerous", reason: "It changes accounts, scheduled jobs or the firewall." }],
];

/** Whether a command is a production action worth a second thought, and why. */
export function riskOf(line: string): Risk | undefined {
  return RISKY.find(([pattern]) => pattern.test(line))?.[1];
}

/** Whether SQL can destroy production data at a stroke, and why. */
export function sqlRiskOf(sql: string): Risk | undefined {
  for (const { text } of splitStatements(sql)) {
    const s = text.trim();
    if (/^(DROP|TRUNCATE)\b/i.test(s)) return { kind: "dangerous", reason: "It removes a table or all of its rows." };
    if (/^ALTER\b[\s\S]*\bDROP\b/i.test(s)) return { kind: "dangerous", reason: "It drops part of a table." };
    if (/^(DELETE|UPDATE)\b/i.test(s) && !/\bWHERE\b/i.test(s)) return { kind: "dangerous", reason: "It changes every row of the table: there is no WHERE." };
  }
  return undefined;
}

// ---- scoring -------------------------------------------------------------------------------------

export interface ScoreDetail {
  total: number;
  parts: { label: string; points: number; max: number; note: string }[];
  penalties: { label: string; points: number; note: string }[];
}

const matches = (patterns: string[], text: string) => patterns.some((p) => new RegExp(p, "i").test(text));
const actions = (events: IncidentEvent[]) => events.filter((e) => e.kind === "command" || e.kind === "sql" || e.kind === "file");

/**
 * The spec's score: investigation 30, root cause 25, safe fix 20, verification 15, prevention 10;
 * minus 5 per wrong conclusion and per hint, 10 per unnecessary restart and per dangerous action
 * (two of each at most) and 20 for giving up. Read entirely from the run's events.
 */
export function scoreRun(
  events: IncidentEvent[],
  scoring: Partial<Scoring>,
  o: { outcome: "resolved" | "gave-up"; wrongDiagnoses: number; hints: number; preventionRight: boolean },
): ScoreDetail {
  const done = actions(events);
  const evidence = (scoring.evidence ?? []).map((e) => ({ label: e.label, found: done.some((a) => matches(e.any, a.text)) }));
  const found = evidence.filter((e) => e.found).length;
  const resolved = o.outcome === "resolved";
  // verified: checked after the system last recovered
  const recoveredAt = [...events].reverse().find((e) => e.kind === "state" && e.tags?.includes("resolved"))?.at;
  const verified = resolved && recoveredAt !== undefined && done.some((a) => a.at >= recoveredAt && matches(scoring.verify ?? [".*"], a.text));
  const harmful = events.some((e) => e.kind === "state" && e.tags?.includes("harmful"));
  const unexpected = (tag: string) => done.filter((a) => a.tags?.includes(tag) && !matches(scoring.expected ?? [], a.text)).length;
  const restarts = Math.min(2, unexpected("restart"));
  const dangerous = Math.min(2, unexpected("dangerous"));

  const parts = [
    {
      label: "Investigation",
      max: 30,
      points: evidence.length ? Math.round((30 * found) / evidence.length) : 30,
      note: evidence.length ? `${found} of ${evidence.length} key pieces of evidence: ${evidence.map((e) => `${e.found ? "✓" : "✗"} ${e.label}`).join("; ")}` : "",
    },
    { label: "Root cause", max: 25, points: resolved ? 25 : 0, note: resolved ? "Named correctly." : "Not named." },
    { label: "Safe fix", max: 20, points: resolved ? (harmful ? 10 : 20) : 0, note: !resolved ? "Not fixed." : harmful ? "Fixed, but on the way the system got worse than it was." : "Fixed without making anything worse." },
    { label: "Verification", max: 15, points: verified ? 15 : 0, note: verified ? "Checked the recovery before closing." : "No check of the recovery before closing." },
    { label: "Prevention", max: 10, points: resolved && o.preventionRight ? 10 : 0, note: resolved && o.preventionRight ? "Chose the change that stops it happening again." : "Missed what stops it happening again." },
  ];
  const penalties = [
    { label: "Wrong conclusions", points: -5 * o.wrongDiagnoses, note: `${o.wrongDiagnoses} wrong root cause or premature close` },
    { label: "Unnecessary restarts", points: -10 * restarts, note: `${restarts} restart${restarts === 1 ? "" : "s"} the fix did not need` },
    { label: "Dangerous actions", points: -10 * dangerous, note: `${dangerous} risky action${dangerous === 1 ? "" : "s"} the fix did not need` },
    { label: "Hints", points: -5 * o.hints, note: `${o.hints} hint${o.hints === 1 ? "" : "s"}` },
    { label: "Gave up", points: o.outcome === "gave-up" ? -20 : 0, note: "Asked for the answer" },
  ].filter((p) => p.points < 0);
  const total = Math.max(0, Math.min(100, parts.reduce((n, p) => n + p.points, 0) + penalties.reduce((n, p) => n + p.points, 0)));
  return { total, parts, penalties };
}

/** Whether learner SQL can change the data (so it has to be replayed): anything but reads and transaction control. */
export function changesData(sql: string): boolean {
  return splitStatements(sql).some(({ text }) => {
    const s = text.trim();
    if (/^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SHOW|TABLE|VALUES)\b/i.test(s)) return false;
    if (/^SELECT\b/i.test(s)) return /\bINTO\b/i.test(s);
    if (/^(EXPLAIN|WITH)\b/i.test(s)) return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(s) && (!/^EXPLAIN\b/i.test(s) || /\bANALY[SZ]E\b/i.test(s));
    return true;
  });
}
