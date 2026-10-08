import { createHash, randomBytes } from "node:crypto";
import type { Machine } from "../machine.ts";
import type { Unit } from "../system.ts";
import { HOSTNAME, ROOT_CAPACITY, SHELL_PID, deviceUsage, identityOf, journal, nginxConfigError, normalizePath, readGroups, readPasswd, spawn, startUnit, stopUnit, syslogTime } from "../system.ts";
import { comm } from "./process.ts";
import { command, fail, longDate, ok, parseArgs, quoteArgs, relativeTime, stdinText } from "./util.ts";

const SHELL_BUILTINS = new Set(["cd", "export", "source", ".", "alias", "unalias", "set", "unset", "history", "jobs", "fg", "bg", "exit", "logout", "pushd", "popd", "read", "type", "ulimit", "umask"]);
const PRIORITIES: Record<string, number> = { emerg: 0, alert: 1, crit: 2, err: 3, error: 3, warning: 4, warn: 4, notice: 5, info: 6, debug: 7 };
const NAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;

function parseSince(text: string, now: number): number | undefined {
  const s = text.trim().toLowerCase();
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  if (s === "today") return day.getTime();
  if (s === "yesterday") return day.getTime() - 86400_000;
  if (s === "now") return now;
  const units: Record<string, number> = { s: 1, sec: 1, second: 1, seconds: 1, m: 60, min: 60, minute: 60, minutes: 60, h: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 };
  let m = /^(\d+)\s*([a-z]+)\s+ago$/.exec(s) ?? /^-(\d+)\s*([a-z]+)$/.exec(s);
  if (m && units[m[2]]) return now - Number(m[1]) * units[m[2]] * 1000;
  m = /^(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}(?::\d{2})?))?$/.exec(s);
  if (m) return Date.parse(`${m[1]}T${m[2] ?? "00:00:00"}${m[2]?.length === 5 ? ":00" : ""}Z`);
  m = /^(\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (m) return Date.parse(`${day.toISOString().slice(0, 10)}T${m[1]}${m[1].length === 5 ? ":00" : ""}Z`);
  return undefined;
}

const CRON_RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const CRON_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"];

function cronLineError(line: string): string | undefined {
  const t = line.trim();
  if (!t || t.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) return undefined;
  if (t.startsWith("@")) return /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+\S/.test(t) ? undefined : "bad time specifier";
  const parts = t.split(/\s+/);
  if (parts.length < 6) return parts.length < 5 ? `bad ${CRON_NAMES[parts.length - 1] ?? "minute"}` : "bad command";
  for (let i = 0; i < 5; i++) {
    for (const piece of parts[i].split(",")) {
      const m = /^(\*|(\d+|[a-z]{3})(?:-(\d+|[a-z]{3}))?)(?:\/(\d+))?$/i.exec(piece);
      if (!m) return `bad ${CRON_NAMES[i]}`;
      const nums = [m[2], m[3]].filter((x) => x && /^\d+$/.test(x)).map(Number);
      const [lo, hi] = CRON_RANGES[i];
      if (nums.some((n) => n < lo || n > hi)) return `bad ${CRON_NAMES[i]}`;
      if (m[2] && /^[a-z]/i.test(m[2]) && i !== 3 && i !== 4) return `bad ${CRON_NAMES[i]}`;
    }
  }
  return undefined;
}

export function parseUnitFile(text: string) {
  const get = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1]?.trim();
  return { description: get("Description") ?? "", user: get("User") ?? "root", exec: get("ExecStart") ?? "", wantedBy: get("WantedBy") };
}

export function adminCommands(m: Machine) {
  const fs = m.fs;
  const state = () => m.state;
  const needRoot = (tool: string, file = "/etc/passwd") => (m.isRoot() ? undefined : fail(`${tool}: Permission denied.\n${tool}: cannot lock ${file}; try again later.`));

  async function editLines(path: string, fn: (lines: string[]) => string[]) {
    const lines = (await fs.inner.readFile(path).catch(() => "")).split("\n").filter(Boolean);
    await fs.inner.writeFile(path, `${fn(lines).join("\n")}\n`);
  }

  const today = () => Math.floor(Date.now() / 86400_000);
  const fakeHash = (pw: string) => {
    const salt = randomBytes(12).toString("base64").replace(/[+/=]/g, "x");
    return `$y$j9T$${salt}$${createHash("sha256").update(pw + salt).digest("base64").replace(/[+/=]/g, "x")}`;
  };

  async function audit(cmdLine: string, target: string, cwd: string) {
    await fs.inner
      .appendFile("/var/log/auth.log", `${syslogTime(Date.now())} ${HOSTNAME} sudo:  ${m.user.user} : TTY=pts/0 ; PWD=${cwd} ; USER=${target} ; COMMAND=${cmdLine}\n`)
      .catch(() => {});
  }

  const sudo = command("sudo", async (args, ctx) => {
    const me = m.user;
    let target = "root";
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "-u") target = args[++i] ?? "";
      else if (a.startsWith("-u") && a.length > 2) target = a.slice(2);
      else if (a === "-l" || a === "--list")
        return ok(`Matching Defaults entries for ${me.user} on ${HOSTNAME}:\n    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty\n\nUser ${me.user} may run the following commands on ${HOSTNAME}:\n    (ALL : ALL) ALL\n    (ALL) NOPASSWD: ALL\n`);
      else if (a === "-v" || a === "-k" || a === "-K" || a === "--validate" || a === "--reset-timestamp") return ok();
      else if (a === "-i" || a === "-s" || a === "--login" || a === "--shell") {
        if (i === args.length - 1) return fail("sudo: interactive root shells are not available in this lab terminal.\nPrefix each command with sudo instead, for example: sudo systemctl restart nginx");
      } else if (a === "--") {
        i++;
        break;
      } else if (a.startsWith("-")) continue;
      else break;
    }
    if (!(await m.canSudo(me))) return fail(`${me.user} is not in the sudoers file.`);
    let cmdArgs = args.slice(i);
    let echoLine = "";
    if (cmdArgs[0] === "!!") {
      const last = state().history.at(-2);
      if (!last) return fail("sudo: !!: command not found");
      echoLine = `sudo ${last}\n`;
      cmdArgs = [];
      args = [last];
    }
    if (!cmdArgs.length && !echoLine) return fail("usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] command [arg ...]");
    const first = cmdArgs[0];
    if (first && SHELL_BUILTINS.has(first)) return fail(`sudo: ${first}: command not found`);
    if (first === "su" || ((first === "bash" || first === "sh") && cmdArgs.length === 1))
      return fail("sudo: interactive root shells are not available in this lab terminal.\nPrefix each command with sudo instead.");
    const ident = await identityOf(fs, target);
    if (!ident) return fail(`sudo: unknown user ${target}\nsudo: error initializing audit plugin sudoers_audit`);
    const line = echoLine ? args[0] : quoteArgs(cmdArgs);
    await audit(`/usr/bin/${line}`, target, ctx.cwd);
    const home = await m.homeOf(target);
    const prev = fs.identity;
    fs.identity = ident;
    try {
      const run = ctx.execWithInheritedStdin ?? ctx.exec!;
      const r = await run(line, { cwd: ctx.cwd, env: { HOME: home, USER: target, LOGNAME: target, SUDO_USER: me.user } });
      return { ...r, stdout: echoLine + r.stdout };
    } finally {
      fs.identity = prev;
    }
  });

  const su = command("su", async (args, ctx) => {
    const p = parseArgs(args, "c", ["command"]);
    const cmd = p.values.c ?? p.values.command;
    const user = p.rest.find((a) => a !== "-") ?? "root";
    if (m.isRoot() && cmd) {
      const ident = await identityOf(fs, user);
      if (!ident) return fail(`su: user ${user} does not exist or the user entry does not contain all the required fields`);
      const prev = fs.identity;
      fs.identity = ident;
      try {
        return await (ctx.execWithInheritedStdin ?? ctx.exec!)(cmd, { cwd: ctx.cwd, env: { HOME: await m.homeOf(user), USER: user } });
      } finally {
        fs.identity = prev;
      }
    }
    return fail("Password: \nsu: Authentication failure\n(Ubuntu's root account has no password, and interactive shells aren't available here. Use sudo COMMAND instead.)");
  });

  async function addUser(name: string, opts: { home?: string; createHome: boolean; shell: string; group?: string; groups: string[]; uid?: number; comment: string; system: boolean }) {
    const passwd = await readPasswd(fs);
    const groups = await readGroups(fs);
    if (passwd.some((p) => p.name === name)) return { error: `useradd: user '${name}' already exists`, code: 9 };
    if (opts.group && !groups.some((g) => g.name === opts.group || String(g.gid) === opts.group)) return { error: `useradd: group '${opts.group}' does not exist`, code: 6 };
    const missing = opts.groups.find((g) => !groups.some((x) => x.name === g));
    if (missing) return { error: `useradd: group '${missing}' does not exist`, code: 6 };
    const used = new Set(passwd.map((p) => p.uid));
    let uid = opts.uid ?? (opts.system ? 999 : 1000);
    if (opts.uid === undefined) while (used.has(uid) || groups.some((g) => g.gid === uid)) uid += opts.system ? -1 : 1;
    let gid: number;
    if (opts.group) gid = groups.find((g) => g.name === opts.group || String(g.gid) === opts.group)!.gid;
    else {
      gid = uid;
      while (groups.some((g) => g.gid === gid)) gid++;
      await editLines("/etc/group", (l) => [...l, `${name}:x:${gid}:`]);
    }
    const home = opts.home ?? `/home/${name}`;
    await editLines("/etc/passwd", (l) => [...l, `${name}:x:${uid}:${gid}:${opts.comment}:${home}:${opts.shell}`]);
    await editLines("/etc/shadow", (l) => [...l, `${name}:!:${today()}:0:99999:7:::`]);
    if (opts.groups.length) await editLines("/etc/group", (l) => l.map((line) => (opts.groups.includes(line.split(":")[0]) ? addMember(line, name) : line)));
    if (opts.createHome && !(await fs.inner.exists(home))) {
      await fs.inner.mkdir(home, { recursive: true });
      await fs.inner.chmod(home, 0o750);
      for (const f of await fs.inner.readdir("/etc/skel").catch(() => [] as string[])) await fs.inner.writeFile(`${home}/${f}`, await fs.inner.readFile(`/etc/skel/${f}`));
      const group = (await readGroups(fs)).find((g) => g.gid === gid)?.name ?? name;
      for (const p of [home, ...fs.inner.getAllPaths().filter((p) => p.startsWith(`${home}/`))]) fs.setOwner(p, [name, group]);
    }
    return { uid, gid };
  }

  const addMember = (line: string, user: string) => {
    const parts = line.split(":");
    const members = parts[3] ? parts[3].split(",") : [];
    if (!members.includes(user)) members.push(user);
    parts[3] = members.join(",");
    return parts.join(":");
  };
  const dropMember = (line: string, user: string) => {
    const parts = line.split(":");
    parts[3] = (parts[3] ? parts[3].split(",") : []).filter((u) => u !== user).join(",");
    return parts.join(":");
  };

  const useradd = command("useradd", async (args) => {
    const p = parseArgs(args, "dsgGuck", ["home-dir", "shell", "gid", "groups", "uid", "comment"]);
    const name = p.rest[0];
    if (!name) return fail("Usage: useradd [options] LOGIN", 2);
    const denied = needRoot("useradd");
    if (denied) return denied;
    if (!NAME_RE.test(name)) return fail(`useradd: invalid user name '${name}': use --badname to ignore`, 3);
    const r = await addUser(name, {
      home: p.values.d ?? p.values["home-dir"],
      createHome: p.flags.has("m") || p.flags.has("create-home"),
      shell: p.values.s ?? p.values.shell ?? "/bin/sh",
      group: p.values.g ?? p.values.gid,
      groups: (p.values.G ?? p.values.groups ?? "").split(",").filter(Boolean),
      uid: p.values.u ? Number(p.values.u) : undefined,
      comment: p.values.c ?? p.values.comment ?? "",
      system: p.flags.has("r") || p.flags.has("system"),
    });
    return "error" in r ? fail(r.error!, r.code) : ok();
  });

  const adduser = command("adduser", async (args) => {
    const p = parseArgs(args, "", ["gecos", "shell", "home", "ingroup"]);
    const [name, group] = p.rest;
    if (!name) return fail("adduser: Only one or two names allowed.");
    if (!m.isRoot()) return fail("fatal: Only root may add a user or group to the system.");
    if (group) {
      const users = await readPasswd(fs);
      if (!users.some((u) => u.name === name)) return fail(`fatal: The user \`${name}' does not exist.`);
      if (!(await readGroups(fs)).some((g) => g.name === group)) return fail(`fatal: The group \`${group}' does not exist.`);
      await editLines("/etc/group", (l) => l.map((line) => (line.split(":")[0] === group ? addMember(line, name) : line)));
      return ok(`info: Adding user \`${name}' to group \`${group}' ...\n`);
    }
    if (!NAME_RE.test(name)) return fail(`fatal: Please enter a username matching the regular expression\nconfigured via the NAME_REGEX configuration variable.  Use the \`--allow-bad-names' option to\nrelax this check or reconfigure NAME_REGEX.`);
    const r = await addUser(name, { home: p.values.home, createHome: true, shell: p.values.shell ?? "/bin/bash", group: p.values.ingroup, groups: ["users"], comment: p.values.gecos ?? "", system: false });
    if ("error" in r) return fail(r.error!.replace("useradd: user", "fatal: The user").replace("already exists", "already exists."), 1);
    return ok(
      `info: Adding user \`${name}' ...\ninfo: Selecting UID/GID from range 1000 to 59999 ...\ninfo: Adding new group \`${name}' (${r.gid}) ...\ninfo: Adding new user \`${name}' (${r.uid}) with group \`${name} (${r.gid})' ...\ninfo: Creating home directory \`/home/${name}' ...\ninfo: Copying files from \`/etc/skel' ...\ninfo: Adding new user \`${name}' to supplemental / extra groups \`users' ...\ninfo: Adding user \`${name}' to group \`users' ...\n`,
      `(This lab can't prompt for a password. Set one with: echo '${name}:NewPassword123' | sudo chpasswd)\n`,
    );
  });

  const usermod = command("usermod", async (args) => {
    const p = parseArgs(args, "GgsdlLUce", ["groups", "gid", "shell", "home", "login", "comment"]);
    const name = p.rest[0];
    if (!name) return fail("Usage: usermod [options] LOGIN", 2);
    const denied = needRoot("usermod");
    if (denied) return denied;
    const users = await readPasswd(fs);
    const user = users.find((u) => u.name === name);
    if (!user) return fail(`usermod: user '${name}' does not exist`, 6);
    const groups = await readGroups(fs);
    const newGroups = (p.values.G ?? p.values.groups)?.split(",").filter(Boolean);
    if (newGroups) {
      const missing = newGroups.find((g) => !groups.some((x) => x.name === g));
      if (missing) return fail(`usermod: group '${missing}' does not exist`, 6);
      const append = p.flags.has("a") || p.flags.has("append");
      await editLines("/etc/group", (lines) =>
        lines.map((line) => {
          const g = line.split(":")[0];
          if (newGroups.includes(g)) return addMember(line, name);
          return append ? line : dropMember(line, name);
        }),
      );
    }
    const shell = p.values.s ?? p.values.shell;
    const home = p.values.d ?? p.values.home;
    const login = p.values.l ?? p.values.login;
    const gid = p.values.g ?? p.values.gid;
    const comment = p.values.c ?? p.values.comment;
    if (gid && !groups.some((g) => g.name === gid || String(g.gid) === gid)) return fail(`usermod: group '${gid}' does not exist`, 6);
    if (shell || home || login || gid || comment !== undefined)
      await editLines("/etc/passwd", (lines) =>
        lines.map((line) => {
          const f = line.split(":");
          if (f[0] !== name) return line;
          if (shell) f[6] = shell;
          if (home) f[5] = home;
          if (login) f[0] = login;
          if (gid) f[3] = String(groups.find((g) => g.name === gid || String(g.gid) === gid)!.gid);
          if (comment !== undefined) f[4] = comment;
          return f.join(":");
        }),
      );
    if (home && p.flags.has("m") && (await fs.inner.exists(user.home))) await fs.inner.mv(user.home, home);
    if (p.flags.has("L") || p.flags.has("U") || login)
      await editLines("/etc/shadow", (lines) =>
        lines.map((line) => {
          const f = line.split(":");
          if (f[0] !== name) return line;
          if (p.flags.has("L") && !f[1].startsWith("!")) f[1] = `!${f[1]}`;
          if (p.flags.has("U") && f[1].startsWith("!") && f[1].length > 1) f[1] = f[1].slice(1);
          if (login) f[0] = login;
          return f.join(":");
        }),
      );
    return ok();
  });

  const userdel = command("userdel", async (args) => {
    const p = parseArgs(args);
    const name = p.rest[0];
    if (!name) return fail("Usage: userdel [options] LOGIN", 2);
    const denied = needRoot("userdel");
    if (denied) return denied;
    const user = (await readPasswd(fs)).find((u) => u.name === name);
    if (!user) return fail(`userdel: user '${name}' does not exist`, 6);
    const proc = state().procs.find((x) => x.user === name);
    if (proc && !p.flags.has("f")) return fail(`userdel: user ${name} is currently used by process ${proc.pid}`, 8);
    await editLines("/etc/passwd", (l) => l.filter((line) => line.split(":")[0] !== name));
    await editLines("/etc/shadow", (l) => l.filter((line) => line.split(":")[0] !== name));
    await editLines("/etc/group", (l) => l.filter((line) => !(line.split(":")[0] === name && !line.split(":")[3])).map((line) => dropMember(line, name)));
    if ((p.flags.has("r") || p.flags.has("remove")) && (await fs.inner.exists(user.home))) await fs.rm(user.home, { recursive: true, force: true });
    return ok();
  });

  const groupadd = command("groupadd", async (args) => {
    const p = parseArgs(args, "g", ["gid"]);
    const name = p.rest[0];
    if (!name) return fail("Usage: groupadd [options] GROUP", 2);
    const denied = needRoot("groupadd", "/etc/group");
    if (denied) return denied;
    const groups = await readGroups(fs);
    if (groups.some((g) => g.name === name)) return fail(`groupadd: group '${name}' already exists`, 9);
    let gid = Number(p.values.g ?? p.values.gid ?? 1001);
    if (!p.values.g && !p.values.gid) while (groups.some((g) => g.gid === gid)) gid++;
    await editLines("/etc/group", (l) => [...l, `${name}:x:${gid}:`]);
    return ok();
  });

  const groupdel = command("groupdel", async (args) => {
    const name = args[0];
    if (!name) return fail("Usage: groupdel [options] GROUP", 2);
    const denied = needRoot("groupdel", "/etc/group");
    if (denied) return denied;
    const g = (await readGroups(fs)).find((x) => x.name === name);
    if (!g) return fail(`groupdel: group '${name}' does not exist`, 6);
    if ((await readPasswd(fs)).some((u) => u.gid === g.gid)) return fail(`groupdel: cannot remove the primary group of user '${(await readPasswd(fs)).find((u) => u.gid === g.gid)!.name}'`, 8);
    await editLines("/etc/group", (l) => l.filter((line) => line.split(":")[0] !== name));
    return ok();
  });

  const gpasswd = command("gpasswd", async (args) => {
    const p = parseArgs(args, "ad");
    const group = p.rest[0];
    const user = p.values.a ?? p.values.d;
    if (!group || !user) return fail("Usage: gpasswd [option] GROUP\n  -a, --add USER   add USER to GROUP\n  -d, --delete USER   remove USER from GROUP");
    if (!m.isRoot()) return fail("gpasswd: Permission denied.");
    if (!(await readGroups(fs)).some((g) => g.name === group)) return fail(`gpasswd: group '${group}' does not exist in /etc/group`, 3);
    if (!(await readPasswd(fs)).some((u) => u.name === user)) return fail(`gpasswd: user '${user}' does not exist`, 3);
    await editLines("/etc/group", (l) => l.map((line) => (line.split(":")[0] === group ? (p.values.a ? addMember(line, user) : dropMember(line, user)) : line)));
    return ok(p.values.a ? `Adding user ${user} to group ${group}\n` : `Removing user ${user} from group ${group}\n`);
  });

  const passwd = command("passwd", async (args) => {
    const p = parseArgs(args);
    const name = p.rest[0] ?? m.user.user;
    if (name !== m.user.user && !m.isRoot()) return fail(`passwd: You may not view or modify password information for ${name}.`);
    const shadow = (await fs.inner.readFile("/etc/shadow").catch(() => "")).split("\n").find((l) => l.startsWith(`${name}:`));
    if (!shadow) return fail(`passwd: user '${name}' does not exist`);
    const hash = shadow.split(":")[1];
    const status = hash.startsWith("!") || hash === "*" ? "L" : hash ? "P" : "NP";
    if (p.flags.has("S") || p.flags.has("status")) return ok(`${name} ${status} ${new Date().toISOString().slice(5, 7)}/${new Date().toISOString().slice(8, 10)}/${new Date().getUTCFullYear()} 0 99999 7 -1\n`);
    if (p.flags.has("l") || p.flags.has("u") || p.flags.has("d") || p.flags.has("e")) {
      if (!m.isRoot()) return fail("passwd: Permission denied.");
      await editLines("/etc/shadow", (lines) =>
        lines.map((line) => {
          const f = line.split(":");
          if (f[0] !== name) return line;
          if (p.flags.has("l") && !f[1].startsWith("!")) f[1] = `!${f[1]}`;
          if (p.flags.has("u") && f[1].startsWith("!") && f[1].length > 1) f[1] = f[1].slice(1);
          if (p.flags.has("d")) f[1] = "";
          if (p.flags.has("e")) f[2] = "0";
          return f.join(":");
        }),
      );
      const what = p.flags.has("l") ? "Locking password for user" : p.flags.has("u") ? "Unlocking password for user" : p.flags.has("d") ? "Removing password for user" : "Expiring password for user";
      return ok(`${what} ${name}.\npasswd: Success\n`);
    }
    return fail(`Changing password for ${name}.\n(passwd asks for the new password interactively, which this lab terminal can't do.)\nSet it non-interactively instead:  echo '${name}:NewPassword123' | sudo chpasswd`);
  });

  const chpasswd = command("chpasswd", async (_args, ctx) => {
    if (!m.isRoot()) return fail("chpasswd: Permission denied.\nchpasswd: cannot lock /etc/shadow; try again later.");
    const users = new Set((await readPasswd(fs)).map((u) => u.name));
    let err = "";
    const updates = new Map<string, string>();
    stdinText(ctx)
      .split("\n")
      .filter(Boolean)
      .forEach((line, i) => {
        const [user, ...pw] = line.split(":");
        if (!users.has(user) || !pw.length) err += `chpasswd: (user ${user}) pam_chauthtok() failed, error:\nAuthentication token manipulation error\nchpasswd: (line ${i + 1}, user ${user}) password not changed\n`;
        else updates.set(user, fakeHash(pw.join(":")));
      });
    await editLines("/etc/shadow", (lines) =>
      lines.map((line) => {
        const f = line.split(":");
        if (!updates.has(f[0])) return line;
        f[1] = updates.get(f[0])!;
        f[2] = String(today());
        return f.join(":");
      }),
    );
    return ok("", err, err ? 1 : 0);
  });

  // ---- systemd ---------------------------------------------------------------------------

  const unitName = (s: string) => s.replace(/\.service$/, "");

  async function daemonReload() {
    for (const dir of ["/etc/systemd/system", "/usr/lib/systemd/system"]) {
      for (const file of await fs.inner.readdir(dir).catch(() => [] as string[])) {
        if (!file.endsWith(".service")) continue;
        const name = unitName(file);
        if (state().units[name]) continue;
        const u = parseUnitFile(await fs.inner.readFile(`${dir}/${file}`));
        if (!u.exec) continue;
        const execPath = u.exec.split(/\s+/)[0];
        state().units[name] = {
          description: u.description || name, user: u.user, exec: u.exec, ports: [], mem: 0.4, cpu: 0, unitFile: `${dir}/${file}`,
          enabled: false, active: false, failed: false, since: Date.now(), checks: [{ type: "exec", path: execPath }],
        } satisfies Unit;
      }
    }
  }

  function statusText(name: string, u: Unit) {
    const dot = u.active ? "●" : u.failed ? "×" : "○";
    const active = u.active ? "active (running)" : u.failed ? "failed (Result: exit-code)" : "inactive (dead)";
    const procs = state().procs.filter((p) => p.unit === name);
    let out = `${dot} ${name}.service - ${u.description}\n     Loaded: loaded (${u.unitFile}; ${u.enabled ? "enabled" : "disabled"}; preset: enabled)\n     Active: ${active} since ${longDate(u.since)}; ${relativeTime(u.since)}\n`;
    if (name === "nginx") out += "       Docs: man:nginx(8)\n";
    if (u.active && u.mainPid) {
      const main = procs.find((p) => p.pid === u.mainPid);
      out += `   Main PID: ${u.mainPid} (${main ? comm(main) : name})\n      Tasks: ${procs.length + (name === "webapp" ? 6 : 0)} (limit: 2275)\n     Memory: ${(procs.reduce((s, p) => s + p.rss, 0) / 1024).toFixed(1)}M (peak: ${((procs.reduce((s, p) => s + p.rss, 0) / 1024) * 1.2).toFixed(1)}M)\n        CPU: ${Math.round(1 + u.cpu * 900)}ms\n     CGroup: /system.slice/${name}.service\n`;
      procs.forEach((p, i) => (out += `             ${i === procs.length - 1 ? "└─" : "├─"}${p.pid} "${p.cmd}"\n`));
    } else if (u.failed) out += `    Process: ${state().nextPid - 1} ExecStart=${u.exec} (code=exited, status=1/FAILURE)\n   Main PID: ${state().nextPid - 1} (code=exited, status=1/FAILURE)\n        CPU: 48ms\n`;
    const logs = state().journal.filter((e) => e.unit === name).slice(-10);
    if (logs.length) out += `\n${logs.map((e) => `${syslogTime(e.t)} ${HOSTNAME} ${e.ident}[${e.pid}]: ${e.msg}`).join("\n")}\n`;
    return out;
  }

  const systemctl = command("systemctl", async (args) => {
    const p = parseArgs(args, "tpn", ["type", "state", "lines", "property"]);
    const [action = "list-units", ...names] = p.rest;
    const units = state().units;
    const needsRoot = ["start", "stop", "restart", "reload", "enable", "disable", "daemon-reload", "reload-or-restart", "try-restart", "mask", "unmask"];
    if (needsRoot.includes(action) && !m.isRoot())
      return fail(`Failed to ${action === "daemon-reload" ? "reload daemon" : `${action} ${names[0] ?? ""}${names[0]?.endsWith(".service") ? "" : ".service"}`}: Interactive authentication required.\nSee system logs and 'systemctl status ${unitName(names[0] ?? "UNIT")}.service' for details.`);
    if (action === "daemon-reload") {
      await daemonReload();
      return ok();
    }
    if (action === "list-units" || action === "list-unit-files" || (p.flags.has("failed") && !names.length)) {
      const want = p.flags.has("failed") ? "failed" : p.values.state;
      const rows = Object.entries(units)
        .filter(([, u]) => !want || (want === "failed" ? u.failed : want === "running" || want === "active" ? u.active : want === "inactive" ? !u.active && !u.failed : true))
        .sort(([a], [b]) => a.localeCompare(b));
      if (action === "list-unit-files")
        return ok(`UNIT FILE${" ".repeat(26)}STATE   PRESET\n${rows.map(([n, u]) => `${`${n}.service`.padEnd(35)}${(u.enabled ? "enabled" : "disabled").padEnd(8)}enabled`).join("\n")}\n\n${rows.length} unit files listed.\n`);
      const lines = rows.map(([n, u]) => `${u.failed ? "●" : " "} ${`${n}.service`.padEnd(32)} loaded ${(u.active ? "active" : u.failed ? "failed" : "inactive").padEnd(8)} ${(u.active ? "running" : u.failed ? "failed" : "dead").padEnd(7)} ${u.description}`);
      return ok(`  UNIT${" ".repeat(31)}LOAD   ACTIVE   SUB     DESCRIPTION\n${lines.join("\n")}\n\nLegend: LOAD   → Reflects whether the unit definition was properly loaded.\n        ACTIVE → The high-level unit activation state, i.e. generalization of SUB.\n        SUB    → The low-level unit activation state, values depend on unit type.\n\n${rows.length} loaded units listed.\n`);
    }
    if (!names.length) return fail(`Too few arguments.`);
    let out = "";
    let err = "";
    let code = 0;
    for (const raw of names) {
      const name = unitName(raw);
      const u = units[name];
      if (!u) {
        if (action === "status") {
          err += `Unit ${name}.service could not be found.\n`;
          code = 4;
        } else if (action.startsWith("is-")) {
          out += action === "is-enabled" ? "not-found\n" : "inactive\n";
          code = action === "is-enabled" ? 4 : 3;
        } else {
          err += `Failed to ${action} ${name}.service: Unit ${name}.service not found.\n`;
          code = 5;
        }
        continue;
      }
      switch (action) {
        case "status":
          out += statusText(name, u) + (names.length > 1 ? "\n" : "");
          if (!u.active) code = 3;
          break;
        case "start": {
          const e = await startUnit(state(), fs, name);
          if (e) {
            err += `${e}\n`;
            code = 1;
          }
          break;
        }
        case "stop":
          stopUnit(state(), name);
          break;
        case "restart":
        case "reload-or-restart":
        case "try-restart": {
          if (action === "try-restart" && !u.active) break;
          stopUnit(state(), name);
          const e = await startUnit(state(), fs, name);
          if (e) {
            err += `${e}\n`;
            code = 1;
          }
          break;
        }
        case "reload": {
          if (!u.active) {
            err += `${name}.service is not active, cannot reload.\n`;
            code = 1;
            break;
          }
          if (name === "nginx") {
            const problem = await nginxConfigError(fs);
            if (problem) {
              journal(state(), name, "nginx", u.mainPid ?? 0, `nginx: [emerg] ${problem}`, 3);
              journal(state(), name, "systemd", 1, `nginx.service: Control process exited, code=exited, status=1/FAILURE`, 4);
              journal(state(), name, "systemd", 1, `Reload failed for nginx.service - ${u.description}.`, 3);
              err += `Job for nginx.service failed because the control process exited with error code.\nSee "systemctl status nginx.service" and "journalctl -xeu nginx.service" for details.\n`;
              code = 1;
              break;
            }
          }
          journal(state(), name, "systemd", 1, `Reloading ${name}.service - ${u.description}...`);
          journal(state(), name, "systemd", 1, `Reloaded ${name}.service - ${u.description}.`);
          break;
        }
        case "enable":
        case "disable": {
          const on = action === "enable";
          if (u.enabled !== on) err += on ? `Created symlink /etc/systemd/system/multi-user.target.wants/${name}.service → ${u.unitFile}.\n` : `Removed "/etc/systemd/system/multi-user.target.wants/${name}.service".\n`;
          u.enabled = on;
          if (p.flags.has("now")) {
            if (on) {
              const e = await startUnit(state(), fs, name);
              if (e) {
                err += `${e}\n`;
                code = 1;
              }
            } else stopUnit(state(), name);
          }
          break;
        }
        case "is-active":
          out += `${u.active ? "active" : u.failed ? "failed" : "inactive"}\n`;
          if (!u.active) code = 3;
          break;
        case "is-enabled":
          out += `${u.enabled ? "enabled" : "disabled"}\n`;
          if (!u.enabled) code = 1;
          break;
        case "is-failed":
          out += `${u.failed ? "failed" : u.active ? "active" : "inactive"}\n`;
          if (!u.failed) code = 1;
          break;
        case "cat":
          out += `# ${u.unitFile}\n${(await fs.inner.readFile(u.unitFile).catch(() => "")) || `[Unit]\nDescription=${u.description}\n\n[Service]\nExecStart=${u.exec}\n`}`;
          break;
        case "show":
          out += `Id=${name}.service\nDescription=${u.description}\nLoadState=loaded\nActiveState=${u.active ? "active" : u.failed ? "failed" : "inactive"}\nSubState=${u.active ? "running" : u.failed ? "failed" : "dead"}\nMainPID=${u.mainPid ?? 0}\nUnitFileState=${u.enabled ? "enabled" : "disabled"}\nUser=${u.user}\n`;
          break;
        default:
          return fail(`Unknown command verb '${action}'.`);
      }
    }
    return ok(out, err, code);
  });

  const service = command("service", async (args, ctx) => {
    if (args[0] === "--status-all") return ok(Object.entries(state().units).sort(([a], [b]) => a.localeCompare(b)).map(([n, u]) => ` [ ${u.active ? "+" : "-"} ]  ${n}\n`).join(""));
    const [name, action] = args;
    if (!name || !action) return fail("Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]");
    return ctx.exec!(`systemctl ${action} ${name}`, { cwd: ctx.cwd });
  });

  const journalctl = command("journalctl", async (args) => {
    const p = parseArgs(args, "unpbtS", ["unit", "lines", "priority", "since", "until", "identifier", "output"]);
    const now = Date.now();
    if (p.flags.has("disk-usage")) return ok("Archived and active journals take up 24.0M in the file system.\n");
    const units = [...(p.multi.u ?? []), ...(p.multi.unit ?? [])].map(unitName);
    const pri = p.values.p ?? p.values.priority;
    const max = pri === undefined ? 7 : /^\d$/.test(pri) ? Number(pri) : PRIORITIES[pri.toLowerCase()];
    if (max === undefined) return fail(`Failed to parse priority value: ${pri}`);
    const sinceText = p.values.S ?? p.values.since;
    const since = sinceText ? parseSince(sinceText, now) : undefined;
    if (sinceText && since === undefined) return fail(`Failed to parse timestamp: ${sinceText}`);
    const until = p.values.until ? parseSince(p.values.until, now) : undefined;
    const ident = p.values.t ?? p.values.identifier;
    let entries = state().journal.filter((e) => (!units.length || units.includes(e.unit)) && e.pri <= max && (!since || e.t >= since) && (!until || e.t <= until) && (!ident || e.ident === ident));
    if (p.flags.has("k") || p.flags.has("dmesg")) entries = entries.filter((e) => e.ident === "kernel");
    entries.sort((a, b) => a.t - b.t);
    const nText = p.values.n ?? p.values.lines;
    if (nText !== undefined) entries = entries.slice(-Math.max(0, Number(nText) || 10));
    else if (p.flags.has("e") || p.flags.has("f") || p.flags.has("follow")) entries = entries.slice(-(p.flags.has("f") || p.flags.has("follow") ? 10 : 1000));
    if (p.flags.has("r") || p.flags.has("reverse")) entries.reverse();
    const cat = p.values.o === "cat" || p.values.output === "cat";
    const out = entries.map((e) => (cat ? e.msg : `${syslogTime(e.t)} ${HOSTNAME} ${e.ident}[${e.pid}]: ${e.msg}`)).join("\n");
    const follow = p.flags.has("f") || p.flags.has("follow") ? "(journalctl -f keeps following new entries until Ctrl+C in a real terminal; this lab shows the latest ones)\n" : "";
    return ok(out ? `${out}\n` : "-- No entries --\n", follow);
  });

  const crontab = command("crontab", async (args, ctx) => {
    const p = parseArgs(args, "u");
    const user = p.values.u ?? m.user.user;
    if (p.values.u && p.values.u !== m.user.user && !m.isRoot()) return fail("must be privileged to use -u");
    if (!(await readPasswd(fs)).some((u) => u.name === user)) return fail(`crontab: user '${user}' unknown`);
    const file = `/var/spool/cron/crontabs/${user}`;
    if (p.flags.has("l")) {
      const text = await fs.inner.readFile(file).catch(() => undefined);
      return text === undefined ? fail(`no crontab for ${user}`) : ok(text);
    }
    if (p.flags.has("r")) {
      if (!(await fs.inner.exists(file))) return fail(`no crontab for ${user}`);
      await fs.inner.rm(file);
      return ok();
    }
    if (p.flags.has("e"))
      return fail(`crontab -e opens an editor, which this lab terminal can't do.\nAdd a line instead:\n  (crontab -l 2>/dev/null; echo '0 2 * * * /home/student/scripts/backup.sh') | crontab -\nor write a file and install it:  crontab mycron.txt`);
    const source = p.rest[0];
    if (!source) return fail(`usage:\tcrontab [-u user] file\n\tcrontab [-u user] [ -e | -l | -r ]\n\t\t(default operation is replace, per 1003.2)`);
    let text: string;
    if (source === "-") text = stdinText(ctx);
    else
      try {
        text = await fs.readFile(normalizePath(ctx.cwd, source));
      } catch {
        return fail(`${source}: No such file or directory`);
      }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const e = cronLineError(lines[i]);
      if (e) return fail(`"${source === "-" ? "-" : source}":${i + 1}: ${e}\nerrors in crontab file, can't install.`);
    }
    await fs.inner.writeFile(file, text.endsWith("\n") || !text ? text : `${text}\n`);
    await fs.inner.chmod(file, 0o600);
    fs.setOwner(file, [user, "crontab"]);
    return ok();
  });

  const nginx = command("nginx", async (args) => {
    const p = parseArgs(args, "sgcp");
    if (p.flags.has("v")) return ok("", "nginx version: nginx/1.24.0 (Ubuntu)\n");
    if (p.flags.has("V")) return ok("", "nginx version: nginx/1.24.0 (Ubuntu)\nbuilt with OpenSSL 3.0.13 30 Jan 2024\nTLS SNI support enabled\n");
    if (p.flags.has("t") || p.flags.has("T")) {
      const problem = await nginxConfigError(fs);
      const warn = m.isRoot() ? "" : `nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)\n`;
      if (problem) return ok("", `${warn}nginx: [emerg] ${problem}\nnginx: configuration file /etc/nginx/nginx.conf test failed\n`, 1);
      let dump = "";
      if (p.flags.has("T")) {
        dump += `# configuration file /etc/nginx/nginx.conf:\n${await fs.inner.readFile("/etc/nginx/nginx.conf")}\n`;
        for (const f of await fs.inner.readdir("/etc/nginx/sites-enabled").catch(() => [] as string[])) dump += `# configuration file /etc/nginx/sites-enabled/${f}:\n${await fs.inner.readFile(`/etc/nginx/sites-enabled/${f}`)}\n`;
      }
      return ok(dump, `${warn}nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n`);
    }
    if (p.values.s) {
      if (!m.isRoot()) return fail(`nginx: [alert] kill(812, 1) failed (1: Operation not permitted)`);
      const u = state().units.nginx;
      if (!u.active) return fail(`nginx: [error] invalid PID number "" in "/run/nginx.pid"`);
      if (p.values.s === "stop" || p.values.s === "quit") stopUnit(state(), "nginx");
      else if (p.values.s === "reload") {
        const problem = await nginxConfigError(fs);
        if (problem) return fail(`nginx: [emerg] ${problem}`);
        journal(state(), "nginx", "systemd", 1, "nginx.service: Reloading.");
      }
      return ok();
    }
    if (state().units.nginx.active) return fail("nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)\nnginx: [emerg] still could not bind()");
    if (!m.isRoot()) return fail(`nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)`);
    const e = await startUnit(state(), fs, "nginx");
    return e ? fail(e) : ok();
  });

  // ---- setup-only helpers (exercise authors) ---------------------------------------------

  const labProc = command("lab-proc", async (args) => {
    if (!m.setupMode) return fail("bash: lab-proc: command not found", 127);
    // --age SECONDS: how long ago it started (an hour unless said otherwise)
    const p = parseArgs(args, "", ["user", "cpu", "mem", "port", "cwd", "age"]);
    const cmd = p.rest.join(" ");
    if (!cmd) return fail("lab-proc: missing command");
    const proc = spawn(state(), {
      ppid: 1, user: p.values.user ?? "root", cmd, cpu: Number(p.values.cpu ?? 0), mem: Number(p.values.mem ?? 0.2),
      rss: Math.round(1956000 * (Number(p.values.mem ?? 0.2) / 100)), ports: p.values.port ? p.values.port.split(",").map(Number) : undefined,
      stubborn: p.flags.has("stubborn"), cwd: p.values.cwd, start: Date.now() - Number(p.values.age ?? 3600) * 1000,
    });
    return ok(`${proc.pid}\n`);
  });

  // lab-journal UNIT PRIORITY [--ago SECONDS] MESSAGE…: an entry in the past keeps the journal in time order
  const labJournal = command("lab-journal", async (args) => {
    if (!m.setupMode) return fail("bash: lab-journal: command not found", 127);
    const [unit, pri, ...rest] = args;
    const ago = rest[0] === "--ago" ? Number(rest[1]) : 0;
    const msg = rest[0] === "--ago" ? rest.slice(2) : rest;
    if (!unit || !msg.length) return fail("lab-journal: usage: lab-journal UNIT PRIORITY [--ago SECONDS] MESSAGE");
    const u = state().units[unit];
    journal(state(), unit, unit === "webapp" ? "node" : unit, u?.mainPid ?? SHELL_PID, msg.join(" "), PRIORITIES[pri] ?? (Number(pri) || 6), Date.now() - ago * 1000);
    state().journal.sort((a, b) => a.t - b.t);
    return ok();
  });

  /** Fills the root file system to PERCENT (default 100) with one realistic, mostly virtual log file. */
  const labFill = command("lab-fill", async (args) => {
    if (!m.setupMode) return fail("bash: lab-fill: command not found", 127);
    const [path, pct = "100"] = args;
    if (!path) return fail("lab-fill: usage: lab-fill FILE [PERCENT]");
    const root = state().devices.find((d) => d.mountpoint === "/")!;
    const used = await deviceUsage(state(), fs, root);
    const add = Math.max(0, Math.floor((ROOT_CAPACITY * Number(pct)) / 100 - used));
    const line = `${new Date().toISOString()} DEBUG [sql] SELECT * FROM orders WHERE customer_id = $1 -- plan: Seq Scan on orders (cost=0.00..18334.00 rows=5 width=97)\n`;
    await fs.inner.writeFile(path, line.repeat(200));
    fs.meta.sizes[path] = Math.max(add, line.length * 200);
    return ok();
  });

  /** Sets modification times DAYS days in the past: `lab-age 10 /path/a /path/b`. */
  const labAge = command("lab-age", async (args, ctx) => {
    if (!m.setupMode) return fail("bash: lab-age: command not found", 127);
    const [days, ...paths] = args;
    const when = new Date(Date.now() - Number(days) * 86400_000);
    for (const p of paths) await fs.inner.utimes(normalizePath(ctx.cwd, p), when, when);
    return ok();
  });

  /**
   * For probes and setup. `lab-unit NAME` → `active=1 enabled=1 failed=0 since=<epoch seconds>`.
   * `lab-unit NAME stop|start|restart|enable|disable [--ago SECONDS]` does it as if SECONDS ago, so a
   * setup's journal and the unit's "since" agree with the incident's story.
   */
  const labUnit = command("lab-unit", async (args) => {
    if (!m.setupMode) return fail("bash: lab-unit: command not found", 127);
    const [name = "", action, flag, seconds] = args;
    const u = state().units[name];
    if (!u) return fail(`lab-unit: no unit ${name}`);
    if (action) {
      const ago = flag === "--ago" ? Number(seconds) * 1000 : 0;
      const from = state().journal.length;
      if (action === "stop" || action === "restart") stopUnit(state(), name);
      if (action === "start" || action === "restart") await startUnit(state(), fs, name);
      if (action === "enable" || action === "disable") u.enabled = action === "enable";
      for (const entry of state().journal.slice(from)) entry.t -= ago;
      u.since -= ago;
      state().journal.sort((a, b) => a.t - b.t);
    }
    return ok(`active=${u.active ? 1 : 0} enabled=${u.enabled ? 1 : 0} failed=${u.failed ? 1 : 0} since=${Math.floor(u.since / 1000)}\n`);
  });

  return [sudo, su, useradd, adduser, usermod, userdel, groupadd, groupdel, gpasswd, passwd, chpasswd, systemctl, service, journalctl, crontab, nginx, labProc, labJournal, labFill, labAge, labUnit];
}
