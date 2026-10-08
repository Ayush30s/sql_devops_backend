import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type { FsStat } from "just-bash";
import type { Machine } from "../machine.ts";
import { human, normalizePath, parseSize, readGroups, readPasswd } from "../system.ts";
import { HELP, manPage } from "./help.ts";
import type { Ctx } from "./util.ts";
import { command, fail, ok, parseArgs, quoteArgs, stdinText } from "./util.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function modeString(st: FsStat) {
  const m = st.mode;
  const type = st.isSymbolicLink ? "l" : st.isDirectory ? "d" : "-";
  const rwx = (bits: number, special: boolean, ch: string) =>
    (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (special ? (bits & 1 ? ch : ch.toUpperCase()) : bits & 1 ? "x" : "-");
  return type + rwx(m >> 6, !!(m & 0o4000), "s") + rwx(m >> 3, !!(m & 0o2000), "s") + rwx(m, !!(m & 0o1000), "t");
}

function lsDate(t: Date) {
  const sixMonths = 182 * 86400_000;
  const day = String(t.getUTCDate()).padStart(2, " ");
  const recent = Math.abs(Date.now() - t.getTime()) < sixMonths;
  const tail = recent ? `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}` : ` ${t.getUTCFullYear()}`;
  return `${MONTHS[t.getUTCMonth()]} ${day} ${tail}`;
}

const blocksKb = (size: number) => Math.ceil(size / 4096) * 4;

function globToRegex(glob: string) {
  return new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
}

// ---- zip -----------------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Uint8Array;
  mtime: Date;
}

function dos(d: Date) {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function buildZip(entries: ZipEntry[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const isDir = e.name.endsWith("/");
    const deflated = isDir ? Buffer.alloc(0) : deflateRawSync(e.data);
    const useDeflate = !isDir && deflated.length < e.data.length;
    const body = useDeflate ? deflated : Buffer.from(e.data);
    const crc = isDir ? 0 : crc32(e.data);
    const { time, date } = dos(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((isDir ? 0o40755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function readZip(buf: Buffer): ZipEntry[] | undefined {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) return undefined;
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return undefined;
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    const mtime = new Date(Date.UTC((date >> 9) + 1980, ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2));
    out.push({ name, data: new Uint8Array(data), mtime });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function fileCommands(m: Machine) {
  const fs = m.fs;
  const abs = (ctx: Ctx, p: string) => normalizePath(ctx.cwd, p);

  async function names(kind: "passwd" | "group") {
    return kind === "passwd" ? new Map((await readPasswd(fs)).map((p) => [p.name, p.uid])) : new Map((await readGroups(fs)).map((g) => [g.name, g.gid]));
  }

  async function walk(path: string): Promise<string[]> {
    const out = [path];
    const st = await fs.inner.lstat(path);
    if (st.isDirectory) for (const child of (await fs.inner.readdir(path)).sort()) out.push(...(await walk(`${path === "/" ? "" : path}/${child}`)));
    return out;
  }

  const ls = command("ls", async (args, ctx) => {
    const p = parseArgs(args, "", ["color", "sort", "time-style", "hide", "ignore"]);
    const f = p.flags;
    const all = f.has("a") || f.has("all");
    const almost = f.has("A") || f.has("almost-all");
    const long = f.has("l") || f.has("n") || f.has("g") || f.has("o");
    const humanSizes = f.has("h") || f.has("human-readable");
    const numeric = f.has("n");
    const dirsAsFiles = f.has("d") || f.has("directory");
    const recursive = f.has("R") || f.has("recursive");
    const classify = f.has("F") || f.has("classify");
    const slash = f.has("p");
    const inode = f.has("i") || f.has("inode");
    const sortBy = f.has("t") || p.values.sort === "time" ? "time" : f.has("S") || p.values.sort === "size" ? "size" : f.has("U") || p.values.sort === "none" ? "none" : "name";
    const reverse = f.has("r") || f.has("reverse");
    const uids = numeric ? await names("passwd") : undefined;
    const gids = numeric ? await names("group") : undefined;

    interface Entry { name: string; path: string; st: FsStat }
    const sortEntries = (list: Entry[]) => {
      if (sortBy !== "none")
        list.sort((a, b) => {
          if (sortBy === "time") return b.st.mtime.getTime() - a.st.mtime.getTime() || (a.name < b.name ? -1 : 1);
          if (sortBy === "size") return b.st.size - a.st.size || (a.name < b.name ? -1 : 1);
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
      if (reverse) list.reverse();
      return list;
    };
    const suffix = (e: Entry) => {
      if (e.st.isDirectory) return classify || slash ? "/" : "";
      if (!classify) return "";
      if (e.st.isSymbolicLink) return "@";
      return e.st.mode & 0o111 ? "*" : "";
    };
    const render = async (list: Entry[]) => {
      if (!long) return list.map((e) => `${inode ? `${fs.inode(e.path)} ` : ""}${e.name}${suffix(e)}`).join("\n") + (list.length ? "\n" : "");
      const rows = await Promise.all(
        list.map(async (e) => {
          const [u, g] = fs.ownerOf(e.path);
          let links = fs.linkCount(e.path);
          if (e.st.isDirectory) {
            const kids = await fs.inner.readdir(e.path).catch(() => [] as string[]);
            links = 2;
            for (const k of kids) if ((await fs.inner.lstat(`${e.path === "/" ? "" : e.path}/${k}`)).isDirectory) links++;
          }
          const size = e.st.isDirectory ? 4096 : e.st.isSymbolicLink ? (await fs.inner.readlink(e.path)).length : e.st.size;
          const target = e.st.isSymbolicLink ? ` -> ${await fs.inner.readlink(e.path)}` : "";
          return {
            ino: inode ? String(fs.inode(e.path)) : "",
            mode: modeString(e.st),
            links: String(links),
            user: numeric ? String(uids!.get(u) ?? u) : u,
            group: numeric ? String(gids!.get(g) ?? g) : g,
            size: humanSizes ? human(size) : String(size),
            date: lsDate(e.st.mtime),
            name: e.name + target + (e.st.isSymbolicLink ? "" : suffix(e)),
          };
        }),
      );
      const w = (k: keyof (typeof rows)[number]) => Math.max(0, ...rows.map((r) => r[k].length));
      return rows
        .map((r) =>
          [inode ? r.ino.padStart(w("ino")) + " " : "", r.mode, " ", r.links.padStart(w("links")), " ", f.has("g") ? "" : r.user.padEnd(w("user")) + " ", f.has("o") ? "" : r.group.padEnd(w("group")) + " ", r.size.padStart(w("size")), " ", r.date, " ", r.name].join(""),
        )
        .join("\n") + (rows.length ? "\n" : "");
    };

    let out = "";
    let err = "";
    let code = 0;
    const files: Entry[] = [];
    const dirs: { shown: string; path: string }[] = [];
    const targets = p.rest.length ? p.rest : ["."];
    for (const t of targets) {
      const path = abs(ctx, t);
      let st: FsStat;
      try {
        st = await fs.lstat(path);
        if (st.isSymbolicLink && !long && !dirsAsFiles) st = await fs.stat(path).catch(() => st);
      } catch {
        err += `ls: cannot access '${t}': No such file or directory\n`;
        code = 2;
        continue;
      }
      if (st.isDirectory && !dirsAsFiles) dirs.push({ shown: t, path });
      else files.push({ name: t, path, st });
    }
    out += await render(sortEntries(files));
    const listDir = async (shown: string, path: string, header: boolean) => {
      let kids: string[];
      try {
        kids = await fs.readdir(path);
      } catch {
        err += `ls: cannot open directory '${shown}': Permission denied\n`;
        code = 2;
        return;
      }
      const entries: Entry[] = [];
      if (all) for (const dot of [".", ".."]) entries.push({ name: dot, path: dot === "." ? path : normalizePath(path, ".."), st: await fs.inner.stat(dot === "." ? path : normalizePath(path, "..")) });
      for (const k of kids) {
        if (k.startsWith(".") && !all && !almost) continue;
        const kp = `${path === "/" ? "" : path}/${k}`;
        entries.push({ name: k, path: kp, st: await fs.lstat(kp) });
      }
      sortEntries(entries);
      if (header) out += `${out ? "\n" : ""}${shown}:\n`;
      if (long) out += `total ${entries.reduce((s, e) => s + (e.st.isDirectory ? 4 : e.st.isSymbolicLink ? 0 : blocksKb(e.st.size)), 0)}\n`;
      out += await render(entries);
      if (recursive)
        for (const e of entries)
          if (e.st.isDirectory && e.name !== "." && e.name !== "..") await listDir(`${shown === "/" ? "" : shown}/${e.name}`, e.path, true);
    };
    for (const d of dirs) await listDir(d.shown, d.path, targets.length > 1 || recursive);
    return ok(out, err, code);
  });

  const stat = command("stat", async (args, ctx) => {
    const p = parseArgs(args, "c", ["format", "printf"]);
    const format = p.values.c ?? p.values.format ?? p.values.printf;
    const deref = p.flags.has("L") || p.flags.has("dereference");
    if (!p.rest.length) return fail("stat: missing operand");
    const uids = await names("passwd");
    const gids = await names("group");
    let out = "";
    let err = "";
    for (const t of p.rest) {
      const path = abs(ctx, t);
      let st: FsStat;
      try {
        st = deref ? await fs.stat(path) : await fs.lstat(path);
      } catch {
        err += `stat: cannot statx '${t}': No such file or directory\n`;
        continue;
      }
      const real = deref ? await fs.inner.realpath(path) : path;
      const [u, g] = fs.ownerOf(real);
      const kind = st.isSymbolicLink ? "symbolic link" : st.isDirectory ? "directory" : st.size === 0 ? "regular empty file" : "regular file";
      const size = st.isDirectory ? 4096 : st.size;
      const time = `${st.mtime.toISOString().replace("T", " ").replace("Z", "")}000000 +0000`;
      const octal = (st.mode & 0o7777).toString(8);
      const target = st.isSymbolicLink ? await fs.inner.readlink(path) : "";
      if (format !== undefined) {
        const map: Record<string, string> = {
          a: octal, A: modeString(st), b: String(Math.ceil(size / 4096) * 8), B: "512", F: kind, g: String(gids.get(g) ?? g), G: g,
          h: String(fs.linkCount(real)), i: String(fs.inode(real)), n: t, N: st.isSymbolicLink ? `'${t}' -> '${target}'` : `'${t}'`, o: "4096", s: String(size),
          u: String(uids.get(u) ?? u), U: u, x: time, X: String(Math.floor(st.mtime.getTime() / 1000)), y: time, Y: String(Math.floor(st.mtime.getTime() / 1000)), z: time, Z: String(Math.floor(st.mtime.getTime() / 1000)),
        };
        out += format.replace(/%([%a-zA-Z])/g, (_, k: string) => (k === "%" ? "%" : (map[k] ?? `?`))).replace(/\\n/g, "\n").replace(/\\t/g, "\t") + (p.values.printf ? "" : "\n");
        continue;
      }
      out +=
        `  File: ${t}${target ? ` -> ${target}` : ""}\n` +
        `  Size: ${String(size).padEnd(10)}\tBlocks: ${String(Math.ceil(size / 4096) * 8).padEnd(10)} IO Block: 4096   ${kind}\n` +
        `Device: 259,1\tInode: ${String(fs.inode(real)).padEnd(11)} Links: ${fs.linkCount(real)}\n` +
        `Access: (0${octal.padStart(3, "0")}/${modeString(st)})  Uid: (${String(uids.get(u) ?? "?").padStart(5)}/${u.padStart(8)})   Gid: (${String(gids.get(g) ?? "?").padStart(5)}/${g.padStart(8)})\n` +
        `Access: ${time}\nModify: ${time}\nChange: ${time}\n Birth: -\n`;
    }
    return ok(out, err, err ? 1 : 0);
  });

  /** chown and chgrp share the permission rules: only root gives files away. */
  async function changeOwner(cmd: "chown" | "chgrp", args: string[], ctx: Ctx) {
    const p = parseArgs(args);
    const recursive = p.flags.has("R") || p.flags.has("recursive");
    const verbose = p.flags.has("v") || p.flags.has("verbose");
    const [spec, ...targets] = p.rest;
    if (!spec || !targets.length) return fail(`${cmd}: missing operand\nTry '${cmd} --help' for more information.`);
    const users = await readPasswd(fs);
    const groups = await readGroups(fs);
    let user: string | undefined;
    let group: string | undefined;
    if (cmd === "chgrp") group = spec;
    else {
      const [u, g] = spec.split(/[:.]/);
      user = u || undefined;
      group = spec.includes(":") ? g || undefined : undefined;
      if (spec.endsWith(":") && user) {
        const pw = users.find((x) => x.name === user);
        group = groups.find((x) => x.gid === pw?.gid)?.name;
      }
    }
    if (user && !users.some((u) => u.name === user)) return fail(`chown: invalid user: '${spec}'`);
    if (group && !groups.some((g) => g.name === group)) return fail(cmd === "chgrp" ? `chgrp: invalid group: '${group}'` : `chown: invalid group: '${spec}'`);
    let out = "";
    let err = "";
    for (const t of targets) {
      const path = abs(ctx, t);
      if (!(await fs.inner.exists(path))) {
        err += `${cmd}: cannot access '${t}': No such file or directory\n`;
        continue;
      }
      for (const each of recursive ? await walk(path) : [path]) {
        const real = await fs.inner.realpath(each).catch(() => each);
        const [curU, curG] = fs.ownerOf(real);
        const me = m.user;
        const allowed = me.uid === 0 || ((!user || user === curU) && curU === me.user && (!group || me.groups.includes(group)));
        const shown = each === path ? t : each;
        if (!allowed) {
          err += `${cmd}: changing ${cmd === "chgrp" || !user ? "group" : "ownership"} of '${shown}': Operation not permitted\n`;
          continue;
        }
        fs.setOwner(real, [user ?? curU, group ?? curG]);
        if (verbose) out += `ownership of '${shown}' retained or changed to ${user ?? curU}:${group ?? curG}\n`;
      }
    }
    return ok(out, err, err ? 1 : 0);
  }

  const du = command("du", async (args, ctx) => {
    const p = parseArgs(args, "d", ["max-depth", "exclude"]);
    const f = p.flags;
    const humanSizes = f.has("h") || f.has("human-readable");
    const summary = f.has("s") || f.has("summarize");
    const allFiles = f.has("a") || f.has("all");
    const apparent = f.has("b") || f.has("apparent-size") || f.has("bytes");
    const maxDepth = summary ? 0 : Number(p.values.d ?? p.values["max-depth"] ?? Infinity);
    const fmt = (kb: number, bytes: number) => (humanSizes ? (apparent ? human(bytes) : kb === 0 ? "0" : human(kb * 1024)) : apparent ? String(bytes) : f.has("m") ? String(Math.ceil(kb / 1024)) : String(kb));
    let out = "";
    let err = "";
    let grandKb = 0;
    let grandBytes = 0;
    const visit = async (path: string, shown: string, depth: number): Promise<[number, number]> => {
      const st = await fs.lstat(path);
      if (!st.isDirectory) {
        const kb = st.isSymbolicLink ? 0 : blocksKb(st.size);
        if (allFiles && depth <= maxDepth) out += `${fmt(kb, st.size)}\t${shown}\n`;
        return [kb, st.size];
      }
      let kb = 4;
      let bytes = 4096;
      let kids: string[] = [];
      try {
        kids = await fs.readdir(path);
      } catch {
        err += `du: cannot read directory '${shown}': Permission denied\n`;
      }
      for (const k of kids.sort()) {
        const [a, b] = await visit(`${path === "/" ? "" : path}/${k}`, `${shown === "/" ? "" : shown}/${k}`, depth + 1);
        kb += a;
        bytes += b;
      }
      if (depth <= maxDepth) out += `${fmt(kb, bytes)}\t${shown}\n`;
      return [kb, bytes];
    };
    for (const t of p.rest.length ? p.rest : ["."]) {
      const path = abs(ctx, t);
      if (!(await fs.inner.exists(path))) {
        err += `du: cannot access '${t}': No such file or directory\n`;
        continue;
      }
      const st = await fs.lstat(path);
      if (!st.isDirectory) {
        const kb = blocksKb(st.size);
        out += `${fmt(kb, st.size)}\t${t}\n`;
        grandKb += kb;
        grandBytes += st.size;
        continue;
      }
      const [kb, bytes] = await visit(path, t.replace(/\/+$/, "") || "/", 0);
      grandKb += kb;
      grandBytes += bytes;
    }
    if (f.has("c") || f.has("total")) out += `${fmt(grandKb, grandBytes)}\ttotal\n`;
    return ok(out, err, err ? 1 : 0);
  });

  async function resize(cmd: string, path: string, shown: string, size: number, create: boolean) {
    const exists = await fs.inner.exists(path);
    if (!exists && !create) return "";
    const current = exists ? await fs.inner.readFile(path) : "";
    const apparent = exists ? ((await fs.stat(path)).size) : 0;
    try {
      await fs.writeFile(path, size < current.length ? current.slice(0, size) : current);
      if (size > current.length) {
        await m.checkDisk(path, size - Math.max(apparent, current.length), false);
        fs.meta.sizes[path] = size;
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      return `${cmd}: cannot open '${shown}' for writing: ${code === "ENOSPC" ? "No space left on device" : "Permission denied"}\n`;
    }
    return "";
  }

  const truncate = command("truncate", async (args, ctx) => {
    const p = parseArgs(args, "s", ["size"]);
    const spec = p.values.s ?? p.values.size;
    if (!spec || !p.rest.length) return fail("truncate: you must specify either '--size' or '--reference'\nTry 'truncate --help' for more information.");
    const m2 = /^([+-]?)(.+)$/.exec(spec)!;
    const n = parseSize(m2[2]);
    if (n === undefined) return fail(`truncate: invalid number: '${spec}'`);
    let err = "";
    for (const t of p.rest) {
      const path = abs(ctx, t);
      const cur = (await fs.inner.exists(path)) ? (await fs.stat(path)).size : 0;
      const size = m2[1] === "+" ? cur + n : m2[1] === "-" ? Math.max(0, cur - n) : n;
      err += await resize("truncate", path, t, size, !p.flags.has("c"));
    }
    return ok("", err, err ? 1 : 0);
  });

  const fallocate = command("fallocate", async (args, ctx) => {
    const p = parseArgs(args, "l", ["length"]);
    const n = parseSize(p.values.l ?? p.values.length ?? "");
    if (n === undefined || p.rest.length !== 1) return fail("fallocate: no length argument specified");
    const err = await resize("fallocate", abs(ctx, p.rest[0]), p.rest[0], n, true);
    return ok("", err, err ? 1 : 0);
  });

  const pager = (name: string) =>
    command(name, async (args, ctx) => {
      const p = parseArgs(args);
      if (!p.rest.length) return ok(stdinText(ctx));
      let out = "";
      let err = "";
      for (const t of p.rest) {
        try {
          const text = await fs.readFile(abs(ctx, t));
          out += p.flags.has("N") ? text.split("\n").map((l, i, a) => (i === a.length - 1 && !l ? "" : `${String(i + 1).padStart(6)} ${l}`)).join("\n") : text;
        } catch (e) {
          err += `${name}: ${t}: ${(e as { code?: string }).code === "EACCES" ? "Permission denied" : "No such file or directory"}\n`;
        }
      }
      return ok(out, err, err ? 1 : 0);
    });

  const tail = command("tail", async (args, ctx) => {
    const follow = args.some((a) => a === "-f" || a === "-F" || a.startsWith("--follow") || /^-[a-zA-Z]*[fF][a-zA-Z]*$/.test(a));
    const rest = args.filter((a) => a !== "-f" && a !== "-F" && !a.startsWith("--follow")).map((a) => (/^-[a-zA-Z]*[fF]/.test(a) ? a.replace(/[fF]/g, "") : a)).filter((a) => a !== "-");
    const r = await ctx.origCommand!(rest);
    return follow ? { ...r, stderr: `${r.stderr}tail: (this lab shows the current end of the file; in a real terminal -f keeps following new lines until Ctrl+C)\n` } : r;
  });

  const xargs = command("xargs", async (args, ctx) => {
    let replace: string | undefined;
    let i = 0;
    let trace = false;
    let noEmpty = false;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "-I") replace = args[++i];
      else if (a.startsWith("-I")) replace = a.slice(2);
      else if (a === "-i" || a === "--replace") replace = "{}";
      else if (a.startsWith("--replace=")) replace = a.slice(10);
      else if (a === "-t") trace = true;
      else if (a === "-r" || a === "--no-run-if-empty") noEmpty = true;
      else break;
    }
    if (replace === undefined) return ctx.origCommand!(args);
    const template = args.slice(i).length ? args.slice(i) : ["echo", replace];
    let out = "";
    let err = "";
    let code = 0;
    const lines = stdinText(ctx).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length && noEmpty) return ok();
    for (const line of lines) {
      const argv = template.map((t) => t.split(replace!).join(line));
      if (trace) err += `${argv.join(" ")}\n`;
      const r = await ctx.exec!(quoteArgs(argv), { cwd: ctx.cwd });
      out += r.stdout;
      err += r.stderr;
      if (r.exitCode) code = 123;
    }
    return ok(out, err, code);
  });

  /** just-bash's sort lacks -h (human sizes), which `du -sh * | sort -rh` relies on. */
  const sort = command("sort", async (args, ctx) => {
    const human = args.includes("--human-numeric-sort") || args.some((a) => /^-[a-zA-Z]*h/.test(a));
    if (!human) return ctx.origCommand!(args);
    const p = parseArgs(args, "kt", ["key", "field-separator"]);
    const reverse = p.flags.has("r") || p.flags.has("reverse");
    const key = Number((p.values.k ?? p.values.key ?? "1").split(/[,.]/)[0]) || 1;
    const sep = p.values.t ?? p.values["field-separator"];
    let text = "";
    if (!p.rest.length) text = stdinText(ctx);
    for (const f of p.rest) {
      try {
        text += await fs.readFile(abs(ctx, f));
      } catch {
        return fail(`sort: cannot read: ${f}: No such file or directory`, 2);
      }
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const units: Record<string, number> = { "": 0, K: 1, M: 2, G: 3, T: 4, P: 5 };
    const value = (line: string) => {
      const field = (sep ? line.split(sep) : line.trim().split(/\s+/))[key - 1] ?? "";
      const m2 = /^(-?[\d.]+)\s*([KMGTP]?)/i.exec(field);
      return m2 ? Number(m2[1]) * 1024 ** (units[m2[2].toUpperCase()] ?? 0) : -Infinity;
    };
    lines.sort((a, b) => value(a) - value(b) || (a < b ? -1 : a > b ? 1 : 0));
    if (reverse) lines.reverse();
    return ok(lines.length ? `${lines.join("\n")}\n` : "");
  });

  const locate = command("locate", async (args) => {
    const p = parseArgs(args, "ln", ["limit"]);
    const pattern = p.rest[0];
    if (!pattern) return fail("locate: no pattern to search for specified");
    const ci = p.flags.has("i") || p.flags.has("ignore-case");
    const re = /[*?[]/.test(pattern) ? globToRegex(pattern.startsWith("/") || pattern.startsWith("*") ? pattern : `*${pattern}*`) : undefined;
    const needle = ci ? pattern.toLowerCase() : pattern;
    let hits = m.state.locateDb.filter((path) => (re ? re.test(path) : (ci ? path.toLowerCase() : path).includes(needle)));
    const limit = Number(p.values.l ?? p.values.n ?? p.values.limit ?? 0);
    if (limit) hits = hits.slice(0, limit);
    if (p.flags.has("c") || p.flags.has("count")) return ok(`${hits.length}\n`);
    return ok(hits.map((h) => `${h}\n`).join(""), "", hits.length ? 0 : 1);
  });

  const updatedb = command("updatedb", async () => {
    if (!m.isRoot()) return fail("updatedb: can not open a temporary file for `/var/lib/plocate/plocate.db': Permission denied");
    m.state.locateDb = fs.inner.getAllPaths().filter((p) => !/^\/(proc|tmp|var\/tmp)(\/|$)/.test(p));
    return ok();
  });

  const whereis = command("whereis", async (args) => {
    let out = "";
    for (const name of parseArgs(args).rest) {
      const found: string[] = [];
      for (const dir of ["/usr/bin", "/usr/sbin", "/usr/local/bin"]) if (await fs.inner.exists(`${dir}/${name}`)) found.push(`${dir}/${name}`);
      if (found.length) found.push(`/usr/share/man/man${found[0].includes("sbin") ? 8 : 1}/${name}.${found[0].includes("sbin") ? 8 : 1}.gz`);
      out += `${name}:${found.map((x) => ` ${x}`).join("")}\n`;
    }
    return ok(out);
  });

  const zip = command("zip", async (args, ctx) => {
    const p = parseArgs(args);
    const [archive, ...inputs] = p.rest;
    if (!archive || !inputs.length) return fail("zip error: Nothing to do! (try: zip -r archive.zip folder/)", 12);
    const target = abs(ctx, /\.zip$/i.test(archive) ? archive : `${archive}.zip`);
    const entries: ZipEntry[] = [];
    let out = "";
    let err = "";
    for (const input of inputs) {
      const path = abs(ctx, input);
      if (!(await fs.inner.exists(path))) {
        err += `\tzip warning: name not matched: ${input}\n`;
        continue;
      }
      const paths = p.flags.has("r") ? await walk(path) : [path];
      for (const each of paths) {
        const rel = (input.replace(/\/+$/, "") + each.slice(path.length)).replace(/^\.\//, "").replace(/^\/+/, "");
        const st = await fs.lstat(each);
        if (st.isDirectory) {
          entries.push({ name: `${p.flags.has("j") ? "" : rel}/`, data: new Uint8Array(), mtime: st.mtime });
          if (!p.flags.has("q")) out += `  adding: ${rel}/ (stored 0%)\n`;
          continue;
        }
        try {
          const data = await fs.readFileBuffer(each);
          const name = p.flags.has("j") ? rel.split("/").pop()! : rel;
          entries.push({ name, data, mtime: st.mtime });
          const packed = deflateRawSync(data).length;
          if (!p.flags.has("q")) out += `  adding: ${name} (${packed < data.length ? `deflated ${Math.round((1 - packed / data.length) * 100)}%` : "stored 0%"})\n`;
        } catch {
          err += `\tzip warning: could not open for reading: ${rel}\n`;
        }
      }
    }
    if (!entries.length) return fail(`${err}\nzip error: Nothing to do! (${archive})`, 12);
    try {
      await fs.writeFile(target, buildZip(entries.filter((e) => e.name !== "/")));
    } catch {
      return fail(`zip I/O error: Permission denied\nzip error: Could not create output file (${archive})`, 15);
    }
    return ok(out, err);
  });

  const unzip = command("unzip", async (args, ctx) => {
    const p = parseArgs(args, "d");
    const [archive, ...only] = p.rest;
    if (!archive) return fail("UnZip 6.00: usage: unzip [-l] [-o] [-q] file[.zip] [-d exdir]", 10);
    const path = abs(ctx, (await fs.inner.exists(abs(ctx, archive))) ? archive : `${archive}.zip`);
    let entries: ZipEntry[] | undefined;
    try {
      entries = readZip(Buffer.from(await fs.readFileBuffer(path)));
    } catch (e) {
      if ((e as { code?: string }).code === "EACCES") return fail(`unzip:  cannot find or open ${archive}: Permission denied`, 9);
      return fail(`unzip:  cannot find or open ${archive}, ${archive}.zip or ${archive}.ZIP.`, 9);
    }
    if (!entries) return fail(`Archive:  ${archive}\n  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.`, 9);
    const selected = only.length ? entries.filter((e) => only.some((o) => globToRegex(o).test(e.name))) : entries;
    if (p.flags.has("l")) {
      const rows = selected.map((e) => `${String(e.data.length).padStart(9)}  ${e.mtime.toISOString().slice(0, 10)} ${e.mtime.toISOString().slice(11, 16)}   ${e.name}`);
      const total = selected.reduce((s, e) => s + e.data.length, 0);
      return ok(`Archive:  ${archive}\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n${rows.join("\n")}\n---------                     -------\n${String(total).padStart(9)}                     ${selected.length} file${selected.length === 1 ? "" : "s"}\n`);
    }
    const dest = abs(ctx, p.values.d ?? ".");
    let out = p.flags.has("q") ? "" : `Archive:  ${archive}\n`;
    let err = "";
    try {
      if (!(await fs.inner.exists(dest))) await fs.mkdir(dest, { recursive: true });
      for (const e of selected) {
        const target = normalizePath(dest, e.name);
        if (e.name.endsWith("/")) {
          if (!(await fs.inner.exists(target))) await fs.mkdir(target, { recursive: true });
          if (!p.flags.has("q")) out += `   creating: ${normalizePath("/", `${p.values.d ?? ""}/${e.name}`).slice(1)}/\n`;
          continue;
        }
        if ((await fs.inner.exists(target)) && !p.flags.has("o")) {
          err += `  skipping: ${e.name} (already exists; use unzip -o to overwrite)\n`;
          continue;
        }
        const parent = target.slice(0, target.lastIndexOf("/")) || "/";
        if (!(await fs.inner.exists(parent))) await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(target, e.data);
        if (!p.flags.has("q")) out += `  inflating: ${p.values.d ? `${p.values.d.replace(/\/+$/, "")}/` : ""}${e.name}\n`;
      }
    } catch {
      return fail(`${out}checkdir error:  cannot create ${p.values.d ?? "files"}\n                 Permission denied`, 50);
    }
    return ok(out, err);
  });

  const rsync = command("rsync", async (args, ctx) => {
    const p = parseArgs(args, "e", ["exclude", "rsh"]);
    const f = p.flags;
    const recursive = f.has("a") || f.has("r") || f.has("archive") || f.has("recursive");
    const verbose = f.has("v") || f.has("verbose");
    const dry = f.has("n") || f.has("dry-run");
    const del = f.has("delete");
    const excludes = (p.multi.exclude ?? []).map((pat) => ({ dirOnly: pat.endsWith("/"), re: globToRegex(pat.replace(/\/$/, "")), full: pat.includes("/") && !pat.endsWith("/") }));
    if (p.rest.length < 2) return fail("rsync: missing source or destination\nrsync error: syntax or usage error (code 1)", 1);
    const dest = p.rest.at(-1)!;
    const sources = p.rest.slice(0, -1);
    const remote = (s: string) => /^([\w.-]+@)?[\w.-]+:/.test(s) && !s.startsWith("/");
    if ([...sources, dest].some(remote)) {
      const r = await ctx.exec!(`scp -r --lab-rsync ${dry ? "--lab-dry " : ""}${quoteArgs(p.values.e?.includes("-i") ? ["-i", p.values.e.split(/\s+/).at(-1)!] : [])} ${quoteArgs([...sources, dest])}`, { cwd: ctx.cwd });
      if (r.exitCode) return r;
      // scp prints one "name  100%  size ..." line per file; rsync lists the names and a transfer summary
      const files = r.stdout.split("\n").filter(Boolean).map((l) => ({ name: l.split(/\s+/)[0], size: Number(l.split(/\s+/)[2]) || 0 }));
      const bytes = files.reduce((n, f) => n + f.size, 0);
      return ok(
        verbose
          ? `sending incremental file list\n${files.map((f) => f.name).join("\n")}\n\nsent ${(bytes + 120).toLocaleString("en-US")} bytes  received ${(35).toLocaleString("en-US")} bytes  ${(bytes + 155).toLocaleString("en-US")}.00 bytes/sec\ntotal size is ${bytes.toLocaleString("en-US")}  speedup is 1.00${dry ? " (DRY RUN)" : ""}\n`
          : "",
      );
    }
    const excluded = (rel: string, isDir: boolean) => excludes.some((x) => (x.dirOnly ? isDir && x.re.test(rel.split("/").pop()!) : x.full ? x.re.test(rel) : x.re.test(rel.split("/").pop()!)));
    let listing = "";
    let sent = 0;
    let total = 0;
    const destPath = abs(ctx, dest);
    try {
      for (const src of sources) {
        const srcPath = abs(ctx, src);
        if (!(await fs.inner.exists(srcPath))) return fail(`rsync: [sender] link_stat "${srcPath}" failed: No such file or directory (2)\nrsync error: some files/attrs were not transferred (see previous errors) (code 23)`, 23);
        const st = await fs.lstat(srcPath);
        const intoContents = src.endsWith("/") || !st.isDirectory;
        const base = st.isDirectory ? (intoContents ? destPath : normalizePath(destPath, srcPath.split("/").pop()!)) : (await fs.inner.exists(destPath)) && (await fs.inner.stat(destPath)).isDirectory ? normalizePath(destPath, srcPath.split("/").pop()!) : destPath;
        if (st.isDirectory && !recursive) {
          listing += `skipping directory ${src}\n`;
          continue;
        }
        const files = st.isDirectory ? await walk(srcPath) : [srcPath];
        const seen = new Set<string>();
        if (!(await fs.inner.exists(destPath)) && st.isDirectory) {
          listing += `created directory ${dest}\n`;
          if (!dry) await fs.mkdir(destPath, { recursive: true });
        }
        for (const file of files) {
          const rel = file.slice(srcPath.length).replace(/^\//, "");
          const fst = await fs.lstat(file);
          if (rel && excluded(rel, fst.isDirectory)) continue;
          const target = rel ? normalizePath(base, rel) : base;
          seen.add(target);
          const shownRel = st.isDirectory ? (intoContents ? rel || "." : `${srcPath.split("/").pop()}${rel ? `/${rel}` : ""}`) : srcPath.split("/").pop()!;
          if (fst.isDirectory) {
            if (!(await fs.inner.exists(target))) {
              if (!dry) await fs.mkdir(target, { recursive: true });
              listing += `${shownRel === "." ? "./" : `${shownRel}/`}\n`;
            }
            continue;
          }
          const data = await fs.readFileBuffer(file);
          total += data.length;
          const same = (await fs.inner.exists(target)) && Buffer.compare(Buffer.from(await fs.inner.readFileBuffer(target)), Buffer.from(data)) === 0;
          if (same) continue;
          listing += `${shownRel}\n`;
          sent += data.length;
          if (!dry) {
            await fs.writeFile(target, data);
            if (recursive) await fs.chmod(target, fst.mode & 0o7777).catch(() => {});
          }
        }
        if (del && st.isDirectory)
          for (const existing of (await fs.inner.exists(base)) ? await walk(base) : [])
            if (!seen.has(existing) && existing !== base) {
              listing += `deleting ${existing.slice(base.length + 1)}\n`;
              if (!dry) await fs.rm(existing, { recursive: true, force: true }).catch(() => {});
            }
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      return fail(`rsync: [receiver] mkstemp "${destPath}" failed: ${code === "ENOSPC" ? "No space left on device (28)" : "Permission denied (13)"}\nrsync error: some files/attrs were not transferred (see previous errors) (code 23)`, 23);
    }
    if (!verbose) return ok();
    return ok(`sending incremental file list\n${listing}\nsent ${(sent + 120).toLocaleString("en-US")} bytes  received ${(35).toLocaleString("en-US")} bytes  ${(sent + 155).toLocaleString("en-US")}.00 bytes/sec\ntotal size is ${total.toLocaleString("en-US")}  speedup is ${(total / Math.max(1, sent + 155)).toFixed(2)}${dry ? " (DRY RUN)" : ""}\n`);
  });

  const editor = (name: string) =>
    command(name, async (args, ctx) => {
      const file = args.filter((a) => !a.startsWith("-") && !a.startsWith("+")).at(-1);
      if (!file) return fail(`${name}: in this lab, open a file by name, for example: ${name} notes.txt`);
      const path = abs(ctx, file);
      let content = "";
      if (await fs.inner.exists(path)) {
        if ((await fs.inner.stat(path)).isDirectory) return fail(`${name}: "${file}" is a directory`);
        try {
          content = await fs.readFile(path);
        } catch {
          return fail(`${name}: ${file}: Permission denied (try: sudo ${name} ${file})`);
        }
      } else if (!(await fs.inner.exists(path.slice(0, path.lastIndexOf("/")) || "/"))) return fail(`${name}: ${file}: No such file or directory`);
      m.editor = { path, content, sudo: m.isRoot() };
      return ok(`[ Opened ${path} in the editor panel${m.isRoot() ? " as root" : ""} ]\n`);
    });

  const file = command("file", async (args, ctx) => {
    const dev = args.find((a) => a.startsWith("/dev/"));
    if (!dev) return ctx.origCommand!(args);
    const d = m.state.devices.find((x) => `/dev/${x.name}` === dev);
    if (!d) return ok(`${dev}: cannot open \`${dev}' (No such file or directory)\n`);
    if (!m.isRoot()) return ok(`${dev}: block special (259/${m.state.devices.indexOf(d)})\n`);
    const desc = d.fstype === "xfs" ? "SGI XFS filesystem data (blksz 4096, inosz 512, v2 dirs)" : d.fstype === "ext4" ? `Linux rev 1.0 ext4 filesystem data, UUID=${d.uuid} (extents) (64bit) (large files) (huge files)` : d.fstype === "vfat" ? "DOS/MBR boot sector, FAT (32 bit)" : d.type === "disk" && d.name === "nvme0n1" ? "DOS/MBR boot sector; partition 1 : ID=0xee, start-CHS (0x0,0,2)" : "data";
    return ok(`${dev}: ${desc}\n`);
  });

  const man = command("man", async (args, ctx) => {
    const p = parseArgs(args);
    if (p.flags.has("k")) {
      const word = (p.rest[0] ?? "").toLowerCase();
      const hits = Object.entries(HELP).filter(([k, v]) => k.includes(word) || v.split("\n")[0].toLowerCase().includes(word));
      return hits.length ? ok(hits.map(([k, v]) => `${k} (1)${" ".repeat(Math.max(1, 14 - k.length))}- ${v.split("\n")[0].split(" - ")[1] ?? ""}\n`).join("")) : fail(`${word}: nothing appropriate.`, 16);
    }
    const name = p.rest.find((a) => !/^\d$/.test(a));
    if (!name) return fail("What manual page do you want?\nFor example, try 'man man'.");
    if (HELP[name]) return ok(manPage(name, HELP[name]));
    const r = await ctx.exec!(`${name} --help`, { cwd: ctx.cwd });
    if (r.exitCode !== 0 || !r.stdout.trim() || /command not found/.test(r.stderr)) return fail(`No manual entry for ${name}`, 16);
    const [first, ...rest] = r.stdout.trim().split("\n");
    return ok(manPage(name, `${name} - ${first.replace(/^Usage:\s*/i, "")}\n${rest.join("\n")}`));
  });

  return [
    ls, stat,
    command("chown", (a, c) => changeOwner("chown", a, c)),
    command("chgrp", (a, c) => changeOwner("chgrp", a, c)),
    du, truncate, fallocate, pager("less"), pager("more"), tail, xargs, sort, locate, updatedb, whereis, zip, unzip, rsync,
    editor("nano"), editor("vi"), editor("vim"), editor("emacs"), editor("edit"), file, man,
  ];
}
