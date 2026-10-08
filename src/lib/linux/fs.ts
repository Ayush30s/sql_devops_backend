import { InMemoryFs } from "just-bash";
import type { CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";

type ReadOpts = Parameters<IFileSystem["readFile"]>[1];
type WriteOpts = Parameters<IFileSystem["writeFile"]>[2];

/**
 * Filesystem for the simulated Linux machine: just-bash's InMemoryFs plus what a Linux lesson
 * needs and InMemoryFs lacks — file owners, permission checks for non-root users, sticky
 * directories, real hard links (shared content) and sparse "virtual size" files.
 */

export interface Identity {
  user: string;
  uid: number;
  group: string;
  groups: string[];
}

export const ROOT: Identity = { user: "root", uid: 0, group: "root", groups: ["root"] };

export interface FsMeta {
  owners: Record<string, [string, string]>;
  sizes: Record<string, number>;
  links: Record<string, number>;
  nextLink: number;
}

export type FsRecord =
  | { t: "f"; c: string; b64?: 1; m: number; mt: number }
  | { t: "d"; m: number; mt: number }
  | { t: "l"; to: string; m: number; mt: number };

export interface FsSnapshot extends FsMeta {
  files: Record<string, FsRecord>;
}

/** Character devices: reads are bounded, writes are discarded. */
const DEVICES: Record<string, () => Uint8Array> = {
  "/dev/null": () => new Uint8Array(),
  "/dev/zero": () => new Uint8Array(65536),
  "/dev/random": () => crypto.getRandomValues(new Uint8Array(65536)),
  "/dev/urandom": () => crypto.getRandomValues(new Uint8Array(65536)),
};

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const within = (p: string, root: string) => p === root || p.startsWith(root === "/" ? "/" : `${root}/`);

export function fsError(code: string, text: string, syscall: string, path: string) {
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), { code, syscall, path });
}

/** Owner of files nobody chowned: a user's home belongs to them, everything else to root. */
export function defaultOwner(path: string): [string, string] {
  const home = /^\/home\/([^/]+)/.exec(path)?.[1];
  return home ? [home, home] : ["root", "root"];
}

export class LabFs implements IFileSystem {
  identity: Identity = ROOT;
  /** Paths refused during the current command (code per path), used to fix error messages. */
  readonly denied = new Map<string, string>();
  /** Called before content grows by `delta` bytes; throws ENOSPC when the disk is full. */
  onGrow?: (path: string, delta: number) => Promise<void>;
  readonly inner: InMemoryFs;
  readonly meta: FsMeta;

  constructor(inner: InMemoryFs, meta: FsMeta) {
    this.inner = inner;
    this.meta = meta;
  }

  // ---- metadata --------------------------------------------------------------------------
  ownerOf(path: string): [string, string] {
    return this.meta.owners[path] ?? defaultOwner(path);
  }

  setOwner(path: string, owner: [string, string]) {
    const d = defaultOwner(path);
    if (owner[0] === d[0] && owner[1] === d[1]) delete this.meta.owners[path];
    else this.meta.owners[path] = owner;
  }

  linkCount(path: string) {
    const id = this.meta.links[path];
    return id === undefined ? 1 : Object.values(this.meta.links).filter((v) => v === id).length;
  }

  inode(path: string) {
    const id = this.meta.links[path];
    if (id !== undefined) return 900000 + id;
    let h = 7;
    for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) % 899999;
    return 100000 + h;
  }

  /** Rewrites metadata keys after a path moves. */
  private moveMeta(from: string, to: string) {
    for (const table of [this.meta.owners, this.meta.sizes, this.meta.links] as Record<string, unknown>[])
      for (const key of Object.keys(table))
        if (within(key, from)) {
          table[to + key.slice(from.length)] = table[key];
          delete table[key];
        }
  }

  private dropMeta(path: string) {
    for (const table of [this.meta.owners, this.meta.sizes, this.meta.links] as Record<string, unknown>[])
      for (const key of Object.keys(table)) if (within(key, path)) delete table[key];
  }

  // ---- permissions -----------------------------------------------------------------------
  private async may(path: string, bits: number): Promise<boolean> {
    const id = this.identity;
    if (id.uid === 0) return true;
    const st = await this.inner.stat(path);
    const [user, group] = this.ownerOf(await this.inner.realpath(path).catch(() => path));
    const shift = user === id.user ? 6 : id.groups.includes(group) ? 3 : 0;
    return ((st.mode >> shift) & bits) === bits;
  }

  /** Execute (search) permission on every directory leading to `path`. */
  private deny(code: "EACCES" | "EPERM", syscall: string, path: string) {
    this.denied.set(path, code);
    return fsError(code, code === "EACCES" ? "permission denied" : "operation not permitted", syscall, path);
  }

  private async traverse(path: string, syscall: string) {
    if (this.identity.uid === 0) return;
    const parts = path.split("/").filter(Boolean);
    let dir = "";
    for (const part of parts.slice(0, -1)) {
      dir += `/${part}`;
      if ((await this.inner.exists(dir)) && !(await this.may(dir, 1))) throw this.deny("EACCES", syscall, path);
    }
  }

  private async need(path: string, bits: number, syscall: string, report = path) {
    await this.traverse(path, syscall);
    if (!(await this.may(path, bits))) throw this.deny("EACCES", syscall, report);
  }

  /** Creating or removing an entry needs write+search on its directory (and the sticky rule). */
  private async needParent(path: string, syscall: string) {
    let dir = parentOf(path);
    while (!(await this.inner.exists(dir))) dir = parentOf(dir);
    await this.need(dir, 3, syscall, path);
    const st = await this.inner.stat(dir);
    if (this.identity.uid !== 0 && st.mode & 0o1000 && (await this.inner.exists(path))) {
      if (this.ownerOf(path)[0] !== this.identity.user && this.ownerOf(dir)[0] !== this.identity.user) throw this.deny("EPERM", syscall, path);
    }
  }

  private async sizeOf(path: string) {
    if (!(await this.inner.exists(path))) return 0;
    const st = await this.inner.stat(path);
    return st.isFile ? (this.meta.sizes[path] ?? st.size) : 0;
  }

  private created(path: string) {
    this.setOwner(path, [this.identity.user, this.identity.group]);
  }

  private async syncLinks(path: string) {
    const id = this.meta.links[path];
    if (id === undefined) return;
    const data = await this.inner.readFileBuffer(path);
    for (const [other, v] of Object.entries(this.meta.links)) if (v === id && other !== path) await this.inner.writeFile(other, data);
  }

  // ---- IFileSystem -----------------------------------------------------------------------
  async readFile(path: string, options?: ReadOpts) {
    if (DEVICES[path]) return new TextDecoder().decode(DEVICES[path]());
    await this.need(path, 4, "open");
    return this.inner.readFile(path, options);
  }

  async readFileBuffer(path: string) {
    if (DEVICES[path]) return DEVICES[path]();
    await this.need(path, 4, "open");
    return this.inner.readFileBuffer(path);
  }

  async writeFile(path: string, content: FileContent, options?: WriteOpts) {
    if (DEVICES[path]) return;
    const exists = await this.inner.exists(path);
    if (exists) await this.need(path, 2, "open");
    else await this.needParent(path, "open");
    await this.onGrow?.(path, content.length - (await this.sizeOf(path)));
    await this.inner.writeFile(path, content, options);
    if (!exists) this.created(path);
    delete this.meta.sizes[path];
    await this.syncLinks(path);
  }

  async appendFile(path: string, content: FileContent, options?: WriteOpts) {
    if (DEVICES[path]) return;
    const exists = await this.inner.exists(path);
    if (exists) await this.need(path, 2, "open");
    else await this.needParent(path, "open");
    await this.onGrow?.(path, content.length);
    await this.inner.appendFile(path, content, options);
    if (!exists) this.created(path);
    delete this.meta.sizes[path];
    await this.syncLinks(path);
  }

  exists(path: string) {
    return this.inner.exists(path);
  }

  private withSize(path: string, st: FsStat): FsStat {
    const size = this.meta.sizes[path];
    return size === undefined || !st.isFile ? st : { ...st, size };
  }

  async stat(path: string) {
    const real = await this.inner.realpath(path).catch(() => path);
    return this.withSize(real, await this.inner.stat(path));
  }

  async lstat(path: string) {
    return this.withSize(path, await this.inner.lstat(path));
  }

  async mkdir(path: string, options?: MkdirOptions) {
    if (await this.inner.exists(path)) return this.inner.mkdir(path, options);
    await this.needParent(path, "mkdir");
    const missing: string[] = [];
    for (let p = path; p !== "/" && !(await this.inner.exists(p)); p = parentOf(p)) missing.push(p);
    await this.inner.mkdir(path, options);
    for (const p of missing) if (await this.inner.exists(p)) this.created(p);
  }

  async readdir(path: string) {
    await this.need(path, 5, "scandir");
    return this.inner.readdir(path);
  }

  async rm(path: string, options?: RmOptions) {
    if (await this.inner.exists(path)) await this.needParent(path, "unlink");
    await this.inner.rm(path, options);
    if (!(await this.inner.exists(path))) this.dropMeta(path);
  }

  async cp(src: string, dest: string, options?: CpOptions) {
    await this.need(src, 4, "open");
    await this.needParent(dest, "open");
    await this.inner.cp(src, dest, options);
    for (const p of this.inner.getAllPaths()) if (within(p, dest)) this.created(p);
    if (this.meta.sizes[src] !== undefined) this.meta.sizes[dest] = this.meta.sizes[src];
  }

  async mv(src: string, dest: string) {
    await this.needParent(src, "rename");
    await this.needParent(dest, "rename");
    await this.inner.mv(src, dest);
    this.dropMeta(dest);
    this.moveMeta(src, dest);
  }

  resolvePath(base: string, path: string) {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths() {
    return this.inner.getAllPaths();
  }

  async chmod(path: string, mode: number) {
    await this.traverse(path, "chmod");
    const real = await this.inner.realpath(path).catch(() => path);
    if (this.identity.uid !== 0 && this.ownerOf(real)[0] !== this.identity.user) throw this.deny("EPERM", "chmod", path);
    await this.inner.chmod(path, mode);
    const id = this.meta.links[real];
    if (id !== undefined) for (const [other, v] of Object.entries(this.meta.links)) if (v === id) await this.inner.chmod(other, mode);
  }

  async symlink(target: string, linkPath: string) {
    await this.needParent(linkPath, "symlink");
    await this.inner.symlink(target, linkPath);
    this.created(linkPath);
  }

  async link(existingPath: string, newPath: string) {
    await this.need(existingPath, 4, "link");
    await this.needParent(newPath, "link");
    await this.inner.link(existingPath, newPath);
    const id = this.meta.links[existingPath] ?? this.meta.nextLink++;
    this.meta.links[existingPath] = id;
    this.meta.links[newPath] = id;
    this.setOwner(newPath, this.ownerOf(existingPath));
  }

  readlink(path: string) {
    return this.inner.readlink(path);
  }

  realpath(path: string) {
    return this.inner.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date) {
    if (this.identity.uid !== 0 && this.ownerOf(path)[0] !== this.identity.user) await this.need(path, 2, "utime");
    await this.inner.utimes(path, atime, mtime);
  }

  // ---- persistence -----------------------------------------------------------------------
  async snapshot(skip: (path: string) => boolean): Promise<FsSnapshot> {
    const files: Record<string, FsRecord> = {};
    for (const path of this.inner.getAllPaths()) {
      if (path === "/" || skip(path)) continue;
      const st = await this.inner.lstat(path);
      const mt = st.mtime.getTime();
      if (st.isSymbolicLink) files[path] = { t: "l", to: await this.inner.readlink(path), m: st.mode, mt };
      else if (st.isDirectory) files[path] = { t: "d", m: st.mode, mt };
      else {
        const bytes = await this.inner.readFileBuffer(path);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        files[path] = text.includes("�")
          ? { t: "f", c: Buffer.from(bytes).toString("base64"), b64: 1, m: st.mode, mt }
          : { t: "f", c: text, m: st.mode, mt };
      }
    }
    return { files, ...structuredClone(this.meta) };
  }

  static async restore(snap: FsSnapshot): Promise<LabFs> {
    const inner = new InMemoryFs();
    const entries = Object.entries(snap.files).sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    for (const [path, rec] of entries) {
      if (rec.t === "d") await inner.mkdir(path, { recursive: true });
      else if (rec.t === "l") await inner.symlink(rec.to, path);
      else await inner.writeFile(path, rec.b64 ? Buffer.from(rec.c, "base64") : rec.c);
      if (rec.t !== "l") await inner.chmod(path, rec.m);
    }
    for (const [path, rec] of entries) if (rec.t !== "l") await inner.utimes(path, new Date(rec.mt), new Date(rec.mt));
    const { owners, sizes, links, nextLink } = snap;
    return new LabFs(inner, structuredClone({ owners, sizes, links, nextLink }));
  }
}
