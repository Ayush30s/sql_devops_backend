import { Bash, getCommandNames } from "just-bash";
import type { CustomCommand, ExecResult } from "just-bash";
import type { CheckResult, LinuxCheck } from "./checks.ts";
import { mismatch } from "./checks.ts";
import { adminCommands } from "./cmd/admin.ts";
import { awsCommands } from "./cmd/aws.ts";
import { fileCommands } from "./cmd/files.ts";
import { networkCommands } from "./cmd/network.ts";
import { processCommands } from "./cmd/process.ts";
import { systemCommands } from "./cmd/system.ts";
import { ok } from "./cmd/util.ts";
import type { Identity } from "./fs.ts";
import { LabFs, ROOT, fsError } from "./fs.ts";
import { createBaseState } from "./image.ts";
import type { LabState } from "./system.ts";
import { LOGIN, ROOT_CAPACITY, SHELL_PID, deviceUsage, identityOf, mountOf, normalizePath, promptOf, readPasswd, spawn } from "./system.ts";

export interface MachineLimits {
  timeoutMs: number;
  maxOutput: number;
  maxCommandLength: number;
  /** Real (non-virtual) bytes a lab may store. */
  quotaBytes: number;
}

export const DEFAULT_LIMITS: MachineLimits = { timeoutMs: 5000, maxOutput: 65536, maxCommandLength: 2000, quotaBytes: 16 * 1024 * 1024 };

export interface EditorRequest {
  path: string;
  content: string;
  sudo: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  prompt: string;
  clear?: boolean;
  timedOut?: boolean;
  editor?: EditorRequest;
}

const ENV_SKIP = new Set(["?", "SHELLOPTS", "BASHOPTS", "OPTIND", "IFS", "_", "PPID", "UID", "EUID", "RANDOM", "LINENO", "SECONDS", "PIPESTATUS", "BASH_VERSION", "BASH", "OSTYPE", "MACHTYPE", "HOSTTYPE", "FUNCNAME", "BASH_SOURCE", "BASH_LINENO", "GROUPS", "DIRSTACK"]);
const MAX_ENV_BYTES = 32 * 1024;

const CPU_HOGS = /^(yes\b|while\s+(true|:)|stress|md5sum\s+\/dev\/(u?random|zero)|cat\s+\/dev\/urandom|dd\s+if=\/dev\/zero\s+of=\/dev\/null|openssl\s+speed)/;

function portsOf(cmd: string): number[] | undefined {
  let m = /python3?\s+-m\s+http\.server(?:\s+(?:--bind\s+\S+\s+)?(\d+))?/.exec(cmd);
  if (m) return [Number(m[1] ?? 8000)];
  m = /\bnc\s+(?:-\w+\s+)*-l\w*\s+(?:-p\s+)?(\d+)/.exec(cmd);
  if (m) return [Number(m[1])];
  m = /php\s+-S\s+\S*:(\d+)/.exec(cmd);
  if (m) return [Number(m[1])];
  if (/^(node|npm\s+start)\b/.test(cmd)) return [3000];
  return undefined;
}

/** just-bash stores aliases in env (BASH_ALIAS_x) but expands them only at parse time, so expand here. */
export function expandAliases(line: string, env: Record<string, string>) {
  return line.replace(/(^|[;&|(]\s*|\$\(\s*)([A-Za-z_][\w.-]*)(?=\s|$|[;&|)])/g, (all, pre: string, word: string) => {
    const value = env[`BASH_ALIAS_${word}`];
    return value === undefined ? all : `${pre}${value}`;
  });
}

let baseCache: { at: number; state: LabState } | undefined;

async function baseState() {
  // abs: an incident's story clock can sit hours before the clock the cached image was built at
  if (!baseCache || Math.abs(Date.now() - baseCache.at) > 30 * 60_000) baseCache = { at: Date.now(), state: await createBaseState() };
  return structuredClone(baseCache.state);
}

export class Machine {
  readonly state: LabState;
  readonly fs: LabFs;
  readonly login: Identity;
  readonly limits: MachineLimits;
  setupMode = false;
  editor?: EditorRequest;
  private readonly commands: CustomCommand[];
  private usage = new Map<string, number>();
  private realBytes = 0;

  private constructor(state: LabState, fs: LabFs, login: Identity, limits: MachineLimits) {
    this.state = state;
    this.fs = fs;
    this.login = login;
    this.limits = limits;
    this.commands = [
      ...fileCommands(this), ...systemCommands(this), ...processCommands(this),
      ...networkCommands(this), ...adminCommands(this), ...awsCommands(this),
    ];
    fs.onGrow = (path, delta) => this.checkDisk(path, delta, true);
  }

  static async load(state: LabState, limits = DEFAULT_LIMITS) {
    const fs = await LabFs.restore(state.fs);
    const login = (await identityOf(fs, LOGIN)) ?? { user: LOGIN, uid: 1001, group: LOGIN, groups: [LOGIN] };
    const m = new Machine(state, fs, login, limits);
    // With a custom filesystem just-bash resolves commands through stub files on PATH.
    for (const name of new Set([...getCommandNames(), ...m.commands.map((c) => c.name)])) {
      const stub = `/usr/bin/${name}`;
      if (await fs.inner.exists(stub)) continue;
      await fs.inner.writeFile(stub, `#!/bin/bash
# Built-in command: ${name}
`);
      await fs.inner.chmod(stub, 0o755);
    }
    for (const p of fs.inner.getAllPaths()) {
      const st = await fs.inner.lstat(p);
      if (st.isFile) m.realBytes += st.size;
    }
    return m;
  }

  static async create(limits = DEFAULT_LIMITS) {
    return Machine.load(await baseState(), limits);
  }

  async save(): Promise<LabState> {
    this.state.fs = await this.fs.snapshot(() => false);
    return this.state;
  }

  get user(): Identity {
    return this.fs.identity;
  }

  isRoot() {
    return this.fs.identity.uid === 0;
  }

  async homeOf(user: string) {
    return (await readPasswd(this.fs)).find((p) => p.name === user)?.home ?? "/";
  }

  async canSudo(user = this.fs.identity) {
    return user.uid === 0 || user.groups.includes("sudo");
  }

  cwd() {
    return this.state.env.PWD ?? "/home/student";
  }

  prompt() {
    return promptOf(this.state.env);
  }

  /** Enforces the lab storage quota and full disks (ENOSPC). */
  async checkDisk(path: string, delta: number, real: boolean) {
    if (delta <= 0) return;
    if (real) {
      if (this.realBytes + delta > this.limits.quotaBytes) throw fsError("ENOSPC", "no space left on device", "write", path);
      this.realBytes += delta;
    }
    const dev = mountOf(this.state, normalizePath("/", path));
    if (!dev) return;
    const capacity = dev.mountpoint === "/" ? ROOT_CAPACITY : dev.size;
    const used = this.usage.get(dev.name) ?? (await deviceUsage(this.state, this.fs, dev));
    if (used + delta > capacity) throw fsError("ENOSPC", "no space left on device", "write", path);
    this.usage.set(dev.name, used + delta);
  }

  /** Fixes error text from built-in commands: permission problems surface as "No such file". */
  private rewrite(text: string, cwd: string) {
    if (!text) return text;
    let out = text
      .replace(/EACCES: permission denied, \w+ '[^']*'/g, "Permission denied")
      .replace(/EPERM: operation not permitted, \w+ '[^']*'/g, "Operation not permitted")
      .replace(/ENOSPC: no space left on device, \w+ '[^']*'/g, "No space left on device")
      .replace(/^.*executionLimits.*$/gm, "bash: stopped: the command did too much work (is there an infinite loop?)");
    if (this.fs.denied.size)
      out = out.replace(/^([\w.-]+): (?:cannot access '([^']+)'|([^:\n]+)): No such file or directory$/gm, (line, cmd: string, quoted?: string, plain?: string) => {
        const shown = (quoted ?? plain)!;
        const code = this.fs.denied.get(normalizePath(cwd, shown));
        if (!code) return line;
        if (cmd === "chmod") return `chmod: changing permissions of '${shown}': Operation not permitted`;
        const why = code === "EPERM" ? "Operation not permitted" : "Permission denied";
        return quoted ? `${cmd}: cannot access '${shown}': ${why}` : `${cmd}: ${shown}: ${why}`;
      });
    return out;
  }

  /** Runs one command line in a fresh shell for `identity`, sharing this machine's files and state. */
  async exec(line: string, identity: Identity, env: Record<string, string>, opts: { persist?: boolean; timeoutMs?: number } = {}): Promise<ExecResult & { timedOut?: boolean }> {
    const fs = this.fs;
    fs.identity = identity;
    fs.denied.clear();
    this.usage.clear();
    const cwd = env.PWD && (await fs.inner.exists(env.PWD)) ? env.PWD : (env.HOME ?? "/");
    const bash = new Bash({
      fs,
      cwd,
      env,
      customCommands: this.commands,
      executionLimitProfile: "hardened",
      executionLimits: { maxExecutionTimeMs: opts.timeoutMs ?? this.limits.timeoutMs, maxOutputSize: 4 * 1024 * 1024, maxCommandCount: 50_000, maxCallDepth: 64, maxLoopIterations: 100_000 },
      processInfo: { pid: SHELL_PID, ppid: 1902, uid: identity.uid, gid: identity.uid },
    });
    try {
      const r = await bash.exec(expandAliases(line, env), { env: { ...env, PWD: cwd }, replaceEnv: true, cwd });
      if (opts.persist) {
        const next = Object.fromEntries(Object.entries(r.env).filter(([k]) => !ENV_SKIP.has(k)));
        if (JSON.stringify(next).length <= MAX_ENV_BYTES) this.state.env = next;
      }
      const timedOut = /maxExecutionTimeMs|execution time|execution deadline|timed out|time limit/i.test(r.stderr) && r.exitCode !== 0;
      // only error messages are rewritten: stdout is content (a log, the journal) and must stay as it is
      return { stdout: r.stdout, stderr: this.rewrite(r.stderr, cwd), exitCode: r.exitCode, timedOut };
    } catch (e) {
      const err = e as { code?: string; path?: string; message?: string };
      const why = err.code === "EACCES" ? "Permission denied" : err.code === "EPERM" ? "Operation not permitted" : err.code === "ENOSPC" ? "No space left on device" : undefined;
      if (why) return { stdout: "", stderr: `bash: ${err.path ?? ""}: ${why}\n`, exitCode: 1 };
      return { stdout: "", stderr: `bash: ${(err.message ?? "command failed").split("\n")[0]}\n`, exitCode: 1 };
    } finally {
      fs.identity = this.login;
    }
  }

  private finish(r: ExecResult & { timedOut?: boolean }, extra = ""): CommandResult {
    const max = this.limits.maxOutput;
    const clip = (s: string) => (s.length > max ? `${s.slice(0, max)}\n[output truncated: ${s.length - max} more characters]\n` : s);
    const timedOut = !!r.timedOut;
    return {
      stdout: clip(r.stdout + extra),
      stderr: timedOut ? `Command timed out.\nMaximum execution time: ${this.limits.timeoutMs / 1000} seconds.\n` : clip(r.stderr),
      exitCode: r.exitCode,
      cwd: this.cwd(),
      prompt: this.prompt(),
      timedOut: timedOut || undefined,
      editor: this.editor,
    };
  }

  private recordHistory(line: string) {
    this.state.history.push(line);
    if (this.state.history.length > 500) this.state.history.splice(0, this.state.history.length - 500);
  }

  /** Finished `sleep N &` jobs and jobs whose process was killed. */
  private reapJobs() {
    const now = Date.now();
    let notes = "";
    this.state.procs = this.state.procs.filter((p) => !(p.endsAt && p.endsAt <= now));
    for (const job of [...this.state.jobs]) {
      if (this.state.procs.some((p) => p.pid === job.pid)) continue;
      notes += `[${job.id}]+  Done                    ${job.cmd}\n`;
      this.state.jobs = this.state.jobs.filter((j) => j !== job);
    }
    if (!this.state.jobs.length) this.state.nextJob = 1;
    return notes;
  }

  /** `command &`: registers a background process instead of blocking the terminal. */
  private async background(text: string): Promise<ExecResult> {
    let cmd = text;
    let identity = this.login;
    if (/^sudo\s+/.test(cmd)) {
      cmd = cmd.replace(/^sudo\s+/, "");
      identity = ROOT;
    }
    const nohup = /^nohup\s+/.test(cmd);
    cmd = cmd.replace(/^nohup\s+/, "");
    const targets = [...cmd.matchAll(/(?:^|\s)(\d?)(>>?|&>)\s*([^\s;&|<>]+)/g)];
    cmd = cmd.replace(/\s*\d?(?:>>?|&>)\s*[^\s;&|<>]+/g, "").replace(/\s*\d?>&\d/g, "").trim();
    const cwd = this.cwd();
    const first = cmd.split(/\s+/)[0] ?? "";
    const probe = await this.exec(`type -t ${first.replace(/[^\w./-]/g, "")}`, identity, this.state.env);
    if (!probe.stdout.trim()) return { stdout: "", stderr: `bash: ${first}: command not found\n`, exitCode: 127 };
    let stderr = "";
    this.fs.identity = identity;
    try {
      const home = this.state.env.HOME ?? "/home/student";
      for (const [, , , target] of targets) if (target !== "/dev/null") await this.fs.appendFile(normalizePath(cwd, target.replace(/^~(?=\/|$)/, home)), "");
      if (nohup && !targets.some(([, fd, op]) => op === "&>" || fd !== "2")) {
        await this.fs.appendFile(normalizePath(cwd, "nohup.out"), "");
        stderr = "nohup: ignoring input and appending output to 'nohup.out'\n";
      }
    } catch (e) {
      return { stdout: "", stderr: `bash: ${(e as { path?: string }).path}: Permission denied\n`, exitCode: 1 };
    } finally {
      this.fs.identity = this.login;
    }
    const sleep = /^sleep\s+(\d+(?:\.\d+)?)([smh]?)$/.exec(cmd);
    const id = this.state.nextJob++;
    const proc = spawn(this.state, {
      ppid: SHELL_PID,
      user: identity.user,
      cmd: /^\.?\.?\//.test(first) ? `/bin/bash ${cmd}` : cmd,
      cpu: CPU_HOGS.test(cmd) ? 99.3 : 0,
      mem: 0.2,
      rss: 3800,
      tty: "pts/0",
      job: id,
      cwd,
      ports: portsOf(cmd),
      endsAt: sleep ? Date.now() + Number(sleep[1]) * ({ m: 60, h: 3600 }[sleep[2]] ?? 1) * 1000 : undefined,
    });
    this.state.jobs.push({ id, pid: proc.pid, cmd: text.replace(/^sudo\s+/, "") + " &" });
    return { stdout: `[${id}] ${proc.pid}\n`, stderr, exitCode: 0 };
  }

  /** One line typed in the terminal by the learner. */
  async run(raw: string): Promise<CommandResult> {
    this.editor = undefined;
    const line = raw.replace(/\r/g, "").trim();
    if (line.length > this.limits.maxCommandLength)
      return this.finish({ stdout: "", stderr: `bash: command too long (maximum ${this.limits.maxCommandLength} characters)\n`, exitCode: 1 });
    const notes = this.reapJobs();
    if (!line) return this.finish(ok(), notes);
    this.recordHistory(line);
    if (/^(exit|logout)(\s|$)/.test(line)) return this.finish(ok("logout\n(The lab keeps running. Use Reset Lab for a fresh machine.)\n"));
    if (line === "clear" || line === "reset") return { ...this.finish(ok()), clear: true };
    const bg = /^(.*[^&|>])&\s*$/s.exec(line);
    // Each line runs in a fresh shell; replaying the last status keeps `$?` meaningful.
    const status = this.state.lastExit ? `(exit ${this.state.lastExit}); ` : "";
    const r = bg ? await this.background(bg[1].trim()) : await this.exec(status + line, this.login, this.state.env, { persist: true });
    this.state.lastExit = r.exitCode;
    return this.finish(r, notes);
  }

  /** Exercise setup: a bash script run as root, with setup-only helper commands enabled. */
  async setup(script: string) {
    this.setupMode = true;
    try {
      return await this.exec(script, ROOT, { ...this.state.env, HOME: "/root", USER: "root", LOGNAME: "root", PWD: "/root" }, { timeoutMs: 30_000 });
    } finally {
      this.setupMode = false;
      // Files a setup script creates in the learner's home belong to the learner.
      for (const p of this.fs.inner.getAllPaths()) if (p.startsWith("/home/student/") && this.fs.ownerOf(p)[0] === "root") this.fs.setOwner(p, ["student", "student"]);
    }
  }

  /** Saves a file from the editor panel with the learner's (or root's, after sudo) permissions. */
  async writeFile(path: string, content: string, sudo: boolean): Promise<string | undefined> {
    this.fs.identity = sudo ? ROOT : this.login;
    try {
      await this.fs.writeFile(normalizePath("/", path), content);
      return undefined;
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === "EACCES" ? `${path}: Permission denied` : code === "ENOSPC" ? `${path}: No space left on device` : `${path}: could not be saved`;
    } finally {
      this.fs.identity = this.login;
    }
  }

  async verify(checks: LinuxCheck[], outputs: string[]): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const inner = this.fs.inner;
    for (const c of checks) {
      const fail = (message: string): CheckResult => ({ label: c.label, pass: false, message });
      const pass: CheckResult = { label: c.label, pass: true };
      switch (c.type) {
        case "FILE_EXISTS":
        case "DIRECTORY_EXISTS": {
          const want = c.exists ?? true;
          const st = (await inner.exists(c.path)) ? await inner.stat(c.path) : undefined;
          const isRight = c.type === "FILE_EXISTS" ? !!st && !st.isDirectory : !!st?.isDirectory;
          const kind = c.type === "FILE_EXISTS" ? "file" : "directory";
          if (want && !isRight) results.push(fail(st ? `${c.path} exists but is not a ${kind}` : `${c.path} does not exist yet`));
          else if (!want && st) results.push(fail(`${c.path} still exists`));
          else results.push(pass);
          break;
        }
        case "FILE_CONTENT": {
          const text = (await inner.exists(c.path)) ? await inner.readFile(c.path).catch(() => undefined) : undefined;
          if (text === undefined) results.push(fail(`${c.path} does not exist yet`));
          else {
            const why = mismatch(text, c);
            results.push(why ? fail(`${c.path}: ${why}`) : pass);
          }
          break;
        }
        case "FILE_PERMISSIONS": {
          if (!(await inner.exists(c.path))) results.push(fail(`${c.path} does not exist`));
          else {
            const mode = ((await inner.stat(c.path)).mode & 0o7777).toString(8);
            results.push(Number.parseInt(mode, 8) === Number.parseInt(c.mode, 8) ? pass : fail(`${c.path} has permissions ${mode}, expected ${c.mode}`));
          }
          break;
        }
        case "FILE_OWNER": {
          if (!(await inner.exists(c.path))) results.push(fail(`${c.path} does not exist`));
          else {
            const [u, g] = this.fs.ownerOf(await inner.realpath(c.path));
            const okUser = !c.user || c.user === u;
            const okGroup = !c.group || c.group === g;
            results.push(okUser && okGroup ? pass : fail(`${c.path} is owned by ${u}:${g}, expected ${c.user ?? u}:${c.group ?? g}`));
          }
          break;
        }
        case "COMMAND_OUTPUT": {
          const who = c.as === "student" ? this.login : ROOT;
          const r = await this.exec(c.command, who, { ...this.state.env, ...(who === ROOT && { HOME: "/root", USER: "root" }) });
          const why = mismatch(r.stdout + r.stderr, c);
          results.push(why ? fail(`\`${c.command}\`: ${why}`) : pass);
          break;
        }
        case "USER_OUTPUT": {
          const expected = c.sameAs ? (await this.exec(c.sameAs, ROOT, { ...this.state.env, HOME: "/root", USER: "root" })).stdout.trim() : undefined;
          const matches = (o: string) => !mismatch(o, c) && (expected === undefined || o.trim() === expected);
          results.push(outputs.some(matches) ? pass : fail("None of your commands printed the expected result yet"));
          break;
        }
        case "PROCESS_STATE": {
          const re = new RegExp(c.match);
          const running = this.state.procs.some((p) => re.test(p.cmd));
          results.push(running === c.running ? pass : fail(c.running ? "The process is not running" : "The process is still running"));
          break;
        }
        case "ENVIRONMENT_VARIABLE": {
          const value = this.state.env[c.name];
          if (value === undefined) results.push(fail(`$${c.name} is not set in your shell`));
          else {
            const why = mismatch(value, c);
            results.push(why ? fail(`$${c.name}: ${why}`) : pass);
          }
          break;
        }
        case "CUSTOM_SCRIPT": {
          const r = await this.setup(c.script);
          results.push(r.exitCode === 0 ? pass : fail((r.stdout + r.stderr).trim() || "The check did not pass yet"));
          break;
        }
      }
    }
    return results;
  }
}

