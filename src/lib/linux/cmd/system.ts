import { randomUUID } from "node:crypto";
import type { Machine } from "../machine.ts";
import type { Device } from "../system.ts";
import { GiB, HOSTNAME, MEM_TOTAL_KB, MiB, ROOT_CAPACITY, deviceUsage, hhmm, human, identityOf, mountOf, normalizePath, readGroups } from "../system.ts";
import { command, fail, ok, parseArgs } from "./util.ts";

const KERNEL = "6.8.0-1012-aws";

export function loadAverage(m: Machine) {
  const cpu = m.state.procs.reduce((s, p) => s + p.cpu, 0) / 100;
  const l1 = 0.06 + cpu;
  return [l1, l1 * 0.85 + 0.03, l1 * 0.6 + 0.05].map((x) => x.toFixed(2));
}

export function uptimeText(m: Machine, now = Date.now()) {
  const mins = Math.floor((now - m.state.bootTime) / 60000);
  const days = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const mm = mins % 60;
  return `${days ? `${days} day${days > 1 ? "s" : ""}, ` : ""}${h ? `${String(h).padStart(2)}:${String(mm).padStart(2, "0")}` : `${mm} min`}`;
}

export function memory(m: Machine) {
  const used = m.state.procs.reduce((s, p) => s + p.rss, 0) + 118_000;
  const cache = 739_448;
  const free = Math.max(0, MEM_TOTAL_KB - used - cache);
  return { total: MEM_TOTAL_KB, used, free, shared: 1_024, cache, available: Math.round(free + cache * 0.85) };
}

/** Size reported by df for a device (ext4 keeps ~5% for metadata and reserved blocks). */
export const fsSize = (d: Device) => (d.mountpoint === "/" ? ROOT_CAPACITY : d.fstype === "xfs" ? d.size * 0.995 : d.size * 0.98);

export function systemCommands(m: Machine) {
  const fs = m.fs;

  const whoami = command("whoami", async () => ok(`${m.user.user}\n`));

  const id = command("id", async (args) => {
    const p = parseArgs(args);
    const target = p.rest[0] ? await identityOf(fs, p.rest[0]) : m.user;
    if (!target) return fail(`id: '${p.rest[0]}': no such user`);
    const groups = await readGroups(fs);
    const gid = (name: string) => groups.find((g) => g.name === name)?.gid ?? 0;
    const names = p.flags.has("n");
    if (p.flags.has("u")) return ok(`${names ? target.user : target.uid}\n`);
    if (p.flags.has("g")) return ok(`${names ? target.group : gid(target.group)}\n`);
    if (p.flags.has("G")) return ok(`${target.groups.map((g) => (names ? g : gid(g))).join(" ")}\n`);
    return ok(`uid=${target.uid}(${target.user}) gid=${gid(target.group)}(${target.group}) groups=${target.groups.map((g) => `${gid(g)}(${g})`).join(",")}\n`);
  });

  const groupsCmd = command("groups", async (args) => {
    const users = args.length ? args : [m.user.user];
    let out = "";
    for (const u of users) {
      const ident = await identityOf(fs, u);
      if (!ident) return fail(`groups: '${u}': no such user`);
      out += `${args.length ? `${u} : ` : ""}${ident.groups.join(" ")}\n`;
    }
    return ok(out);
  });

  const hostname = command("hostname", async (args) => {
    const p = parseArgs(args);
    if (p.rest.length) return m.isRoot() ? fail("hostname: changing the host name is not supported in this lab") : fail("hostname: you must be root to change the host name");
    if (p.flags.has("I") || p.flags.has("all-ip-addresses")) return ok("10.0.1.23 \n");
    if (p.flags.has("i")) return ok("10.0.1.23\n");
    if (p.flags.has("f") || p.flags.has("fqdn")) return ok(`${HOSTNAME}.ec2.internal\n`);
    if (p.flags.has("d")) return ok("ec2.internal\n");
    return ok(`${HOSTNAME}\n`);
  });

  const uname = command("uname", async (args) => {
    const f = parseArgs(args).flags;
    const parts: Record<string, string> = { s: "Linux", n: HOSTNAME, r: KERNEL, v: "#13-Ubuntu SMP Mon Jul 15 13:40:27 UTC 2024", m: "x86_64", p: "x86_64", i: "x86_64", o: "GNU/Linux" };
    const order = f.has("a") || f.has("all") ? "snrvmpio".split("") : "snrvmpio".split("").filter((k) => f.has(k));
    return ok(`${(order.length ? order : ["s"]).map((k) => parts[k]).join(" ")}\n`);
  });

  const uptime = command("uptime", async (args) => {
    const f = parseArgs(args).flags;
    const now = Date.now();
    if (f.has("s") || f.has("since")) return ok(`${new Date(m.state.bootTime).toISOString().slice(0, 19).replace("T", " ")}\n`);
    if (f.has("p") || f.has("pretty")) {
      const mins = Math.floor((now - m.state.bootTime) / 60000);
      const d = Math.floor(mins / 1440);
      const h = Math.floor((mins % 1440) / 60);
      return ok(`up ${d} day${d === 1 ? "" : "s"}, ${h} hour${h === 1 ? "" : "s"}, ${mins % 60} minutes\n`);
    }
    const t = new Date(now).toISOString().slice(11, 19);
    return ok(` ${t} up ${uptimeText(m, now)},  1 user,  load average: ${loadAverage(m).join(", ")}\n`);
  });

  const free = command("free", async (args) => {
    const f = parseArgs(args).flags;
    const mem = memory(m);
    const hum = (kb: number) => {
      if (kb === 0) return "0B";
      const units = ["Ki", "Mi", "Gi"];
      let v = kb;
      let i = 0;
      while (v >= 1024 && i < 2) {
        v /= 1024;
        i++;
      }
      return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
    };
    const conv = f.has("h") || f.has("human") ? hum : f.has("g") ? (kb: number) => String(Math.floor(kb / 1048576)) : f.has("m") ? (kb: number) => String(Math.floor(kb / 1024)) : f.has("b") ? (kb: number) => String(kb * 1024) : (kb: number) => String(kb);
    const row = (label: string, vals: number[]) => label.padEnd(7) + vals.map((v) => conv(v).padStart(12)).join("");
    return ok(
      `${"".padEnd(7)}${["total", "used", "free", "shared", "buff/cache", "available"].map((h) => h.padStart(12)).join("")}\n` +
        `${row("Mem:", [mem.total, mem.used, mem.free, mem.shared, mem.cache, mem.available])}\n${row("Swap:", [0, 0, 0])}\n`,
    );
  });

  const nproc = command("nproc", async () => ok("2\n"));

  const lscpu = command("lscpu", async () =>
    ok(
      "Architecture:             x86_64\n  CPU op-mode(s):         32-bit, 64-bit\n  Byte Order:             Little Endian\nCPU(s):                   2\n  On-line CPU(s) list:    0,1\nVendor ID:                GenuineIntel\n  Model name:             Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz\n    Thread(s) per core:   2\n    Core(s) per socket:   1\n    Socket(s):            1\nVirtualization features:\n  Hypervisor vendor:      KVM\n  Virtualization type:    full\n",
    ),
  );

  const loginAt = () => Date.now() - 3 * 3600_000;
  const who = command("who", async () => ok(`student  pts/0        ${new Date(loginAt()).toISOString().slice(0, 16).replace("T", " ")} (203.0.113.50)\n`));
  const w = command("w", async () =>
    ok(
      ` ${new Date().toISOString().slice(11, 19)} up ${uptimeText(m)},  1 user,  load average: ${loadAverage(m).join(", ")}\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU  WHAT\nstudent  pts/0    203.0.113.50     ${hhmm(loginAt())}    0.00s  0.05s  0.00s w\n`,
    ),
  );
  const last = command("last", async () => {
    const d = (t: number) => new Date(t).toUTCString().replace(/^(\w+), (\d+) (\w+) \d+ (\d+:\d+):\d+ GMT$/, (_, wd, dd, mon, hm) => `${wd} ${mon} ${dd.padStart(2)} ${hm}`);
    const deploy = Date.now() - 26 * 3600_000;
    return ok(
      `student  pts/0        203.0.113.50     ${d(loginAt())}   still logged in\ndeploy   pts/0        10.0.1.50        ${d(deploy)} - ${hhmm(deploy + 16 * 60_000)}  (00:16)\nreboot   system boot  ${KERNEL}   ${d(m.state.bootTime)}   still running\n\nwtmp begins ${new Date(m.state.bootTime).toUTCString()}\n`,
    );
  });

  const df = command("df", async (args, ctx) => {
    const p = parseArgs(args, "t", ["type", "output"]);
    const f = p.flags;
    const hum = f.has("h") || f.has("human-readable") || f.has("H");
    const showType = f.has("T") || f.has("print-type");
    const inodes = f.has("i") || f.has("inodes");
    type Row = { fs: string; type: string; size: number; used: number; mount: string };
    const rows: Row[] = [];
    const real = m.state.devices.filter((d) => d.mountpoint);
    for (const d of real) {
      const dev = d.mountpoint === "/" ? "/dev/root" : `/dev/${d.name}`;
      rows.push({ fs: dev, type: d.fstype ?? "?", size: fsSize(d), used: await deviceUsage(m.state, fs, d) + (d.fstype === "xfs" ? 175 * MiB : 0), mount: d.mountpoint! });
    }
    rows.push(
      { fs: "tmpfs", type: "tmpfs", size: 194 * MiB, used: 1.1 * MiB, mount: "/run" },
      { fs: "tmpfs", type: "tmpfs", size: 967 * MiB, used: 0, mount: "/dev/shm" },
      { fs: "tmpfs", type: "tmpfs", size: 5 * MiB, used: 0, mount: "/run/lock" },
      { fs: "tmpfs", type: "tmpfs", size: 194 * MiB, used: 12 * 1024, mount: "/run/user/1001" },
    );
    rows.sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : 0));
    let selected = rows;
    let err = "";
    if (p.rest.length) {
      selected = [];
      for (const t of p.rest) {
        const path = normalizePath(ctx.cwd, t);
        if (!(await fs.inner.exists(path))) {
          err += `df: ${t}: No such file or directory\n`;
          continue;
        }
        const dev = mountOf(m.state, path);
        const row = rows.find((r) => r.mount === dev?.mountpoint) ?? rows[0];
        if (!selected.includes(row)) selected.push(row);
      }
    }
    if (p.values.t || p.values.type) selected = selected.filter((r) => r.type === (p.values.t ?? p.values.type));
    const pct = (used: number, size: number) => (size ? `${Math.ceil((used / size) * 100)}%` : "-");
    const table: string[][] = [
      inodes
        ? ["Filesystem", ...(showType ? ["Type"] : []), "Inodes", "IUsed", "IFree", "IUse%", "Mounted on"]
        : ["Filesystem", ...(showType ? ["Type"] : []), hum ? "Size" : "1K-blocks", "Used", hum ? "Avail" : "Available", "Use%", "Mounted on"],
    ];
    for (const r of selected) {
      // a filesystem never reports more used than its size, however much lab-fill wrote
      const usedBytes = Math.min(r.used, r.size);
      const avail = r.size - usedBytes;
      if (inodes) {
        const total = Math.round(r.size / 16384);
        const used = Math.round(r.used / 32768);
        table.push([r.fs, ...(showType ? [r.type] : []), String(total), String(used), String(total - used), pct(used, total), r.mount]);
      } else {
        const fmt = (n: number) => (hum ? (n === 0 ? "0" : human(n)) : String(Math.round(n / 1024)));
        table.push([r.fs, ...(showType ? [r.type] : []), fmt(r.size), fmt(usedBytes), fmt(avail), pct(usedBytes, r.size), r.mount]);
      }
    }
    const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
    const out = table
      .map((r, ri) => r.map((c, i) => (i === r.length - 1 ? c : i === 0 || (showType && i === 1) ? c.padEnd(widths[i]) : ri === 0 ? c.padStart(widths[i]) : c.padStart(widths[i]))).join(" "))
      .join("\n");
    return ok(`${out}\n`, err, err ? 1 : 0);
  });

  const lsblk = command("lsblk", async (args) => {
    const p = parseArgs(args, "o", ["output"]);
    const fsMode = p.flags.has("f") || p.flags.has("fs");
    const only = p.rest.map((d) => d.replace(/^\/dev\//, ""));
    const devices = m.state.devices.filter((d) => !only.length || only.includes(d.name) || only.includes(d.parent ?? ""));
    const name = (d: Device) => {
      if (!d.parent) return d.name;
      const siblings = devices.filter((x) => x.parent === d.parent);
      return `${siblings.at(-1) === d ? "└─" : "├─"}${d.name}`;
    };
    const size = (b: number) => (b >= GiB ? `${+(b / GiB).toFixed(1)}G` : `${Math.round(b / MiB)}M`);
    const rows = fsMode
      ? [["NAME", "FSTYPE", "FSVER", "LABEL", "UUID", "FSAVAIL", "FSUSE%", "MOUNTPOINTS"]]
      : [["NAME", "MAJ:MIN", "RM", "SIZE", "RO", "TYPE", "MOUNTPOINTS"]];
    for (const [i, d] of devices.entries()) {
      if (fsMode) {
        const used = d.mountpoint ? await deviceUsage(m.state, fs, d) : 0;
        const ver = d.fstype === "ext4" ? "1.0" : d.fstype === "vfat" ? "FAT32" : d.fstype === "xfs" ? "" : "";
        rows.push([name(d), d.fstype ?? "", ver, d.label ?? "", d.uuid ?? "", d.mountpoint ? human(fsSize(d) - used) : "", d.mountpoint ? `${Math.ceil((used / fsSize(d)) * 100)}%` : "", d.mountpoint ?? ""]);
      } else rows.push([name(d), `259:${i}`, "0", size(d.size), "0", d.type, d.mountpoint ?? ""]);
    }
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return ok(rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : fsMode || i !== 3 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(" ").trimEnd()).join("\n") + "\n");
  });

  const blkid = command("blkid", async (args) => {
    const devs = m.state.devices.filter((d) => d.fstype && (!args.length || args.includes(`/dev/${d.name}`)));
    if (!devs.length) return ok("", "", 2);
    return ok(devs.map((d) => `/dev/${d.name}: ${d.label ? `LABEL="${d.label}" ` : ""}UUID="${d.uuid}" BLOCK_SIZE="${d.fstype === "vfat" ? 512 : 4096}" TYPE="${d.fstype}"\n`).join(""));
  });

  const mkfs = (name: string, forced?: string) =>
    command(name, async (args) => {
      const p = parseArgs(args, "tL", ["type"]);
      const type = forced ?? p.values.t ?? p.values.type ?? "ext2";
      const target = p.rest[0];
      const tool = `mkfs.${type}`;
      if (!target) return fail(`${tool}: no device specified`);
      const d = m.state.devices.find((x) => `/dev/${x.name}` === target);
      if (!d) return fail(`${tool}: cannot open ${target}: No such file or directory`);
      if (!m.isRoot()) return fail(`${tool}: cannot open ${target}: Permission denied`);
      if (d.mountpoint) return fail(`${tool}: ${target} contains a mounted filesystem`);
      if (d.type === "disk" && m.state.devices.some((x) => x.parent === d.name)) return fail(`${tool}: ${target} is partitioned; refusing to format the whole disk`);
      if (d.fstype && type === "xfs" && !p.flags.has("f"))
        return fail(`${tool}: ${target} appears to contain an existing filesystem (${d.fstype}).\n${tool}: Use the -f option to force overwrite.`);
      if (!["xfs", "ext4", "ext3", "ext2"].includes(type)) return fail(`mkfs: failed to execute ${tool}: No such file or directory`);
      d.fstype = type;
      d.uuid = randomUUID();
      if (p.values.L) d.label = p.values.L;
      const blocks = Math.floor(d.size / 4096);
      return ok(
        type === "xfs"
          ? `meta-data=${target}           isize=512    agcount=4, agsize=${blocks / 4} blks\n         =                       sectsz=512   attr=2, projid32bit=1\ndata     =                       bsize=4096   blocks=${blocks}, imaxpct=25\nnaming   =version 2              bsize=4096   ascii-ci=0, ftype=1\nlog      =internal log           bsize=4096   blocks=16384, version=2\nrealtime =none                   extsz=4096   blocks=0, rtextents=0\n`
          : `mke2fs 1.47.0 (5-Feb-2023)\nCreating filesystem with ${blocks} 4k blocks and ${blocks / 4} inodes\nFilesystem UUID: ${d.uuid}\nAllocating group tables: done\nWriting inode tables: done\nCreating journal (131072 blocks): done\nWriting superblocks and filesystem accounting information: done\n`,
      );
    });

  async function mountOne(dev: Device, dir: string): Promise<string | undefined> {
    if (!dev.fstype) return `mount: ${dir}: wrong fs type, bad option, bad superblock on /dev/${dev.name}, missing codepage or helper program, or other error.\n       dmesg(1) may have more information after failed mount system call.`;
    if (!(await fs.inner.exists(dir))) return `mount: ${dir}: mount point does not exist.`;
    if (dev.mountpoint) return `mount: ${dir}: /dev/${dev.name} already mounted on ${dev.mountpoint}.`;
    dev.mountpoint = dir;
    return undefined;
  }

  const findDevice = (spec: string) =>
    m.state.devices.find((d) => spec === `/dev/${d.name}` || spec === `UUID=${d.uuid}` || spec === `UUID="${d.uuid}"` || (d.label && spec === `LABEL=${d.label}`));

  const mount = command("mount", async (args, ctx) => {
    const p = parseArgs(args, "to", ["types", "options"]);
    if (!p.rest.length && !p.flags.has("a")) {
      const lines = m.state.devices
        .filter((d) => d.mountpoint)
        .map((d) => `/dev/${d.name} on ${d.mountpoint} type ${d.fstype} (${d.fstype === "ext4" ? "rw,relatime,discard,errors=remount-ro,commit=30" : d.fstype === "vfat" ? "rw,relatime,fmask=0077,dmask=0077" : "rw,relatime,attr2,inode64,noquota"})`);
      return ok(`${[...lines, "proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)", "sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)", "tmpfs on /run type tmpfs (rw,nosuid,nodev,noexec,relatime,size=198660k,mode=755)", "tmpfs on /run/user/1001 type tmpfs (rw,nosuid,nodev,relatime,size=198656k,mode=700,uid=1001,gid=1001)"].join("\n")}\n`);
    }
    if (!m.isRoot()) return fail("mount: only root can do that.", 1);
    if (p.flags.has("a")) {
      const fstab = (await fs.inner.readFile("/etc/fstab").catch(() => "")).split("\n");
      let err = "";
      for (const line of fstab) {
        const [spec, dir, type] = line.replace(/#.*/, "").trim().split(/\s+/);
        if (!spec || !dir || type === "swap") continue;
        const dev = findDevice(spec);
        if (!dev) {
          err += `mount: ${dir}: can't find ${spec}.\n`;
          continue;
        }
        if (dev.mountpoint === dir) continue;
        if (type && type !== "auto" && dev.fstype && type !== dev.fstype) {
          err += `mount: ${dir}: wrong fs type, bad option, bad superblock on /dev/${dev.name}.\n`;
          continue;
        }
        const e = await mountOne(dev, dir);
        if (e) err += `${e}\n`;
      }
      return ok("", err, err ? 32 : 0);
    }
    const [spec, dirArg] = p.rest;
    if (!dirArg) return fail(`mount: ${spec}: can't find in /etc/fstab.`, 1);
    const dev = findDevice(spec);
    if (!dev) return fail(`mount: ${normalizePath(ctx.cwd, dirArg)}: special device ${spec} does not exist.`, 32);
    const e = await mountOne(dev, normalizePath(ctx.cwd, dirArg));
    return e ? fail(e, 32) : ok();
  });

  const umount = command("umount", async (args, ctx) => {
    const target = parseArgs(args).rest[0];
    if (!target) return fail("umount: bad usage");
    if (!m.isRoot()) return fail(`umount: ${target}: must be superuser to unmount.`, 32);
    const dir = target.startsWith("/dev/") ? target : normalizePath(ctx.cwd, target);
    const dev = m.state.devices.find((d) => d.mountpoint && (d.mountpoint === dir || `/dev/${d.name}` === dir));
    if (!dev) return fail(`umount: ${target}: not mounted.`, 32);
    if (dev.mountpoint === "/") return fail("umount: /: target is busy.", 32);
    if (normalizePath("/", ctx.cwd).startsWith(dev.mountpoint!)) return fail(`umount: ${dev.mountpoint}: target is busy.`, 32);
    dev.mountpoint = undefined;
    return ok();
  });

  const history = command("history", async (args) => {
    const p = parseArgs(args);
    if (p.flags.has("c")) {
      m.state.history = [];
      return ok();
    }
    const n = Number(p.rest[0] ?? 0);
    const all = m.state.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`);
    return ok(`${(n ? all.slice(-n) : all).join("\n")}\n`);
  });

  const python = (name: string) =>
    command(name, async (args) => {
      if (args[0] === "--version" || args[0] === "-V") return ok("Python 3.12.3\n");
      if (args[0] === "-m" && args[1] === "http.server")
        return ok(
          `Serving HTTP on 0.0.0.0 port ${args[2] ?? 8000} (http://0.0.0.0:${args[2] ?? 8000}/) ...\n`,
          `(A server keeps running until you press Ctrl+C, which would block this terminal.\n Start it in the background instead: ${name} -m http.server ${args[2] ?? 8000} &)\n`,
        );
      return fail(`${name}: running Python code is not supported in this lab terminal (only the shell is simulated).`);
    });

  const node = command("node", async (args) =>
    args[0] === "--version" || args[0] === "-v" ? ok("v18.19.1\n") : fail("node: running JavaScript is not supported in this lab terminal. Start long-running servers in the background with &."),
  );

  const watch = command("watch", async (args, ctx) => {
    const p = parseArgs(args, "n", ["interval"]);
    const cmd = p.rest.join(" ");
    if (!cmd) return fail("Usage:\n watch [options] command");
    const r = await ctx.exec!(cmd, { cwd: ctx.cwd });
    return ok(`Every ${Number(p.values.n ?? 2).toFixed(1)}s: ${cmd}    ${HOSTNAME}: ${new Date().toUTCString()}\n\n${r.stdout}`, `${r.stderr}(watch repeats the command until Ctrl+C in a real terminal; this lab shows one run)\n`, r.exitCode);
  });

  const usersList = command("users", async () => ok("student\n"));

  return [
    whoami, id, groupsCmd, hostname, uname, uptime, free, nproc, lscpu, who, w, last, df, lsblk, blkid,
    mkfs("mkfs"), mkfs("mkfs.xfs", "xfs"), mkfs("mkfs.ext4", "ext4"), mount, umount, history,
    python("python3"), python("python"), node, watch, usersList,
  ];
}

