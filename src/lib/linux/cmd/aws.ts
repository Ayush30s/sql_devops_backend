import jmespath from "jmespath";
import type { Machine } from "../machine.ts";
import type { S3Object } from "../system.ts";
import { human, normalizePath } from "../system.ts";
import type { Ctx } from "./util.ts";
import { command, fail, ok } from "./util.ts";

/**
 * Simulated AWS CLI v2 for account 123456789012. Nothing leaves the lab. Credentials resolve like
 * the real CLI: environment → ~/.aws/credentials profile → the EC2 instance role.
 */

const ACCOUNT = "123456789012";
const INSTANCE_ID = "i-0a1b2c3d4e5f60001";
const KEYS: Record<string, { user: string; admin: boolean; readOnly: boolean }> = {
  AKIAIOSFODNN7EXAMPLE: { user: "alice", admin: true, readOnly: false },
  AKIAI44QH8DHBEXAMPLE: { user: "bob", admin: false, readOnly: true },
};
const S3_FLAGS = new Set(["recursive", "dryrun", "human-readable", "summarize", "delete", "force", "quiet", "only-show-errors", "no-progress", "size-only", "follow", "exact-timestamps", "no-paginate"]);

interface Principal {
  arn: string;
  userId: string;
  kind: "role" | "user";
  name: string;
  admin: boolean;
  readOnly: boolean;
  source: string;
}

class AwsError extends Error {
  code: string;
  op: string;
  exit: number;
  constructor(code: string, op: string, message: string, exit = 254) {
    super(message);
    this.code = code;
    this.op = op;
    this.exit = exit;
  }
}

function parseIni(text: string) {
  const out: Record<string, Record<string, string>> = {};
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = s[1].trim();
      out[section] ??= {};
    } else if (section && line.includes("=") && !line.startsWith("#")) {
      const i = line.indexOf("=");
      out[section][line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

const writeIni = (data: Record<string, Record<string, string>>) =>
  Object.entries(data)
    .map(([s, kv]) => `[${s}]\n${Object.entries(kv).map(([k, v]) => `${k} = ${v}`).join("\n")}\n`)
    .join("\n");

function opArgs(args: string[]) {
  const values: Record<string, string[]> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    if (inline !== undefined) {
      values[name] = [inline];
      continue;
    }
    if (S3_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    const vals: string[] = [];
    while (i + 1 < args.length && !args[i + 1].startsWith("--")) vals.push(args[++i]);
    if (vals.length) values[name] = vals;
    else flags.add(name);
  }
  return { values, flags, positional };
}

const pascal = (s: string) => s.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("");

function toText(v: unknown, label = ""): string[] {
  if (v === null || v === undefined) return ["None"];
  if (typeof v !== "object") return [String(v)];
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== "object" || x === null)) return [v.map((x) => (x === null ? "None" : String(x))).join("\t")];
    if (v.every((x) => Array.isArray(x))) return v.map((row: unknown[]) => row.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("\t"));
    return v.flatMap((x) => toText(x, label));
  }
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const scalars = entries.filter(([, x]) => typeof x !== "object" || x === null);
  const lines = scalars.length ? [`${label ? `${label.toUpperCase()}\t` : ""}${scalars.map(([, x]) => String(x)).join("\t")}`] : [];
  for (const [k, x] of entries) if (typeof x === "object" && x !== null) lines.push(...toText(x, k));
  return lines;
}

function toTable(v: unknown, title: string): string {
  let rows: string[][];
  let header: string[] | undefined;
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    header = [...new Set(v.flatMap((x) => Object.keys(x as object)))];
    rows = v.map((x) => header!.map((h) => String((x as Record<string, unknown>)[h] ?? "")));
  } else if (Array.isArray(v)) rows = v.map((x) => (Array.isArray(x) ? x.flat(3).map(String) : [typeof x === "object" ? JSON.stringify(x) : String(x)]));
  else if (v && typeof v === "object") {
    const flat = Object.entries(v).filter(([, x]) => typeof x !== "object" || x === null);
    header = flat.map(([k]) => k);
    rows = [flat.map(([, x]) => String(x))];
  } else rows = [[String(v)]];
  const all = header ? [header, ...rows] : rows;
  const widths = Array.from({ length: Math.max(1, ...all.map((r) => r.length)) }, (_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)) + 2);
  const total = widths.reduce((a, b) => a + b + 1, 1);
  const width = Math.max(total, title.length + 4);
  const line = (r: string[]) => `|${widths.map((w, i) => ` ${(r[i] ?? "").padEnd(w - 1)}`).join("|")}|`;
  const sep = `+${widths.map((w) => "-".repeat(w)).join("+")}+`;
  const pad = Math.floor((width - 2 - title.length) / 2);
  return [`${"-".repeat(width)}`, `|${" ".repeat(pad)}${title}${" ".repeat(width - 2 - pad - title.length)}|`, sep, ...(header ? [line(header), sep] : []), ...rows.map(line), sep].join("\n") + "\n";
}

export function awsCommands(m: Machine) {
  const fs = m.fs;
  const aws = () => m.state.aws;

  async function readAwsFile(name: string) {
    const home = await m.homeOf(m.user.user);
    return parseIni(await fs.readFile(`${home}/.aws/${name}`).catch(() => ""));
  }

  async function principal(env: Map<string, string>, profile?: string): Promise<Principal> {
    const roleArn = `arn:aws:sts::${ACCOUNT}:assumed-role/${aws().role}/${INSTANCE_ID}`;
    const fromKey = (key: string, source: string): Principal => {
      const known = KEYS[key];
      if (!known) throw new AwsError("InvalidClientTokenId", "GetCallerIdentity", "The security token included in the request is invalid.");
      return { arn: `arn:aws:iam::${ACCOUNT}:user/${known.user}`, userId: `AIDA${known.user.toUpperCase().padEnd(17, "X")}`, kind: "user", name: known.user, admin: known.admin, readOnly: known.readOnly, source };
    };
    const envKey = env.get("AWS_ACCESS_KEY_ID");
    if (envKey && !profile) return fromKey(envKey, "env");
    const creds = await readAwsFile("credentials");
    const name = profile ?? env.get("AWS_PROFILE") ?? "default";
    if (creds[name]?.aws_access_key_id) return fromKey(creds[name].aws_access_key_id, "shared-credentials-file");
    if (name !== "default") {
      const config = await readAwsFile("config");
      if (!config[`profile ${name}`]) throw new AwsError("ProfileNotFound", "", `The config profile (${name}) could not be found`, 255);
    }
    return { arn: roleArn, userId: `AROAMOCKLABROLEID01:${INSTANCE_ID}`, kind: "role", name: aws().role, admin: false, readOnly: false, source: "iam-role" };
  }

  async function region(env: Map<string, string>, explicit?: string, profile?: string) {
    if (explicit) return explicit;
    const fromEnv = env.get("AWS_REGION") ?? env.get("AWS_DEFAULT_REGION");
    if (fromEnv) return fromEnv;
    const config = await readAwsFile("config");
    const name = profile ?? env.get("AWS_PROFILE") ?? "default";
    return config[name === "default" ? "default" : `profile ${name}`]?.region;
  }

  const denied = (p: Principal, action: string, resource: string, op: string) =>
    new AwsError("AccessDenied", op, `User: ${p.arn} is not authorized to perform: ${action} on resource: ${resource} because no identity-based policy allows the ${action} action`);

  function checkS3(p: Principal, bucket: string, write: boolean, op: string) {
    const b = aws().s3[bucket];
    if (b?.denied && !p.admin) throw denied(p, write ? "s3:PutObject" : "s3:ListBucket", `"arn:aws:s3:::${bucket}"`, op);
    if (write && p.readOnly) throw denied(p, "s3:PutObject", `"arn:aws:s3:::${bucket}/*"`, op);
    if (write && p.kind === "role" && bucket !== "acme-app-backups") throw denied(p, "s3:PutObject", `"arn:aws:s3:::${bucket}/*"`, op);
  }

  const s3url = (u: string) => {
    const m2 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u);
    return m2 ? { bucket: m2[1], key: m2[2] } : undefined;
  };

  const bucketOrThrow = (name: string, op: string) => {
    const b = aws().s3[name];
    if (!b) throw new AwsError("NoSuchBucket", op, "The specified bucket does not exist");
    return b;
  };

  const date = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");

  async function localFiles(ctx: Ctx, path: string): Promise<{ rel: string; abs: string }[]> {
    const abs = normalizePath(ctx.cwd, path);
    const st = await fs.stat(abs);
    if (!st.isDirectory) return [{ rel: abs.split("/").pop()!, abs }];
    const out: { rel: string; abs: string }[] = [];
    const walk = async (dir: string) => {
      for (const name of (await fs.readdir(dir)).sort()) {
        const child = `${dir}/${name}`;
        if ((await fs.stat(child)).isDirectory) await walk(child);
        else out.push({ rel: child.slice(abs.length + 1), abs: child });
      }
    };
    await walk(abs);
    return out;
  }

  async function readLocal(abs: string): Promise<S3Object> {
    const st = await fs.stat(abs);
    const data = await fs.readFile(abs);
    return { size: st.size, mtime: Date.now(), ...(data.length <= 262_144 && { body: data }) };
  }

  async function writeLocal(abs: string, obj: S3Object) {
    await fs.writeFile(abs, obj.body ?? "(simulated S3 object content)\n");
    if (obj.body === undefined && obj.size > 32) {
      await m.checkDisk(abs, obj.size, false);
      fs.meta.sizes[abs] = obj.size;
    }
  }

  async function s3(op: string, args: string[], ctx: Ctx, p: Principal): Promise<string> {
    const { flags, values, positional } = opArgs(args);
    const recursive = flags.has("recursive");
    const dry = flags.has("dryrun") ? "(dryrun) " : "";
    if (op === "ls") {
      if (!positional[0]) return Object.entries(aws().s3).sort(([a], [b]) => a.localeCompare(b)).map(([n, b]) => `${date(b.created)} ${n}\n`).join("");
      const target = s3url(positional[0].startsWith("s3://") ? positional[0] : `s3://${positional[0]}`)!;
      const b = bucketOrThrow(target.bucket, "ListObjectsV2");
      checkS3(p, target.bucket, false, "ListObjectsV2");
      const keys = Object.keys(b.objects).filter((k) => k.startsWith(target.key)).sort();
      let out = "";
      let size = 0;
      const fmt = (n: number) => (flags.has("human-readable") ? `${human(n).replace(/([KMG])$/, " $1iB").replace(/^(\d+)$/, "$1 Bytes")}`.padStart(10) : String(n).padStart(10));
      if (recursive) for (const k of keys) {
        size += b.objects[k].size;
        out += `${date(b.objects[k].mtime)} ${fmt(b.objects[k].size)} ${k}\n`;
      }
      else {
        const prefixes = new Set<string>();
        for (const k of keys) {
          const rest = k.slice(target.key.length);
          const slash = rest.indexOf("/");
          if (slash >= 0) prefixes.add(rest.slice(0, slash + 1));
          else {
            size += b.objects[k].size;
            out += `${date(b.objects[k].mtime)} ${fmt(b.objects[k].size)} ${rest}\n`;
          }
        }
        out = [...prefixes].map((x) => `${"PRE".padStart(30)} ${x}\n`).join("") + out;
      }
      if (flags.has("summarize")) out += `\nTotal Objects: ${keys.length}\n   Total Size: ${flags.has("human-readable") ? human(size) : size}\n`;
      return out;
    }
    if (op === "mb" || op === "rb") {
      const target = s3url(positional[0] ?? "");
      if (!target) throw new AwsError("ParamValidation", "", `<S3Uri>: Invalid argument type`, 252);
      if (op === "mb") {
        if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.bucket)) throw new AwsError("InvalidBucketName", "CreateBucket", "The specified bucket is not valid.", 1);
        if (aws().s3[target.bucket]) throw new AwsError("BucketAlreadyOwnedByYou", "CreateBucket", "Your previous request to create the named bucket succeeded and you already own it.", 1);
        if (["test", "backup", "data", "logs", "my-bucket"].includes(target.bucket)) throw new AwsError("BucketAlreadyExists", "CreateBucket", "The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.", 1);
        if (p.readOnly) throw denied(p, "s3:CreateBucket", `"arn:aws:s3:::${target.bucket}"`, "CreateBucket");
        aws().s3[target.bucket] = { created: Date.now(), region: values.region?.[0] ?? "us-east-1", objects: {} };
        return `make_bucket: ${target.bucket}\n`;
      }
      const b = bucketOrThrow(target.bucket, "DeleteBucket");
      checkS3(p, target.bucket, true, "DeleteBucket");
      let out = "";
      if (Object.keys(b.objects).length) {
        if (!flags.has("force")) throw new AwsError("BucketNotEmpty", "DeleteBucket", "The bucket you tried to delete is not empty", 1);
        out += Object.keys(b.objects).map((k) => `delete: s3://${target.bucket}/${k}\n`).join("");
      }
      delete aws().s3[target.bucket];
      return `${out}remove_bucket: ${target.bucket}\n`;
    }
    if (op === "rm") {
      const target = s3url(positional[0] ?? "");
      if (!target) throw new AwsError("ParamValidation", "", "<S3Uri>: Invalid argument type", 252);
      const b = bucketOrThrow(target.bucket, "DeleteObject");
      checkS3(p, target.bucket, true, "DeleteObject");
      const keys = recursive ? Object.keys(b.objects).filter((k) => k.startsWith(target.key)) : b.objects[target.key] ? [target.key] : [];
      let out = "";
      for (const k of keys) {
        if (!dry) delete b.objects[k];
        out += `${dry}delete: s3://${target.bucket}/${k}\n`;
      }
      return out;
    }
    if (op === "cp" || op === "mv" || op === "sync") {
      const [src, dest] = positional;
      if (!src || !dest) throw new AwsError("ParamValidation", "", `the following arguments are required: paths`, 252);
      const from = s3url(src);
      const to = s3url(dest);
      const excludes = (values.exclude ?? []).map((g) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`));
      let out = "";
      const isRecursive = recursive || op === "sync";
      if (!from && to) {
        const b = bucketOrThrow(to.bucket, "PutObject");
        checkS3(p, to.bucket, true, "PutObject");
        const abs = normalizePath(ctx.cwd, src);
        if (!(await fs.inner.exists(abs))) throw new AwsError("NotFound", "", `The user-provided path ${src} does not exist.`, 255);
        const isDir = (await fs.inner.stat(abs)).isDirectory;
        if (isDir && !isRecursive) throw new AwsError("NotFound", "", `upload failed: ${src} to ${dest} [Errno 21] Is a directory: '${abs}'`, 1);
        const files = await localFiles(ctx, src);
        const prefix = isDir ? (to.key && !to.key.endsWith("/") ? `${to.key}/` : to.key) : to.key.endsWith("/") || !to.key ? `${to.key}${files[0].rel}` : to.key;
        const seen = new Set<string>();
        for (const f of files) {
          if (excludes.some((re) => re.test(f.rel))) continue;
          const key = isDir ? `${prefix}${f.rel}` : prefix;
          seen.add(key);
          const obj = await readLocal(f.abs);
          if (op === "sync" && b.objects[key]?.size === obj.size) continue;
          if (!dry) b.objects[key] = obj;
          out += `${dry}upload: ${isDir ? `${src.replace(/\/$/, "")}/${f.rel}` : src} to s3://${to.bucket}/${key}\n`;
          if (op === "mv" && !dry) await fs.rm(f.abs);
        }
        if (op === "sync" && flags.has("delete"))
          for (const k of Object.keys(b.objects).filter((k) => k.startsWith(prefix) && !seen.has(k))) {
            if (!dry) delete b.objects[k];
            out += `${dry}delete: s3://${to.bucket}/${k}\n`;
          }
        return out;
      }
      if (from && !to) {
        const b = bucketOrThrow(from.bucket, "GetObject");
        checkS3(p, from.bucket, false, "GetObject");
        const keys = isRecursive ? Object.keys(b.objects).filter((k) => k.startsWith(from.key)).sort() : [from.key];
        if (!isRecursive && !b.objects[from.key]) throw new AwsError("404", "HeadObject", "Not Found", 1);
        const base = normalizePath(ctx.cwd, dest);
        const destIsDir = isRecursive || dest.endsWith("/") || ((await fs.inner.exists(base)) && (await fs.inner.stat(base)).isDirectory);
        for (const k of keys) {
          const rel = isRecursive ? k.slice(from.key.length).replace(/^\//, "") : k.split("/").pop()!;
          const abs = destIsDir ? normalizePath(base, rel) : base;
          if (op === "sync" && (await fs.inner.exists(abs))) continue;
          if (!dry) {
            const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
            if (!(await fs.inner.exists(dir))) await fs.mkdir(dir, { recursive: true });
            await writeLocal(abs, b.objects[k]);
            if (op === "mv") delete b.objects[k];
          }
          out += `${dry}download: s3://${from.bucket}/${k} to ${destIsDir ? `${dest.replace(/\/$/, "")}/${rel}` : dest}\n`;
        }
        return out;
      }
      if (from && to) {
        const sb = bucketOrThrow(from.bucket, "CopyObject");
        const db = bucketOrThrow(to.bucket, "CopyObject");
        checkS3(p, from.bucket, false, "CopyObject");
        checkS3(p, to.bucket, true, "CopyObject");
        const keys = isRecursive ? Object.keys(sb.objects).filter((k) => k.startsWith(from.key)) : [from.key];
        for (const k of keys) {
          if (!sb.objects[k]) throw new AwsError("NoSuchKey", "CopyObject", "The specified key does not exist.", 1);
          const key = isRecursive ? `${to.key}${k.slice(from.key.length)}` : to.key.endsWith("/") || !to.key ? `${to.key}${k.split("/").pop()}` : to.key;
          if (!dry) db.objects[key] = { ...sb.objects[k], mtime: Date.now() };
          if (op === "mv" && !dry) delete sb.objects[k];
          out += `${dry}copy: s3://${from.bucket}/${k} to s3://${to.bucket}/${key}\n`;
        }
        return out;
      }
      throw new AwsError("ParamValidation", "", "Error: Invalid argument type", 252);
    }
    if (op === "presign") {
      const target = s3url(positional[0] ?? "");
      if (!target) throw new AwsError("ParamValidation", "", "<S3Uri>: Invalid argument type", 252);
      bucketOrThrow(target.bucket, "GetObject");
      return `https://${target.bucket}.s3.us-east-1.amazonaws.com/${target.key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAMOCKLAB0EXAMPLE1%2F20261002%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Expires=${values["expires-in"]?.[0] ?? 3600}&X-Amz-SignedHeaders=host&X-Amz-Signature=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0\n`;
    }
    throw new AwsError("Usage", "", `aws: error: argument subcommand: Invalid choice, valid choices are:\n\nls | cp | mv | rm | sync | mb | rb | presign`, 252);
  }

  function filterInstances(filters: string[]) {
    let list = aws().instances as Record<string, unknown>[];
    const parsed: { name: string; values: string[] }[] = [];
    for (const f of filters) {
      if (f.trim().startsWith("[")) {
        for (const x of JSON.parse(f) as { Name: string; Values: string[] }[]) parsed.push({ name: x.Name, values: x.Values });
        continue;
      }
      const m2 = /Name=([^,]+),Values=(.+)/.exec(f);
      if (m2) parsed.push({ name: m2[1], values: m2[2].split(",") });
    }
    const tag = (i: Record<string, unknown>, k: string) => (i.Tags as { Key: string; Value: string }[]).find((t) => t.Key === k)?.Value;
    const get = (i: Record<string, unknown>, name: string): string | undefined => {
      if (name.startsWith("tag:")) return tag(i, name.slice(4));
      const map: Record<string, unknown> = {
        "instance-state-name": (i.State as { Name: string }).Name, "instance-type": i.InstanceType, "instance-id": i.InstanceId, "private-ip-address": i.PrivateIpAddress,
        "vpc-id": i.VpcId, "subnet-id": i.SubnetId, "availability-zone": (i.Placement as { AvailabilityZone: string }).AvailabilityZone, "image-id": i.ImageId, "key-name": i.KeyName,
      };
      return map[name] as string | undefined;
    };
    for (const f of parsed) {
      const res = f.values.map((v) => new RegExp(`^${v.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`));
      list = list.filter((i) => (f.name === "tag-key" ? (i.Tags as { Key: string }[]).some((t) => res.some((r) => r.test(t.Key))) : res.some((r) => r.test(get(i, f.name) ?? ""))));
    }
    return list;
  }

  function ec2(op: string, args: string[], p: Principal) {
    const { values } = opArgs(args);
    const ids = values["instance-ids"] ?? [];
    const pickInstances = () => {
      let list = filterInstances(values.filters ?? []);
      if (ids.length) {
        const missing = ids.find((id) => !list.some((i) => i.InstanceId === id) && !aws().instances.some((i) => i.InstanceId === id));
        if (missing) throw new AwsError("InvalidInstanceID.NotFound", op === "describe-instances" ? "DescribeInstances" : pascal(op), `The instance ID '${missing}' does not exist`);
        list = list.filter((i) => ids.includes(i.InstanceId as string));
      }
      return list;
    };
    switch (op) {
      case "describe-instances":
        return { Reservations: pickInstances().map((i, n) => ({ Groups: [], Instances: [i], OwnerId: ACCOUNT, ReservationId: `r-0${(n + 1).toString(16).padStart(16, "a")}` })) };
      case "describe-instance-status":
        return { InstanceStatuses: pickInstances().filter((i) => (i.State as { Name: string }).Name === "running").map((i) => ({ AvailabilityZone: (i.Placement as { AvailabilityZone: string }).AvailabilityZone, InstanceId: i.InstanceId, InstanceState: i.State, InstanceStatus: { Details: [{ Name: "reachability", Status: "passed" }], Status: "ok" }, SystemStatus: { Details: [{ Name: "reachability", Status: "passed" }], Status: "ok" } })) };
      case "start-instances":
      case "stop-instances":
      case "reboot-instances": {
        if (!ids.length) throw new AwsError("MissingParameter", pascal(op), "The request must contain the parameter InstanceId");
        const action = op === "start-instances" ? "ec2:StartInstances" : op === "stop-instances" ? "ec2:StopInstances" : "ec2:RebootInstances";
        if (!p.admin) throw new AwsError("UnauthorizedOperation", pascal(op), `You are not authorized to perform this operation. User: ${p.arn} is not authorized to perform: ${action} on resource: arn:aws:ec2:us-east-1:${ACCOUNT}:instance/${ids[0]} because no identity-based policy allows the ${action} action. Encoded authorization failure message: AbCdEf...`);
        const list = pickInstances();
        if (op !== "start-instances" && ids.includes(INSTANCE_ID)) throw new AwsError("OperationNotPermitted", pascal(op), `${INSTANCE_ID} is the instance this lab runs on; stopping it is blocked here.`);
        if (op === "reboot-instances") return {};
        const key = op === "start-instances" ? "StartingInstances" : "StoppingInstances";
        return {
          [key]: list.map((i) => {
            const prev = i.State as { Code: number; Name: string };
            const next = op === "start-instances" ? { Code: 16, Name: "running" } : { Code: 80, Name: "stopped" };
            i.State = next;
            if (op === "stop-instances") delete i.PublicIpAddress;
            return { CurrentState: op === "start-instances" ? { Code: 0, Name: "pending" } : { Code: 64, Name: "stopping" }, InstanceId: i.InstanceId, PreviousState: prev };
          }),
        };
      }
      case "describe-volumes":
        return {
          Volumes: [
            { Attachments: [{ Device: "/dev/sda1", InstanceId: INSTANCE_ID, State: "attached", DeleteOnTermination: true }], AvailabilityZone: "us-east-1a", Encrypted: true, Size: 8, State: "in-use", VolumeId: "vol-0a1b2c3d4e5f6a001", VolumeType: "gp3", Iops: 3000 },
            { Attachments: [{ Device: "/dev/sdf", InstanceId: INSTANCE_ID, State: "attached", DeleteOnTermination: false }], AvailabilityZone: "us-east-1a", Encrypted: true, Size: 20, State: "in-use", VolumeId: "vol-0a1b2c3d4e5f6a002", VolumeType: "gp3", Iops: 3000 },
            { Attachments: [{ Device: "/dev/sda1", InstanceId: "i-0a1b2c3d4e5f60003", State: "attached", DeleteOnTermination: true }], AvailabilityZone: "us-east-1b", Encrypted: true, Size: 100, State: "in-use", VolumeId: "vol-0a1b2c3d4e5f6a003", VolumeType: "io2", Iops: 8000 },
            { Attachments: [], AvailabilityZone: "us-east-1a", Encrypted: false, Size: 50, State: "available", VolumeId: "vol-0a1b2c3d4e5f6a004", VolumeType: "gp2", Iops: 150 },
          ],
        };
      case "describe-security-groups":
        return {
          SecurityGroups: [
            { GroupId: "sg-0web0web0", GroupName: "acme-web", Description: "Web servers", VpcId: "vpc-0a1b2c3d4e5f", IpPermissions: [{ IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "203.0.113.0/24", Description: "Office VPN" }] }] },
            { GroupId: "sg-0db0db0db", GroupName: "acme-db", Description: "Database", VpcId: "vpc-0a1b2c3d4e5f", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: "sg-0web0web0" }] }] },
          ].filter((g) => !values["group-ids"] || values["group-ids"].includes(g.GroupId)),
        };
      case "describe-regions":
        return { Regions: ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "ap-south-1"].map((r) => ({ Endpoint: `ec2.${r}.amazonaws.com`, RegionName: r, OptInStatus: "opt-in-not-required" })) };
    }
    throw new AwsError("Usage", "", `aws: error: argument operation: Invalid choice, valid choices are:\n\ndescribe-instances | describe-instance-status | start-instances\nstop-instances | reboot-instances | describe-volumes\ndescribe-security-groups | describe-regions`, 252);
  }

  function matchesPattern(msg: string, pattern?: string) {
    if (!pattern) return true;
    const terms = pattern.match(/"[^"]*"|\S+/g) ?? [];
    const any = terms.filter((t) => t.startsWith("?")).map((t) => t.slice(1).replace(/"/g, ""));
    const all = terms.filter((t) => !t.startsWith("?")).map((t) => t.replace(/"/g, ""));
    return all.every((t) => msg.includes(t)) && (!any.length || any.some((t) => msg.includes(t)));
  }

  function logs(op: string, args: string[]) {
    const { values, flags, positional } = opArgs(args);
    const groups = aws().logGroups;
    const groupName = values["log-group-name"]?.[0] ?? positional[0];
    const group = () => {
      const g = groups[groupName ?? ""];
      if (!g) throw new AwsError("ResourceNotFoundException", op === "tail" ? "FilterLogEvents" : pascal(op), "The specified log group does not exist.");
      return g;
    };
    switch (op) {
      case "describe-log-groups":
        return { logGroups: Object.keys(groups).filter((g) => g.startsWith(values["log-group-name-prefix"]?.[0] ?? "")).map((g) => ({ logGroupName: g, creationTime: Date.now() - 300 * 86400_000, metricFilterCount: 0, arn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${g}:*`, storedBytes: 1048576 * (g.length % 7 + 1) })) };
      case "describe-log-streams":
        return { logStreams: [...new Set(group().map((e) => e.stream))].map((s) => ({ logStreamName: s, creationTime: Date.now() - 86400_000, lastEventTimestamp: Date.now() - 600_000, storedBytes: 0 })) };
      case "filter-log-events": {
        const since = Number(values["start-time"]?.[0] ?? 0);
        const events = group().filter((e) => e.t >= since && matchesPattern(e.msg, values["filter-pattern"]?.[0]) && (!values["log-stream-names"] || values["log-stream-names"].includes(e.stream)));
        return { events: events.map((e, i) => ({ logStreamName: e.stream, timestamp: e.t, message: e.msg, ingestionTime: e.t + 400, eventId: `3780${i}` })), searchedLogStreams: [] };
      }
      case "tail": {
        const since = values.since?.[0] ?? "10m";
        const m2 = /^(\d+)([smhdw])$/.exec(since);
        const ms = m2 ? Number(m2[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m2[2] as "s"]! * 1000 : 600_000;
        const events = group().filter((e) => e.t >= Date.now() - ms && matchesPattern(e.msg, values["filter-pattern"]?.[0]));
        const short = values.format?.[0] === "short";
        const text = events.map((e) => (short ? `${new Date(e.t).toISOString().slice(0, 19)} ${e.msg}` : `${new Date(e.t).toISOString().replace("Z", "000+00:00")} ${e.stream} ${e.msg}`)).join("\n");
        return { __text: (text ? `${text}\n` : "") + (flags.has("follow") ? "(--follow keeps streaming until Ctrl+C in a real terminal)\n" : "") };
      }
    }
    throw new AwsError("Usage", "", `aws: error: argument operation: Invalid choice, valid choices are:\n\ndescribe-log-groups | describe-log-streams | filter-log-events | tail`, 252);
  }

  function iam(op: string, args: string[], p: Principal) {
    const { values } = opArgs(args);
    const action = `iam:${pascal(op)}`;
    if (p.kind === "role") throw denied(p, action, `arn:aws:iam::${ACCOUNT}:user/`, pascal(op));
    const { users, roles } = aws().iam;
    const userObj = (u: (typeof users)[number]) => ({ Path: "/", UserName: u.UserName, UserId: `AIDA${u.UserName.toUpperCase().padEnd(17, "X")}`, Arn: `arn:aws:iam::${ACCOUNT}:user/${u.UserName}`, CreateDate: new Date(u.created).toISOString() });
    const roleObj = (r: (typeof roles)[number]) => ({ Path: "/", RoleName: r.RoleName, RoleId: `AROA${r.RoleName.toUpperCase().replace(/-/g, "").slice(0, 17)}`, Arn: `arn:aws:iam::${ACCOUNT}:role/${r.RoleName}`, CreateDate: new Date(r.created).toISOString(), AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: r.trust }, Action: "sts:AssumeRole" }] } });
    const findUser = (name?: string) => {
      const u = users.find((x) => x.UserName === (name ?? p.name));
      if (!u) throw new AwsError("NoSuchEntity", pascal(op), `The user with name ${name} cannot be found.`);
      return u;
    };
    const findRole = (name?: string) => {
      const r = roles.find((x) => x.RoleName === name);
      if (!r) throw new AwsError("NoSuchEntity", pascal(op), `The role with name ${name} cannot be found.`);
      return r;
    };
    const policy = (n: string) => ({ PolicyName: n, PolicyArn: `arn:aws:iam::aws:policy/${n.startsWith("AWSLambda") ? "service-role/" : ""}${n}` });
    switch (op) {
      case "list-users":
        return { Users: users.map(userObj) };
      case "get-user":
        return { User: userObj(findUser(values["user-name"]?.[0])) };
      case "list-roles":
        return { Roles: roles.map(roleObj) };
      case "get-role":
        return { Role: roleObj(findRole(values["role-name"]?.[0])) };
      case "list-attached-user-policies":
        return { AttachedPolicies: findUser(values["user-name"]?.[0]).policies.map(policy) };
      case "list-attached-role-policies":
        return { AttachedPolicies: findRole(values["role-name"]?.[0]).policies.map(policy) };
      case "list-groups-for-user":
        return { Groups: findUser(values["user-name"]?.[0]).groups.map((g) => ({ Path: "/", GroupName: g, Arn: `arn:aws:iam::${ACCOUNT}:group/${g}` })) };
    }
    throw new AwsError("Usage", "", `aws: error: argument operation: Invalid choice, valid choices are:\n\nlist-users | get-user | list-roles | get-role\nlist-attached-user-policies | list-attached-role-policies | list-groups-for-user`, 252);
  }

  async function configure(op: string | undefined, args: string[], ctx: Ctx, profile: string | undefined) {
    const home = await m.homeOf(m.user.user);
    const name = profile ?? ctx.env.get("AWS_PROFILE") ?? "default";
    const { positional } = opArgs(args);
    const credKeys = ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"];
    if (!op)
      return `(aws configure asks four questions interactively, which this lab terminal can't do.)\nSet each value directly instead:\n  aws configure set aws_access_key_id AKIA...\n  aws configure set aws_secret_access_key ...\n  aws configure set region us-east-1\n  aws configure set output json\n`;
    if (op === "set" || op === "get") {
      const key = positional[0];
      if (!key) throw new AwsError("Usage", "", `aws: error: the following arguments are required: varname`, 252);
      const file = credKeys.includes(key) ? "credentials" : "config";
      const section = file === "config" && name !== "default" ? `profile ${name}` : name;
      const data = await readAwsFile(file);
      if (op === "get") {
        const v = data[section]?.[key];
        if (v === undefined) throw new AwsError("NotSet", "", "", 1);
        return `${v}\n`;
      }
      if (positional[1] === undefined) throw new AwsError("Usage", "", `aws: error: the following arguments are required: value`, 252);
      (data[section] ??= {})[key] = positional[1];
      if (!(await fs.inner.exists(`${home}/.aws`))) await fs.mkdir(`${home}/.aws`);
      await fs.writeFile(`${home}/.aws/${file}`, writeIni(data));
      if (file === "credentials") await fs.chmod(`${home}/.aws/credentials`, 0o600);
      return "";
    }
    if (op === "list-profiles") {
      const names = new Set<string>(Object.keys(await readAwsFile("credentials")));
      for (const s of Object.keys(await readAwsFile("config"))) names.add(s.replace(/^profile /, ""));
      return [...names].map((n) => `${n}\n`).join("");
    }
    if (op === "list") {
      let p: Principal | undefined;
      try {
        p = await principal(ctx.env, profile);
      } catch {
        p = undefined;
      }
      const key = p?.source === "iam-role" ? "ASIAMOCKLAB0EXAMPLE1" : p ? Object.entries(KEYS).find(([, v]) => v.user === p!.name)?.[0] ?? "" : "";
      const r = await region(ctx.env, undefined, profile);
      const src = p?.source === "shared-credentials-file" ? "~/.aws/credentials" : "";
      const row = (n: string, v: string, t: string, l: string) => `${n.padStart(10)} ${v.padStart(24)} ${t.padStart(16)}    ${l}`;
      return [
        row("Name", "Value", "Type", "Location"), row("----", "-----", "----", "--------"),
        row("profile", profile ?? "<not set>", profile ? "manual" : "None", profile ? "--profile" : "None"),
        row("access_key", key ? `****************${key.slice(-4)}` : "<not set>", p?.source ?? "None", src),
        row("secret_key", key ? "****************xxxx" : "<not set>", p?.source ?? "None", src),
        row("region", r ?? "<not set>", r ? "config-file" : "None", r ? "~/.aws/config" : ""),
      ].join("\n") + "\n";
    }
    throw new AwsError("Usage", "", `aws: error: argument operation: Invalid choice, valid choices are:\n\nlist | get | set | list-profiles`, 252);
  }

  const cli = command("aws", async (args, ctx) => {
    let regionArg: string | undefined;
    let output: string | undefined;
    let query: string | undefined;
    let profile: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--region") regionArg = args[++i];
      else if (a === "--output") output = args[++i];
      else if (a === "--query") query = args[++i];
      else if (a === "--profile") profile = args[++i];
      else if (a.startsWith("--region=")) regionArg = a.slice(9);
      else if (a.startsWith("--output=")) output = a.slice(9);
      else if (a.startsWith("--query=")) query = a.slice(8);
      else if (a.startsWith("--profile=")) profile = a.slice(10);
      else if (["--no-cli-pager", "--debug", "--no-paginate", "--no-verify-ssl"].includes(a)) continue;
      else rest.push(a);
    }
    if (rest[0] === "--version" || args[0] === "--version") return ok(`aws-cli/2.17.20 Python/3.11.9 Linux/6.8.0-1012-aws exe/x86_64.ubuntu.24\n`);
    const [service, op, ...opRest] = rest;
    if (!service) return fail("usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\nTo see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help\n\naws: error: the following arguments are required: command", 252);
    if (service === "help") return ok(`AWS()\n\nNAME\n       aws - (simulated) Amazon Web Services command line interface\n\nAVAILABLE SERVICES IN THIS LAB\n       o configure   o ec2   o iam   o logs   o s3   o s3api   o sts\n\nSYNOPSIS\n       aws [options] <command> <subcommand> [parameters]\n\nOPTIONS\n       --region, --output (json|text|table), --query (JMESPath), --profile\n`);
    try {
      if (service === "configure") return ok(await configure(op, opRest, ctx, profile));
      if (!["sts", "s3", "s3api", "ec2", "logs", "iam"].includes(service))
        return fail(`usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\n\naws: error: argument command: Invalid choice, valid choices are:\n\nconfigure | ec2 | iam | logs | s3 | s3api | sts\n\n(Only these services are simulated in this lab.)`, 252);
      if (!op || op === "help") return ok(`(simulated) aws ${service} — try one of the operations listed in the lessons, e.g. aws ${service === "s3" ? "s3 ls" : service === "ec2" ? "ec2 describe-instances" : service === "logs" ? "logs describe-log-groups" : service === "iam" ? "iam list-users" : "sts get-caller-identity"}\n`);
      const p = await principal(ctx.env, profile);
      if (service === "s3") return ok(await s3(op, opRest, ctx, p));
      const reg = await region(ctx.env, regionArg, profile);
      if ((service === "ec2" || service === "logs") && !reg) return fail(`You must specify a region. You can also configure your region by running "aws configure".`, 253);
      let result: unknown;
      if (service === "sts") {
        if (op !== "get-caller-identity") throw new AwsError("Usage", "", `aws: error: argument operation: Invalid choice, valid choices are:\n\nget-caller-identity`, 252);
        result = { UserId: p.userId, Account: ACCOUNT, Arn: p.arn };
      } else if (service === "ec2") result = ec2(op, opRest, p);
      else if (service === "logs") result = logs(op, opRest);
      else if (service === "iam") result = iam(op, opRest, p);
      else {
        const { values } = opArgs(opRest);
        if (op === "list-buckets") result = { Buckets: Object.entries(aws().s3).map(([n, b]) => ({ Name: n, CreationDate: new Date(b.created).toISOString() })), Owner: { DisplayName: "acme-root", ID: "a1b2c3" } };
        else if (op === "list-objects-v2") {
          const bucket = values.bucket?.[0] ?? "";
          const b = bucketOrThrow(bucket, "ListObjectsV2");
          checkS3(p, bucket, false, "ListObjectsV2");
          const keys = Object.keys(b.objects).filter((k) => k.startsWith(values.prefix?.[0] ?? "")).sort();
          result = { Contents: keys.map((k) => ({ Key: k, LastModified: new Date(b.objects[k].mtime).toISOString(), Size: b.objects[k].size, StorageClass: "STANDARD" })), KeyCount: keys.length, Name: bucket, Prefix: values.prefix?.[0] ?? "" };
        } else if (op === "head-object") {
          const b = bucketOrThrow(values.bucket?.[0] ?? "", "HeadObject");
          const o = b.objects[values.key?.[0] ?? ""];
          if (!o) throw new AwsError("404", "HeadObject", "Not Found");
          result = { AcceptRanges: "bytes", LastModified: new Date(o.mtime).toUTCString(), ContentLength: o.size, ContentType: "binary/octet-stream", ServerSideEncryption: "AES256" };
        } else throw new AwsError("Usage", "", "aws: error: argument operation: Invalid choice, valid choices are:\n\nlist-buckets | list-objects-v2 | head-object", 252);
      }
      if (result && typeof result === "object" && "__text" in result) return ok((result as { __text: string }).__text);
      if (query) {
        try {
          result = jmespath.search(result, query);
        } catch (e) {
          return fail(`\nBad value for --query ${query}: ${(e as Error).message}\n`, 252);
        }
      }
      const config = await readAwsFile("config");
      const fmt = output ?? ctx.env.get("AWS_DEFAULT_OUTPUT") ?? config[profile ? `profile ${profile}` : "default"]?.output ?? "json";
      if (result === null || result === undefined) return ok(fmt === "json" ? "null\n" : "None\n");
      if (fmt === "text") return ok(`${toText(result).join("\n")}\n`);
      if (fmt === "table") return ok(toTable(result, pascal(op)));
      return ok(`${JSON.stringify(result, null, 4)}\n`);
    } catch (e) {
      if (!(e instanceof AwsError)) throw e;
      if (e.code === "Usage" || e.code === "ParamValidation" || e.code === "NotFound" || e.code === "ProfileNotFound") return fail(e.message, e.exit);
      if (e.code === "NotSet") return ok("", "", 1);
      const where = e.op ? ` when calling the ${e.op} operation` : "";
      return fail(`\nAn error occurred (${e.code})${where}: ${e.message}`, e.exit);
    }
  });

  return [cli];
}

