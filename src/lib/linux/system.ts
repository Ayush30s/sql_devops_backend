import type { FsSnapshot, Identity, LabFs } from "./fs.ts";

/** State of one simulated EC2-style Ubuntu machine. Everything here is plain JSON. */

export interface Proc {
  pid: number;
  ppid: number;
  user: string;
  cmd: string;
  cpu: number;
  mem: number;
  rss: number;
  vsz: number;
  stat: string;
  start: number;
  tty: string;
  ports?: number[];
  unit?: string;
  stubborn?: boolean;
  endsAt?: number;
  job?: number;
  cwd?: string;
}

export type UnitCheck =
  | { type: "nginx-config" }
  | { type: "file-readable"; path: string }
  | { type: "file-exists"; path: string }
  | { type: "port-free" }
  | { type: "disk-space" }
  | { type: "exec"; path: string };

export interface Unit {
  description: string;
  user: string;
  exec: string;
  workers?: { user: string; cmd: string; count: number };
  ports: number[];
  enabled: boolean;
  active: boolean;
  failed: boolean;
  since: number;
  mainPid?: number;
  checks: UnitCheck[];
  unitFile: string;
  mem: number;
  cpu: number;
}

export interface JournalEntry {
  t: number;
  unit: string;
  ident: string;
  pid: number;
  pri: number;
  msg: string;
}

export interface Device {
  name: string;
  size: number;
  type: "disk" | "part";
  parent?: string;
  fstype?: string;
  uuid?: string;
  label?: string;
  mountpoint?: string;
}

export interface Job {
  id: number;
  pid: number;
  cmd: string;
}

export interface S3Object {
  size: number;
  mtime: number;
  body?: string;
}

export interface AwsState {
  account: string;
  role: string;
  s3: Record<string, { created: number; region: string; denied?: boolean; objects: Record<string, S3Object> }>;
  instances: Record<string, unknown>[];
  logGroups: Record<string, { stream: string; t: number; msg: string }[]>;
  iam: {
    users: { UserName: string; created: number; policies: string[]; groups: string[] }[];
    roles: { RoleName: string; created: number; policies: string[]; trust: string }[];
  };
}

export interface LabState {
  v: 1;
  fs: FsSnapshot;
  env: Record<string, string>;
  procs: Proc[];
  nextPid: number;
  jobs: Job[];
  nextJob: number;
  units: Record<string, Unit>;
  journal: JournalEntry[];
  devices: Device[];
  history: string[];
  bootTime: number;
  locateDb: string[];
  /** Exit status of the previous terminal line, so `$?` works across lines. */
  lastExit?: number;
  /** Text files copied to other servers with scp/rsync: host name → absolute path → content. */
  remote?: Record<string, Record<string, string>>;
  aws: AwsState;
  /** How a service answers HTTP, by unit; an incident sets these from the live state of its data. */
  http?: Record<string, HttpRoute[]>;
}

/** One answer of a simulated service: the first route whose method, path and `any` match wins. */
export interface HttpRoute {
  method?: string;
  /** Regular expression for the path the service receives. */
  path: string;
  /** Applies only when the request path or body names one of these values (as a whole word). */
  any?: string[];
  /** How a value of `any` must appear instead, `{v}` standing for it: `"product_id"\\s*:\\s*{v}\\b`. */
  anyPattern?: string;
  /** Applies only when the request body matches this regular expression. */
  request?: string;
  status: number;
  /** `{match}` becomes the value `any` matched, `{1}`… the path's capture groups. */
  body: string;
  type?: string;
  /** What the service logs for the request; `{ts}` becomes the time it was served. */
  log?: { file: string; line: string };
}

export const HOSTNAME = "ip-10-0-1-23";
export const LOGIN = "student";
export const SHELL_PID = 1903;
export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
export const ROOT_FS_SIZE = 8 * GiB;
export const ROOT_FS_BASE_USED = 2.31 * GiB;
/** Usable size of / as df reports it (ext4 metadata and reserved blocks take ~5%). */
export const ROOT_CAPACITY = ROOT_FS_SIZE * 0.95;
export const MEM_TOTAL_KB = 1_956_000;

/** The bash prompt for a machine's persisted environment. */
export function promptOf(env: Record<string, string>) {
  const home = env.HOME ?? "/home/student";
  const cwd = env.PWD ?? home;
  const short = cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  return `${LOGIN}@${HOSTNAME}:${short}$ `;
}

// ---- small utilities ------------------------------------------------------------------------

/** Deterministic PRNG so generated logs are identical for every learner. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "Oct 02 09:12:01" (syslog/journal style, UTC). */
export function syslogTime(t: number) {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function hhmm(t: number) {
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function isoTime(t: number) {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Human-readable sizes like `ls -h` / `df -h`: 4.0K, 1.2M, 7.6G. */
export function human(bytes: number) {
  const units = ["", "K", "M", "G", "T"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  if (i === 0) return String(Math.round(n));
  return n < 10 ? `${(Math.ceil(n * 10) / 10).toFixed(1)}${units[i]}` : `${Math.ceil(n)}${units[i]}`;
}

/** Parses sizes such as 120M, 2G, 512k, 1024. */
export function parseSize(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kKmMgGtT])?(i?[bB])?$/.exec(text.trim());
  if (!m) return undefined;
  const mult = { k: 1024, m: MiB, g: GiB, t: 1024 * GiB }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

export function shellQuote(s: string) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function normalizePath(cwd: string, p: string) {
  const parts: string[] = [];
  for (const part of (p.startsWith("/") ? p : `${cwd}/${p}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Reads a file ignoring permissions (system code, not learner code). */
export async function readAsRoot(fs: LabFs, path: string) {
  try {
    return await fs.inner.readFile(path);
  } catch {
    return undefined;
  }
}

// ---- users and groups -----------------------------------------------------------------------

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
}

export async function readPasswd(fs: LabFs): Promise<PasswdEntry[]> {
  return ((await readAsRoot(fs, "/etc/passwd")) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, , uid, gid, gecos, home, shell] = line.split(":");
      return { name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
    });
}

export async function readGroups(fs: LabFs): Promise<GroupEntry[]> {
  return ((await readAsRoot(fs, "/etc/group")) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, , gid, members] = line.split(":");
      return { name, gid: Number(gid), members: members ? members.split(",") : [] };
    });
}

export async function identityOf(fs: LabFs, user: string): Promise<Identity | undefined> {
  const pw = (await readPasswd(fs)).find((p) => p.name === user);
  if (!pw) return undefined;
  const groups = await readGroups(fs);
  const primary = groups.find((g) => g.gid === pw.gid)?.name ?? String(pw.gid);
  return {
    user,
    uid: pw.uid,
    group: primary,
    groups: [primary, ...groups.filter((g) => g.members.includes(user) && g.name !== primary).map((g) => g.name)],
  };
}

// ---- disks ----------------------------------------------------------------------------------

export function mountOf(state: LabState, path: string): Device | undefined {
  return state.devices
    .filter((d) => d.mountpoint && (path === d.mountpoint || path.startsWith(`${d.mountpoint === "/" ? "" : d.mountpoint}/`)))
    .sort((a, b) => b.mountpoint!.length - a.mountpoint!.length)[0];
}

/** Bytes used on a mounted device: base OS usage plus every file stored under the mount. */
export async function deviceUsage(state: LabState, fs: LabFs, dev: Device): Promise<number> {
  let used = dev.mountpoint === "/" ? ROOT_FS_BASE_USED : dev.fstype === "vfat" ? 6.1 * MiB : 0;
  for (const path of fs.inner.getAllPaths()) {
    if (mountOf(state, path) !== dev) continue;
    const st = await fs.inner.lstat(path);
    if (st.isFile) used += fs.meta.sizes[path] ?? st.size;
  }
  return used;
}

// ---- processes ------------------------------------------------------------------------------

export function spawn(state: LabState, p: Omit<Proc, "pid" | "start" | "stat" | "vsz" | "rss" | "tty"> & Partial<Proc>): Proc {
  const proc: Proc = { pid: state.nextPid++, start: Date.now(), stat: "S", vsz: 12_000, rss: 4_000, tty: "?", ...p };
  state.procs.push(proc);
  return proc;
}

export function cpuTime(p: Proc, now = Date.now()) {
  const secs = Math.floor(((now - p.start) / 1000) * (p.cpu / 100));
  return `${Math.floor(secs / 60)}:${pad(secs % 60)}`;
}

export function journal(state: LabState, unit: string, ident: string, pid: number, msg: string, pri = 6, t = Date.now()) {
  state.journal.push({ t, unit, ident, pid, pri, msg });
  if (state.journal.length > 3000) state.journal.splice(0, state.journal.length - 3000);
}

// ---- systemd-like units ---------------------------------------------------------------------

/** Validates nginx config the way `nginx -t` reports the first problem. */
export async function nginxConfigError(fs: LabFs): Promise<string | undefined> {
  const files = ["/etc/nginx/nginx.conf"];
  const enabled = "/etc/nginx/sites-enabled";
  if (await fs.inner.exists(enabled)) for (const f of (await fs.inner.readdir(enabled)).sort()) files.push(`${enabled}/${f}`);
  for (const file of files) {
    const text = await readAsRoot(fs, file);
    if (text === undefined) return `open() "${file}" failed (2: No such file or directory)`;
    let depth = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/#.*/, "").trim();
      if (!line) continue;
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (depth < 0) return `unexpected "}" in ${file}:${i + 1}`;
      }
      if (/;\s*;/.test(line)) return `unexpected ";" in ${file}:${i + 1}`;
      if (!/[;{}]$/.test(line)) return `directive "${line.split(/\s+/)[0]}" is not terminated by ";" in ${file}:${i + 1}`;
    }
    if (depth > 0) return `unexpected end of file, expecting "}" in ${file}:${lines.length}`;
  }
  return undefined;
}

async function unitProblem(state: LabState, fs: LabFs, name: string, unit: Unit): Promise<string[] | undefined> {
  for (const check of unit.checks) {
    if (check.type === "nginx-config") {
      const err = await nginxConfigError(fs);
      if (err) return [`nginx: [emerg] ${err}`, "nginx: configuration file /etc/nginx/nginx.conf test failed"];
    }
    if (check.type === "file-exists" && !(await fs.inner.exists(check.path)))
      return [`Error: Cannot find module '${check.path}'`];
    if (check.type === "file-readable") {
      if (!(await fs.inner.exists(check.path))) return [`Error: ENOENT: no such file or directory, open '${check.path}'`];
      const id = await identityOf(fs, unit.user);
      const saved = fs.identity;
      try {
        if (id) fs.identity = id;
        await fs.readFile(check.path);
      } catch {
        return [`Error: EACCES: permission denied, open '${check.path}'`];
      } finally {
        fs.identity = saved;
      }
    }
    if (check.type === "exec") {
      const exists = await fs.inner.exists(check.path);
      const mode = exists ? (await fs.inner.stat(check.path)).mode : 0;
      if (!exists) return [`${name}.service: Failed to locate executable ${check.path}: No such file or directory`, `${name}.service: Failed at step EXEC spawning ${check.path}: No such file or directory`];
      if (!(mode & 0o111)) return [`${name}.service: Failed at step EXEC spawning ${check.path}: Permission denied`];
    }
    if (check.type === "port-free")
      for (const port of unit.ports) {
        const holder = state.procs.find((p) => p.unit !== name && p.ports?.includes(port));
        if (holder)
          return name === "nginx"
            ? [`nginx: [emerg] bind() to 0.0.0.0:${port} failed (98: Address already in use)`]
            : [`Error: listen EADDRINUSE: address already in use :::${port}`];
      }
    if (check.type === "disk-space") {
      const root = state.devices.find((d) => d.mountpoint === "/")!;
      if ((await deviceUsage(state, fs, root)) >= ROOT_CAPACITY - 64 * MiB) return ["Error: ENOSPC: no space left on device, write"];
    }
  }
  return undefined;
}

function stopProcs(state: LabState, name: string) {
  state.procs = state.procs.filter((p) => p.unit !== name);
}

export async function startUnit(state: LabState, fs: LabFs, name: string): Promise<string | undefined> {
  const unit = state.units[name];
  if (unit.active) return undefined;
  const now = Date.now();
  journal(state, name, "systemd", 1, `Starting ${name}.service - ${unit.description}...`);
  const problem = await unitProblem(state, fs, name, unit);
  if (problem) {
    const pid = state.nextPid++;
    for (const line of problem) journal(state, name, name === "nginx" ? "nginx" : "node", pid, line, 3);
    journal(state, name, "systemd", 1, `${name}.service: Main process exited, code=exited, status=1/FAILURE`, 4);
    journal(state, name, "systemd", 1, `${name}.service: Failed with result 'exit-code'.`, 4);
    journal(state, name, "systemd", 1, `Failed to start ${name}.service - ${unit.description}.`, 3);
    Object.assign(unit, { active: false, failed: true, since: now, mainPid: undefined });
    return `Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`;
  }
  stopProcs(state, name);
  const main = spawn(state, { ppid: 1, user: name === "nginx" ? "root" : unit.user, cmd: unit.exec, cpu: unit.cpu, mem: unit.mem, rss: Math.round((MEM_TOTAL_KB * unit.mem) / 100), vsz: 600_000, unit: name, ports: unit.ports });
  if (unit.workers)
    for (let i = 0; i < unit.workers.count; i++)
      spawn(state, { ppid: main.pid, user: unit.workers.user, cmd: unit.workers.cmd, cpu: 0, mem: 0.3, rss: 5_800, unit: name });
  Object.assign(unit, { active: true, failed: false, since: now, mainPid: main.pid });
  if (name === "webapp") journal(state, name, "node", main.pid, `webapp listening on port ${unit.ports[0]}`);
  journal(state, name, "systemd", 1, `Started ${name}.service - ${unit.description}.`);
  return undefined;
}

export function stopUnit(state: LabState, name: string, how: "stop" | "killed" = "stop") {
  const unit = state.units[name];
  const wasActive = unit.active;
  stopProcs(state, name);
  if (how === "killed") {
    journal(state, name, "systemd", 1, `${name}.service: Main process exited, code=killed, status=9/KILL`, 4);
    journal(state, name, "systemd", 1, `${name}.service: Failed with result 'signal'.`, 4);
    Object.assign(unit, { active: false, failed: true, since: Date.now(), mainPid: undefined });
    return;
  }
  if (wasActive) {
    journal(state, name, "systemd", 1, `Stopping ${name}.service - ${unit.description}...`);
    journal(state, name, "systemd", 1, `${name}.service: Deactivated successfully.`);
    journal(state, name, "systemd", 1, `Stopped ${name}.service - ${unit.description}.`);
  }
  Object.assign(unit, { active: false, failed: false, since: Date.now(), mainPid: undefined });
}
