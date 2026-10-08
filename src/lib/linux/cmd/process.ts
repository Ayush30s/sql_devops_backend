import type { Machine } from "../machine.ts";
import type { Proc } from "../system.ts";
import { SHELL_PID, cpuTime, journal, spawn, startUnit, stopUnit } from "../system.ts";
import { loadAverage, memory, uptimeText } from "./system.ts";
import { command, fail, ok, quoteArgs } from "./util.ts";

const SIGNALS: Record<string, number> = { HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10, SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, CHLD: 17, CONT: 18, STOP: 19, TSTP: 20 };
const SIGNAL_NAMES = Object.fromEntries(Object.entries(SIGNALS).map(([k, v]) => [v, k]));

export function parseSignal(spec: string): number | undefined {
  const s = spec.replace(/^-/, "").toUpperCase().replace(/^SIG/, "");
  if (/^\d+$/.test(s)) return SIGNAL_NAMES[Number(s)] ? Number(s) : undefined;
  return SIGNALS[s];
}

export function comm(p: Proc) {
  const first = p.cmd.replace(/^-/, "").split(/[\s:]/)[0].replace(/^\[|\]$/g, "");
  return first.split("/").pop() || first;
}

function startColumn(t: number) {
  const d = new Date(t);
  if (Date.now() - t < 86400_000) return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function longTime(p: Proc) {
  const secs = Math.floor(((Date.now() - p.start) / 1000) * (p.cpu / 100));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
}

function elapsed(p: Proc) {
  const s = Math.floor((Date.now() - p.start) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = Math.floor(s / 86400);
  return `${d ? `${d}-` : ""}${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`.replace(/^00:/, "");
}

type Field = [header: string, get: (p: Proc) => string, right: boolean];

function fields(uids: Map<string, number>): Record<string, Field> {
  const num = (h: string, get: (p: Proc) => string): Field => [h, get, true];
  const txt = (h: string, get: (p: Proc) => string): Field => [h, get, false];
  return {
    pid: num("PID", (p) => String(p.pid)), ppid: num("PPID", (p) => String(p.ppid)),
    user: txt("USER", (p) => (p.user.length > 8 ? `${p.user.slice(0, 7)}+` : p.user)), uid: num("UID", (p) => String(uids.get(p.user) ?? 0)),
    "%cpu": num("%CPU", (p) => p.cpu.toFixed(1)), pcpu: num("%CPU", (p) => p.cpu.toFixed(1)),
    "%mem": num("%MEM", (p) => p.mem.toFixed(1)), pmem: num("%MEM", (p) => p.mem.toFixed(1)),
    rss: num("RSS", (p) => String(p.rss)), rssize: num("RSS", (p) => String(p.rss)), vsz: num("VSZ", (p) => String(p.vsz)),
    stat: txt("STAT", (p) => p.stat), state: txt("S", (p) => p.stat[0]),
    tty: txt("TT", (p) => p.tty), tt: txt("TT", (p) => p.tty),
    start: txt("START", (p) => startColumn(p.start)), start_time: txt("START", (p) => startColumn(p.start)), stime: txt("STIME", (p) => startColumn(p.start)),
    time: num("TIME", longTime), cputime: num("TIME", longTime), etime: num("ELAPSED", elapsed), etimes: num("ELAPSED", (p) => String(Math.floor((Date.now() - p.start) / 1000))),
    ni: num("NI", () => "0"), pri: num("PRI", () => "19"),
    cmd: txt("CMD", (p) => p.cmd), args: txt("COMMAND", (p) => p.cmd), command: txt("COMMAND", (p) => p.cmd),
    comm: txt("COMMAND", comm), ucmd: txt("CMD", comm), ucomm: txt("COMMAND", comm),
  };
}

const SORT_KEYS: Record<string, (p: Proc) => number | string> = {
  "%cpu": (p) => p.cpu, pcpu: (p) => p.cpu, "%mem": (p) => p.mem, pmem: (p) => p.mem, rss: (p) => p.rss, vsz: (p) => p.vsz,
  pid: (p) => p.pid, ppid: (p) => p.ppid, start_time: (p) => p.start, time: (p) => p.cpu * (Date.now() - p.start), user: (p) => p.user, comm, cmd: (p) => p.cmd,
};

function render(rows: Proc[], cols: { field: Field; header: string }[], headers: boolean) {
  const cells = rows.map((p) => cols.map((c) => c.field[1](p)));
  const widths = cols.map((c, i) => Math.max(headers ? c.header.length : 0, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) =>
    r.map((v, i) => (i === r.length - 1 ? v : cols[i].field[2] ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join(" ").trimEnd();
  return [...(headers && cols.some((c) => c.header) ? [line(cols.map((c) => c.header))] : []), ...cells.map(line)].join("\n") + "\n";
}

export function processCommands(m: Machine) {
  const state = () => m.state;

  async function uidMap() {
    const passwd = (await m.fs.inner.readFile("/etc/passwd").catch(() => "")).split("\n");
    return new Map(passwd.filter(Boolean).map((l) => [l.split(":")[0], Number(l.split(":")[2])]));
  }

  /** Delivers a signal with Linux semantics; returns an error line or undefined. */
  async function deliver(p: Proc, sig: number, notes: string[]): Promise<string | undefined> {
    const s = state();
    if (m.user.uid !== 0 && p.user !== m.user.user) return `(${p.pid}) - Operation not permitted`;
    if (p.pid <= 2 || p.ppid === 2 || p.pid === SHELL_PID || p.pid === 1820 || p.pid === 1902) return undefined;
    if (sig === 19 || sig === 20) {
      p.stat = "T";
      return undefined;
    }
    if (sig === 18) {
      p.stat = p.stat.replace("T", "S");
      return undefined;
    }
    const unit = p.unit ? s.units[p.unit] : undefined;
    const isMain = !!unit && unit.mainPid === p.pid;
    if (sig === 1 && isMain) {
      journal(s, p.unit!, "systemd", 1, `Reloading ${p.unit}.service - ${unit!.description}...`);
      journal(s, p.unit!, "systemd", 1, `Reloaded ${p.unit}.service - ${unit!.description}.`);
      return undefined;
    }
    if (sig === 10 || sig === 12 || sig === 17) return undefined;
    if (p.stubborn && sig !== 9) return undefined;
    s.procs = s.procs.filter((x) => x !== p && !(isMain && x.ppid === p.pid));
    if (isMain) {
      if (sig === 9 && p.unit === "webapp") {
        stopUnit(s, p.unit, "killed");
        journal(s, "webapp", "systemd", 1, "webapp.service: Scheduled restart job, restart counter is at 1.");
        await startUnit(s, m.fs, "webapp");
      } else stopUnit(s, p.unit!, sig === 9 ? "killed" : "stop");
    } else if (unit?.workers && p.cmd === unit.workers.cmd && unit.active)
      spawn(s, { ppid: unit.mainPid!, user: unit.workers.user, cmd: unit.workers.cmd, cpu: 0, mem: 0.3, rss: 5800, unit: p.unit });
    if (p.job) {
      const job = s.jobs.find((j) => j.id === p.job);
      if (job) {
        notes.push(`[${job.id}]+  ${sig === 9 ? "Killed" : "Terminated"}              ${job.cmd.replace(/ &$/, "")}`);
        s.jobs = s.jobs.filter((j) => j !== job);
      }
    }
    return undefined;
  }

  const ps = command("ps", async (args) => {
    let all = false;
    let bsdUser = false;
    let full = false;
    let format: string[] | undefined;
    let sort: string | undefined;
    let users: string[] = [];
    let pids: number[] = [];
    let names: string[] = [];
    let headers = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("--")) {
        const [k, v] = a.slice(2).split("=");
        const val = () => v ?? args[++i] ?? "";
        if (k === "sort") sort = val();
        else if (k === "no-headers" || k === "no-heading") headers = false;
        else if (k === "user" || k === "User") users = val().split(",");
        else if (k === "pid") pids = val().split(",").map(Number);
        else if (k === "format") format = val().split(",");
        continue;
      }
      if (/^-?a?ux?f?$/.test(a) && /[ux]/.test(a) && !/^-u$/.test(a)) {
        all = all || a.includes("a") || a.includes("x");
        bsdUser = bsdUser || a.replace(/^-/, "").includes("u");
        continue;
      }
      if (a.startsWith("-")) {
        const opts = a.slice(1);
        for (let j = 0; j < opts.length; j++) {
          const c = opts[j];
          const rest = () => opts.slice(j + 1) || args[++i] || "";
          if (c === "e" || c === "A" || c === "a" || c === "x") all = true;
          else if (c === "f" || c === "F") full = true;
          else if (c === "u" || c === "U") {
            users = rest().split(",");
            break;
          } else if (c === "p") {
            pids = rest().split(",").map(Number);
            break;
          } else if (c === "C") {
            names = rest().split(",");
            break;
          } else if (c === "o") {
            format = [...(format ?? []), ...rest().split(",")];
            break;
          }
        }
        continue;
      }
      for (const c of a) {
        if (c === "a" || c === "x" || c === "e") all = true;
        if (c === "u") bsdUser = true;
      }
    }
    const self = spawn(state(), { ppid: SHELL_PID, user: m.user.user, cmd: `ps ${args.join(" ")}`.trim(), cpu: 0, mem: 0.1, rss: 4100, vsz: 11700, tty: "pts/0", stat: "R+" });
    state().procs = state().procs.filter((p) => p !== self);
    let rows = [...state().procs, self];
    if (pids.length) rows = rows.filter((p) => pids.includes(p.pid));
    else if (users.length) rows = rows.filter((p) => users.includes(p.user));
    else if (names.length) rows = rows.filter((p) => names.includes(comm(p)));
    else if (!all) rows = rows.filter((p) => p.tty === "pts/0" && p.user === m.user.user);
    if (sort) {
      for (const key of sort.split(",").reverse()) {
        const desc = key.startsWith("-");
        const get = SORT_KEYS[key.replace(/^[+-]/, "")];
        if (!get) return fail(`error: unknown sort specifier\n\nUsage:\n ps [options]`);
        rows.sort((a, b) => {
          const x = get(a);
          const y = get(b);
          return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
        });
      }
    } else rows.sort((a, b) => a.pid - b.pid);
    const F = fields(await uidMap());
    const pick = (names: string[], overrides: Record<string, string> = {}) =>
      names.map((n) => {
        const [key, custom] = n.split("=");
        const field = F[key.toLowerCase()];
        if (!field) throw new Error(key);
        return { field, header: custom !== undefined ? custom : (overrides[key] ?? field[0]) };
      });
    let cols;
    try {
      cols = format
        ? pick(format)
        : bsdUser
          ? pick(["user", "pid", "%cpu", "%mem", "vsz", "rss", "tty", "stat", "start", "time", "command"], { time: "TIME", tty: "TTY" })
          : full
            ? pick(["user", "pid", "ppid", "ni", "stime", "tty", "time", "cmd"], { user: "UID", ni: "C", tty: "TTY" })
            : pick(["pid", "tty", "time", "ucmd"], { tty: "TTY" });
    } catch (e) {
      return fail(`error: unknown user-defined format specifier "${(e as Error).message}"\n\nUsage:\n ps [options]`);
    }
    if (bsdUser) cols[9] = { field: ["TIME", cpuTime, true], header: "TIME" };
    return ok(render(rows, cols, headers));
  });

  async function topText(args: string[]) {
    let sortKey = "%CPU";
    let user: string | undefined;
    let pid: number | undefined;
    let fullCmd = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-o") sortKey = (args[++i] ?? "").replace(/^[+-]/, "").toUpperCase();
      else if (a.startsWith("-o")) sortKey = a.slice(2).replace(/^[+-]/, "").toUpperCase();
      else if (a === "-u" || a === "-U") user = args[++i];
      else if (a === "-p") pid = Number(args[++i]);
      else if (a === "-c") fullCmd = true;
      else if (a === "-n" || a === "-d") i++;
    }
    const s = state();
    const now = Date.now();
    const mem = memory(m);
    let rows = [...s.procs];
    if (user) rows = rows.filter((p) => p.user === user);
    if (pid) rows = rows.filter((p) => p.pid === pid);
    const key = sortKey === "%MEM" || sortKey === "RES" || sortKey === "MEM" ? (p: Proc) => p.mem : sortKey === "PID" ? (p: Proc) => -p.pid : sortKey === "TIME+" || sortKey === "TIME" ? (p: Proc) => p.cpu * (now - p.start) : (p: Proc) => p.cpu;
    rows.sort((a, b) => key(b) - key(a) || a.pid - b.pid);
    const busy = s.procs.reduce((t, p) => t + p.cpu, 0);
    const us = Math.min(100, busy / 2).toFixed(1);
    const idle = Math.max(0, 100 - Number(us) - 0.5).toFixed(1);
    const running = s.procs.filter((p) => p.cpu > 50).length + 1;
    const stopped = s.procs.filter((p) => p.stat.startsWith("T")).length;
    const mib = (kb: number) => (kb / 1024).toFixed(1).padStart(8);
    const time = (p: Proc) => {
      const cs = Math.floor(((now - p.start) / 10) * (p.cpu / 100));
      return `${Math.floor(cs / 6000)}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
    };
    const header =
      `top - ${new Date(now).toISOString().slice(11, 19)} up ${uptimeText(m, now)},  1 user,  load average: ${loadAverage(m).join(", ")}\n` +
      `Tasks: ${String(s.procs.length + 1).padStart(3)} total, ${String(running).padStart(3)} running, ${String(s.procs.length + 1 - running - stopped).padStart(3)} sleeping, ${String(stopped).padStart(3)} stopped,   0 zombie\n` +
      `%Cpu(s): ${us.padStart(4)} us,  0.3 sy,  0.0 ni, ${idle.padStart(4)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.2 st\n` +
      `MiB Mem : ${mib(mem.total)} total, ${mib(mem.free)} free, ${mib(mem.used)} used, ${mib(mem.cache)} buff/cache\n` +
      `MiB Swap:      0.0 total,      0.0 free,      0.0 used. ${mib(mem.available)} avail Mem\n\n` +
      `    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n`;
    const lines = rows.slice(0, 30).map(
      (p) =>
        `${String(p.pid).padStart(7)} ${p.user.slice(0, 8).padEnd(8)}  20   0 ${String(p.vsz).padStart(7)} ${String(p.rss).padStart(6)} ${String(Math.round(p.rss * 0.4)).padStart(6)} ${(p.cpu > 50 ? "R" : p.stat[0]).padEnd(1)} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(5)} ${time(p).padStart(9)} ${fullCmd ? p.cmd : comm(p)}`,
    );
    return header + lines.join("\n") + "\n";
  }

  const top = command("top", async (args) => {
    const batch = args.some((a) => a === "-b" || /^-\w*b/.test(a));
    return ok(await topText(args), batch ? "" : "(top refreshes until you press q in a real terminal; this lab prints one snapshot. Try: top -b -n 1)\n");
  });

  const htop = command("htop", async () => ok(await topText([]), "htop needs a full-screen terminal, so this lab shows a top snapshot instead.\n"));

  const kill = command("kill", async (args) => {
    if (args[0] === "-l" || args[0] === "-L" || args[0] === "--list") {
      if (args[1]) return ok(`${SIGNAL_NAMES[Number(args[1])] ?? ""}\n`);
      const list = Object.entries(SIGNALS).map(([n, v]) => `${String(v).padStart(2)}) SIG${n}`);
      let out = "";
      for (let i = 0; i < list.length; i += 5) out += `${list.slice(i, i + 5).map((x) => x.padEnd(12)).join("").trimEnd()}\n`;
      return ok(out);
    }
    let sig = 15;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-s" || a === "-n") {
        const v = parseSignal(args[++i] ?? "");
        if (v === undefined) return fail(`bash: kill: ${args[i]}: invalid signal specification`);
        sig = v;
      } else if (a.startsWith("-") && a !== "-") {
        const v = parseSignal(a);
        if (v === undefined) return fail(`bash: kill: ${a.slice(1)}: invalid signal specification`);
        sig = v;
      } else targets.push(a);
    }
    if (!targets.length) return fail("kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]", 2);
    const notes: string[] = [];
    let err = "";
    for (const t of targets) {
      let pid: number;
      if (t.startsWith("%")) {
        const job = t === "%%" || t === "%+" ? state().jobs.at(-1) : state().jobs.find((j) => j.id === Number(t.slice(1)));
        if (!job) {
          err += `bash: kill: ${t}: no such job\n`;
          continue;
        }
        pid = job.pid;
      } else if (/^\d+$/.test(t)) pid = Number(t);
      else {
        err += `bash: kill: ${t}: arguments must be process or job IDs\n`;
        continue;
      }
      const p = state().procs.find((x) => x.pid === pid);
      if (!p) {
        err += `bash: kill: (${pid}) - No such process\n`;
        continue;
      }
      const e = await deliver(p, sig, notes);
      if (e) err += `bash: kill: ${e}\n`;
    }
    return ok(notes.map((n) => `${n}\n`).join(""), err, err ? 1 : 0);
  });

  function matcher(args: string[]) {
    let full = false;
    let exact = false;
    let user: string | undefined;
    let sig = 15;
    let listName = false;
    let listFull = false;
    let newest = false;
    let oldest = false;
    let count = false;
    let pattern: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-f" || a === "--full") full = true;
      else if (a === "-x" || a === "--exact") exact = true;
      else if (a === "-u" || a === "-U") user = args[++i];
      else if (a === "-l" || a === "--list-name") listName = true;
      else if (a === "-a" || a === "--list-full") listFull = true;
      else if (a === "-n" || a === "--newest") newest = true;
      else if (a === "-o" || a === "--oldest") oldest = true;
      else if (a === "-c" || a === "--count") count = true;
      else if (a === "--signal") sig = parseSignal(args[++i] ?? "") ?? sig;
      else if (/^-[a-z]+$/.test(a) && a.length > 2 && !parseSignal(a)) {
        for (const c of a.slice(1)) {
          if (c === "f") full = true;
          if (c === "x") exact = true;
          if (c === "l") listName = true;
          if (c === "a") listFull = true;
        }
      } else if (a.startsWith("-") && parseSignal(a) !== undefined) sig = parseSignal(a)!;
      else pattern = a;
    }
    if (pattern === undefined) return undefined;
    let re: RegExp;
    try {
      re = new RegExp(exact ? `^(?:${pattern})$` : pattern);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    let hits = state().procs.filter((p) => re.test(full ? p.cmd : comm(p)) && (!user || p.user === user) && p.pid > 2 && p.ppid !== 2);
    if (newest) hits = hits.slice(-1);
    if (oldest) hits = hits.slice(0, 1);
    return { hits, sig, listName, listFull, count };
  }

  const pgrep = command("pgrep", async (args) => {
    const r = matcher(args);
    if (!r) return fail("pgrep: no matching criteria specified\nTry `pgrep --help' for more information.", 2);
    if (r.count) return ok(`${r.hits.length}\n`, "", r.hits.length ? 0 : 1);
    const out = r.hits.map((p) => (r.listFull ? `${p.pid} ${p.cmd}` : r.listName ? `${p.pid} ${comm(p)}` : String(p.pid))).join("\n");
    return ok(out ? `${out}\n` : "", "", r.hits.length ? 0 : 1);
  });

  const pkill = command("pkill", async (args) => {
    const r = matcher(args);
    if (!r) return fail("pkill: no matching criteria specified\nTry `pkill --help' for more information.", 2);
    const notes: string[] = [];
    let err = "";
    for (const p of r.hits) {
      const e = await deliver(p, r.sig, notes);
      if (e) err += `pkill: killing pid ${p.pid} failed: Operation not permitted\n`;
    }
    return ok(notes.map((n) => `${n}\n`).join(""), err, r.hits.length ? 0 : 1);
  });

  const killall = command("killall", async (args) => {
    const sigArg = args.find((a) => a.startsWith("-") && parseSignal(a) !== undefined);
    const sig = sigArg ? parseSignal(sigArg)! : 15;
    const names = args.filter((a) => !a.startsWith("-"));
    if (!names.length) return fail("Usage: killall [OPTION]... [--] NAME...");
    const notes: string[] = [];
    let err = "";
    for (const name of names) {
      const hits = state().procs.filter((p) => comm(p) === name);
      if (!hits.length) err += `${name}: no process found\n`;
      for (const p of hits) {
        const e = await deliver(p, sig, notes);
        if (e) err += `${name}(${p.pid}): Operation not permitted\n`;
      }
    }
    return ok(notes.map((n) => `${n}\n`).join(""), err, err ? 1 : 0);
  });

  const pickJob = (spec?: string) => {
    const jobs = state().jobs;
    if (!spec || spec === "%%" || spec === "%+") return jobs.at(-1);
    return jobs.find((j) => j.id === Number(spec.replace(/^%/, "")));
  };

  const jobs = command("jobs", async (args) => {
    const list = state().jobs;
    const long = args.includes("-l");
    return ok(
      list
        .map((j, i) => {
          const p = state().procs.find((x) => x.pid === j.pid);
          const mark = i === list.length - 1 ? "+" : i === list.length - 2 ? "-" : " ";
          const status = p?.stat.startsWith("T") ? "Stopped" : "Running";
          return `[${j.id}]${mark}  ${long ? `${j.pid} ` : ""}${status.padEnd(24)}${j.cmd}\n`;
        })
        .join(""),
    );
  });

  const fg = command("fg", async (args) => {
    const job = pickJob(args[0]);
    if (!job) return fail(`bash: fg: ${args[0] ?? "current"}: no such job`);
    const p = state().procs.find((x) => x.pid === job.pid);
    state().procs = state().procs.filter((x) => x.pid !== job.pid);
    state().jobs = state().jobs.filter((j) => j !== job);
    const cmd = job.cmd.replace(/ &$/, "");
    if (p?.endsAt && p.endsAt - Date.now() < 3000) {
      await new Promise((r) => setTimeout(r, Math.max(0, p.endsAt! - Date.now())));
      return ok(`${cmd}\n`);
    }
    return ok(`${cmd}\n^C\n`, "(fg waits for the job to finish. This lab can't block the terminal, so the job was stopped as if you pressed Ctrl+C.)\n", 130);
  });

  const bg = command("bg", async (args) => {
    const job = pickJob(args[0]);
    if (!job) return fail(`bash: bg: ${args[0] ?? "current"}: no such job`);
    const p = state().procs.find((x) => x.pid === job.pid);
    if (p) p.stat = p.stat.replace("T", "S");
    return ok(`[${job.id}]+ ${job.cmd}\n`);
  });

  const disown = command("disown", async (args) => {
    const job = pickJob(args[0]);
    if (!job) return fail(`bash: disown: ${args[0] ?? "current"}: no such job`);
    state().jobs = state().jobs.filter((j) => j !== job);
    const p = state().procs.find((x) => x.pid === job.pid);
    if (p) p.job = undefined;
    return ok();
  });

  const nohup = command("nohup", async (args, ctx) => {
    if (!args.length) return fail("nohup: missing operand\nTry 'nohup --help' for more information.", 125);
    const r = await ctx.exec!(quoteArgs(args), { cwd: ctx.cwd });
    try {
      await m.fs.appendFile(`${ctx.cwd === "/" ? "" : ctx.cwd}/nohup.out`, r.stdout + r.stderr);
    } catch {
      return fail("nohup: failed to open 'nohup.out': Permission denied", 125);
    }
    return ok("", "nohup: ignoring input and appending output to 'nohup.out'\n", r.exitCode);
  });

  return [ps, top, htop, kill, pgrep, pkill, killall, jobs, fg, bg, disown, nohup];
}
