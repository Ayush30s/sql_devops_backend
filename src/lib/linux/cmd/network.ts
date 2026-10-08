import { createHash, randomBytes } from "node:crypto";
import type { Machine } from "../machine.ts";
import type { Proc } from "../system.ts";
import { HOSTNAME, normalizePath, readGroups, readPasswd, rng } from "../system.ts";
import { comm } from "./process.ts";
import type { Ctx } from "./util.ts";
import { command, fail, ok, parseArgs } from "./util.ts";

interface HostInfo {
  ip: string;
  up: boolean;
  ms: number;
  ports?: number[];
  cname?: string;
}

const DNS: Record<string, HostInfo> = {
  "db.internal": { ip: "10.0.2.15", up: true, ms: 0.6, ports: [22, 5432] },
  "web-2.internal": { ip: "10.0.1.50", up: true, ms: 0.4, ports: [22, 80] },
  "cache.internal": { ip: "10.0.2.20", up: false, ms: 0, ports: [6379] },
  "bastion.internal": { ip: "10.0.0.5", up: false, ms: 0, ports: [22] },
  "example.com": { ip: "93.184.215.14", up: true, ms: 11.8, ports: [80, 443] },
  "www.example.com": { ip: "93.184.215.14", up: true, ms: 11.8, ports: [80, 443], cname: "example.com" },
  "google.com": { ip: "142.250.72.14", up: true, ms: 1.9, ports: [80, 443] },
  "www.google.com": { ip: "142.250.72.4", up: true, ms: 1.9, ports: [80, 443] },
  "github.com": { ip: "140.82.113.3", up: true, ms: 8.3, ports: [22, 80, 443] },
  "api.github.com": { ip: "140.82.113.6", up: true, ms: 8.4, ports: [443] },
  "aws.amazon.com": { ip: "18.238.243.27", up: true, ms: 1.2, ports: [80, 443] },
  "s3.amazonaws.com": { ip: "52.217.12.62", up: true, ms: 1.1, ports: [80, 443] },
  "checkip.amazonaws.com": { ip: "3.220.57.224", up: true, ms: 1.4, ports: [80, 443] },
  "ifconfig.me": { ip: "34.160.111.145", up: true, ms: 2.2, ports: [80, 443] },
  "api.payments.example": { ip: "198.51.100.200", up: false, ms: 0, ports: [443] },
  "archive.ubuntu.com": { ip: "185.125.190.81", up: true, ms: 75.1, ports: [80] },
};

const SELF = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "10.0.1.23", HOSTNAME, `${HOSTNAME}.ec2.internal`];
const SERVICES: Record<number, string> = { 22: "ssh", 53: "domain", 80: "http", 443: "https", 3000: "hbci", 5432: "postgresql", 6379: "redis", 8000: "irdmi", 8080: "http-alt" };
const SSH_HOSTS: Record<string, { name: string; users: string[] }> = {
  "10.0.1.50": { name: "web-2", users: ["ubuntu", "deploy"] },
  "203.0.113.11": { name: "web-2", users: ["ubuntu", "deploy"] },
  "10.0.2.15": { name: "db-1", users: ["ubuntu"] },
  "10.0.1.23": { name: HOSTNAME, users: ["student", "ubuntu", "deploy"] },
  "127.0.0.1": { name: HOSTNAME, users: ["student", "ubuntu", "deploy"] },
};

export interface Resolved {
  name: string;
  ip: string;
  info: HostInfo;
  self: boolean;
}

/** Resolves like glibc: /etc/hosts first (when `useHostsFile`), then the simulated DNS. */
export async function resolveHost(m: Machine, raw: string, useHostsFile = true): Promise<Resolved | undefined> {
  const name = raw.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (SELF.includes(name)) return { name, ip: name === "localhost" || name === "::1" ? "127.0.0.1" : name === "0.0.0.0" ? "0.0.0.0" : "10.0.1.23", info: { ip: "127.0.0.1", up: true, ms: 0.03 }, self: true };
  if (useHostsFile) {
    const hosts = (await m.fs.inner.readFile("/etc/hosts").catch(() => "")).split("\n");
    for (const line of hosts) {
      const [ip, ...names] = line.replace(/#.*/, "").trim().split(/\s+/);
      if (ip && names.map((n) => n.toLowerCase()).includes(name)) return resolveIp(ip, name);
    }
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return resolveIp(name, name);
  const info = DNS[name];
  return info ? { name, ip: info.ip, info, self: false } : undefined;
}

function resolveIp(ip: string, name: string): Resolved {
  if (SELF.includes(ip)) return { name, ip, info: { ip, up: true, ms: 0.03 }, self: true };
  const known = Object.values(DNS).find((d) => d.ip === ip);
  if (known) return { name, ip, info: known, self: false };
  const isPrivate = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
  return { name, ip, info: { ip, up: !isPrivate, ms: isPrivate ? 0 : 14.2, ports: isPrivate ? [] : [80, 443] }, self: false };
}

const fmtMs = (ms: number, r: ReturnType<typeof rng>) => (ms * (0.9 + r.next() * 0.25)).toFixed(ms < 1 ? 3 : 1);

interface HttpResponse {
  status: number;
  reason: string;
  headers: [string, string][];
  body: string;
}

type HttpResult = { ok: true; res: HttpResponse; ip: string; port: number } | { ok: false; code: number; message: string };

const REASONS: Record<number, string> = { 200: "OK", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Not Allowed", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };

const nginxPage = (status: number) =>
  `<html>\r\n<head><title>${status} ${REASONS[status]}</title></head>\r\n<body>\r\n<center><h1>${status} ${REASONS[status]}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`;

function response(status: number, body: string, type = "text/html", server = "nginx", extra: [string, string][] = []): HttpResponse {
  return {
    status,
    reason: REASONS[status] ?? "",
    headers: [["Server", server], ["Date", new Date().toUTCString()], ["Content-Type", type], ["Content-Length", String(Buffer.byteLength(body))], ["Connection", "keep-alive"], ...extra],
    body,
  };
}

const CONTENT_TYPES: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", txt: "text/plain", png: "image/png" };

export function networkCommands(m: Machine) {
  const fs = m.fs;
  const state = () => m.state;

  const webapp = (path: string) =>
    path === "/health"
      ? response(200, '{"status":"ok"}', "application/json", "", [])
      : response(200, JSON.stringify({ service: "acme-store", path }), "application/json", "", []);

  /** A service's answer: its route table when an incident gave it one, else the stock webapp. */
  async function serve(unit: string, method: string, path: string, body: string): Promise<HttpResponse> {
    const text = `${path} ${body}`;
    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = (v: string, pattern?: string) =>
      new RegExp(pattern ? pattern.replace(/\{v\}/g, escape(v)) : `(^|[^\\w])${escape(v)}($|[^\\w])`).test(text);
    let match = "";
    const route = state().http?.[unit]?.find(
      (r) =>
        (!r.method || r.method === method) &&
        new RegExp(r.path).test(path) &&
        (!r.request || new RegExp(r.request).test(body)) &&
        (!r.any || r.any.some((v) => named(v, r.anyPattern) && (match = v))),
    );
    if (!route) return unit === "webapp" ? webapp(path) : response(404, '{"error":"not_found"}', "application/json", "");
    const groups = new RegExp(route.path).exec(path) ?? [];
    const fill = (s: string) => s.replace(/\{match\}/g, match).replace(/\{(\d)\}/g, (_, i: string) => groups[Number(i)] ?? "");
    if (route.log) await fs.inner.appendFile(route.log.file, `${fill(route.log.line).replace("{ts}", new Date().toISOString().replace("T", " ").slice(0, 23))}\n`).catch(() => {});
    return response(route.status, fill(route.body), route.type ?? "application/json", "");
  }

  async function localHttp(proc: Proc, method: string, url: URL, body = ""): Promise<HttpResponse | number> {
    const path = decodeURIComponent(url.pathname);
    if (proc.unit === "nginx") {
      let res: HttpResponse;
      if (path.startsWith("/api/")) {
        const app = state().units.webapp;
        const upstream = app?.active ? await serve("webapp", method, path.slice(4), body) : undefined;
        res = upstream ? { ...upstream, headers: upstream.headers.map(([k, v]) => (k === "Server" ? [k, "nginx"] : [k, v]) as [string, string]) } : response(502, nginxPage(502));
      } else {
        const file = normalizePath("/", `/var/www/html${path.endsWith("/") ? `${path}index.html` : path}`);
        const st = (await fs.inner.exists(file)) ? await fs.inner.stat(file) : undefined;
        if (st?.isDirectory) res = response(301, nginxPage(301), "text/html", "nginx", [["Location", `${url.origin}${path}/`]]);
        else if (st) res = response(200, await fs.inner.readFile(file), CONTENT_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream", "nginx", [["Last-Modified", st.mtime.toUTCString()], ["ETag", `"${st.mtime.getTime().toString(16)}-${st.size.toString(16)}"`], ["Accept-Ranges", "bytes"]]);
        else res = response(404, nginxPage(404));
      }
      const t = new Date();
      const stamp = `${String(t.getUTCDate()).padStart(2, "0")}/${t.toUTCString().split(" ")[2]}/${t.getUTCFullYear()}:${t.toISOString().slice(11, 19)} +0000`;
      await fs.inner.appendFile("/var/log/nginx/access.log", `127.0.0.1 - - [${stamp}] "${method} ${url.pathname}${url.search} HTTP/1.1" ${res.status} ${Buffer.byteLength(res.body)} "-" "curl/8.5.0"\n`).catch(() => {});
      return res;
    }
    if (proc.unit === "webapp" || (proc.unit && state().http?.[proc.unit])) return serve(proc.unit, method, path, body);
    if (/http\.server/.test(proc.cmd)) {
      const root = proc.cwd ?? "/home/student";
      const target = normalizePath(root, path);
      if (!(await fs.inner.exists(target))) return response(404, "<!DOCTYPE HTML>\n<html><body><h1>Error response</h1><p>Error code: 404</p></body></html>\n", "text/html", "SimpleHTTP/0.6 Python/3.12.3");
      if ((await fs.inner.stat(target)).isDirectory) {
        const items = (await fs.inner.readdir(target)).sort().map((n) => `<li><a href="${n}">${n}</a></li>`).join("\n");
        return response(200, `<!DOCTYPE HTML>\n<html>\n<head><title>Directory listing for ${path}</title></head>\n<body>\n<h1>Directory listing for ${path}</h1>\n<hr>\n<ul>\n${items}\n</ul>\n<hr>\n</body>\n</html>\n`, "text/html; charset=utf-8", "SimpleHTTP/0.6 Python/3.12.3");
      }
      return response(200, await fs.inner.readFile(target), "text/plain", "SimpleHTTP/0.6 Python/3.12.3");
    }
    return 52;
  }

  const IMDS_TOKEN = "AQAEAMockImdsV2TokenForTheLab_xYz9Q==";
  function imds(method: string, path: string, headers: Record<string, string>): HttpResponse {
    const plain = (status: number, body: string) => ({ status, reason: REASONS[status] ?? "", headers: [["Content-Type", "text/plain"], ["Content-Length", String(body.length)], ["Server", "EC2ws"]] as [string, string][], body });
    if (path === "/latest/api/token") {
      if (method !== "PUT") return plain(405, "");
      if (!headers["x-aws-ec2-metadata-token-ttl-seconds"]) return plain(400, "");
      return plain(200, IMDS_TOKEN);
    }
    if (!headers["x-aws-ec2-metadata-token"]?.startsWith("AQAE")) return plain(401, "");
    const now = new Date();
    const creds = { Code: "Success", LastUpdated: now.toISOString(), Type: "AWS-HMAC", AccessKeyId: "ASIAMOCKLAB0EXAMPLE1", SecretAccessKey: "mock/lab/secret/not-a-real-credential", Token: "IQoJb3JpZ2luX2VjEMock//LabToken==", Expiration: new Date(now.getTime() + 6 * 3600_000).toISOString() };
    const data: Record<string, string> = {
      "/latest/meta-data/": "ami-id\nami-launch-index\nhostname\niam/\ninstance-id\ninstance-type\nlocal-hostname\nlocal-ipv4\nmac\nplacement/\npublic-hostname\npublic-ipv4\nsecurity-groups",
      "/latest/meta-data/ami-id": "ami-0e86e20dae9224db8",
      "/latest/meta-data/ami-launch-index": "0",
      "/latest/meta-data/instance-id": "i-0a1b2c3d4e5f60001",
      "/latest/meta-data/instance-type": "t3.small",
      "/latest/meta-data/hostname": `${HOSTNAME}.ec2.internal`,
      "/latest/meta-data/local-hostname": `${HOSTNAME}.ec2.internal`,
      "/latest/meta-data/local-ipv4": "10.0.1.23",
      "/latest/meta-data/public-ipv4": "203.0.113.10",
      "/latest/meta-data/public-hostname": "ec2-203-0-113-10.compute-1.amazonaws.com",
      "/latest/meta-data/mac": "0a:1b:2c:3d:4e:5f",
      "/latest/meta-data/placement/": "availability-zone\nregion",
      "/latest/meta-data/placement/availability-zone": "us-east-1a",
      "/latest/meta-data/placement/region": "us-east-1",
      "/latest/meta-data/security-groups": "acme-web",
      "/latest/meta-data/iam/": "info\nsecurity-credentials/",
      "/latest/meta-data/iam/info": JSON.stringify({ Code: "Success", LastUpdated: now.toISOString(), InstanceProfileArn: "arn:aws:iam::123456789012:instance-profile/webapp-ec2-role", InstanceProfileId: "AIPAMOCKLABPROFILE01" }, null, 2),
      "/latest/meta-data/iam/security-credentials/": "webapp-ec2-role",
      "/latest/meta-data/iam/security-credentials/webapp-ec2-role": JSON.stringify(creds, null, 2),
      "/latest/dynamic/instance-identity/document": JSON.stringify({ accountId: "123456789012", architecture: "x86_64", availabilityZone: "us-east-1a", imageId: "ami-0e86e20dae9224db8", instanceId: "i-0a1b2c3d4e5f60001", instanceType: "t3.small", privateIp: "10.0.1.23", region: "us-east-1", version: "2017-09-30" }, null, 2),
      "/latest/user-data": "#!/bin/bash\napt-get update -y\napt-get install -y nginx nodejs\nsystemctl enable --now nginx webapp\n",
    };
    const key = path.endsWith("/") || data[path] !== undefined ? path : `${path}/`;
    const body = data[key] ?? data[path];
    if (body === undefined) return { ...plain(404, '<?xml version="1.0" encoding="iso-8859-1"?>\n<html><head><title>404 - Not Found</title></head><body><h1>404 - Not Found</h1></body></html>\n') };
    return plain(200, body);
  }

  function external(host: string, path: string): HttpResponse {
    if (["checkip.amazonaws.com", "ifconfig.me"].includes(host)) return response(200, "203.0.113.10\n", "text/plain", "awselb/2.0");
    if (host === "google.com") return response(301, '<HTML><HEAD><meta http-equiv="content-type" content="text/html;charset=utf-8">\n<TITLE>301 Moved</TITLE></HEAD><BODY>\n<H1>301 Moved</H1>\nThe document has moved\n<A HREF="https://www.google.com/">here</A>.\n</BODY></HTML>\n', "text/html; charset=UTF-8", "gws", [["Location", "https://www.google.com/"]]);
    if (host === "api.github.com") return response(200, JSON.stringify({ current_user_url: "https://api.github.com/user", repository_url: "https://api.github.com/repos/{owner}/{repo}", rate_limit_url: "https://api.github.com/rate_limit" }, null, 2) + "\n", "application/json; charset=utf-8", "github.com");
    if (host.endsWith("example.com"))
      return path === "/" || path === "/index.html"
        ? response(200, "<!doctype html>\n<html>\n<head><title>Example Domain</title></head>\n<body>\n<h1>Example Domain</h1>\n<p>This domain is for use in illustrative examples in documents.</p>\n</body>\n</html>\n", "text/html; charset=UTF-8", "ECS (nyd/D11B)")
        : response(404, "<!doctype html>\n<html><body><h1>404 Not Found</h1></body></html>\n", "text/html", "ECS (nyd/D11B)");
    return response(200, `<!doctype html>\n<html><body><h1>${host}</h1></body></html>\n`, "text/html", "simulated");
  }

  async function http(method: string, rawUrl: string, headers: Record<string, string>, body = ""): Promise<HttpResult & { url?: URL }> {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
    } catch {
      return { ok: false, code: 3, message: "URL rejected: Malformed input to a URL function" };
    }
    if (!/^https?:$/.test(url.protocol)) return { ok: false, code: 1, message: `Protocol "${url.protocol.slice(0, -1)}" not supported` };
    const https = url.protocol === "https:";
    const port = Number(url.port || (https ? 443 : 80));
    if (url.hostname === "169.254.169.254") return { ok: true, res: imds(method, url.pathname, headers), ip: "169.254.169.254", port, url };
    const r = await resolveHost(m, url.hostname);
    if (!r) return { ok: false, code: 6, message: `Could not resolve host: ${url.hostname}` };
    if (r.self) {
      const listener = state().procs.find((p) => p.ports?.includes(port));
      if (!listener) return { ok: false, code: 7, message: `Failed to connect to ${url.hostname} port ${port} after 0 ms: Couldn't connect to server` };
      if (https) return { ok: false, code: 35, message: "OpenSSL/3.0.13: error:0A00010B:SSL routines::wrong version number" };
      if (listener.ports?.includes(22) && port === 22) return { ok: false, code: 1, message: "Received HTTP/0.9 when not allowed" };
      const res = await localHttp(listener, method, url, body);
      if (typeof res === "number") return { ok: false, code: res, message: "Empty reply from server" };
      return { ok: true, res, ip: r.ip, port, url };
    }
    if (!r.info.up || !(r.info.ports ?? [80, 443]).includes(port))
      return { ok: false, code: 28, message: `Failed to connect to ${url.hostname} port ${port} after 5001 ms: Timeout was reached` };
    return { ok: true, res: external(r.name, url.pathname), ip: r.ip, port, url };
  }

  const headerBlock = (res: HttpResponse) => `HTTP/1.1 ${res.status} ${res.reason}\r\n${res.headers.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;

  const curl = command("curl", async (args, ctx) => {
    const p = parseArgs(args, "oXHdwmAuebT", ["output", "request", "header", "data", "data-raw", "data-binary", "write-out", "max-time", "connect-timeout", "user-agent", "user", "referer", "retry"]);
    const f = p.flags;
    const silent = f.has("s") || f.has("silent");
    const showErr = f.has("S") || f.has("show-error");
    const target = p.rest[0];
    if (!target) return fail("curl: try 'curl --help' or 'curl --manual' for more information", 2);
    const data = p.values.d ?? p.values.data ?? p.values["data-raw"] ?? p.values["data-binary"];
    const head = f.has("I") || f.has("head");
    let method = p.values.X ?? p.values.request ?? (head ? "HEAD" : data !== undefined ? "POST" : "GET");
    const headers: Record<string, string> = {};
    for (const h of [...(p.multi.H ?? []), ...(p.multi.header ?? [])]) {
      const i = h.indexOf(":");
      if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
    }
    let result = await http(method, target, headers, data ?? "");
    let redirects = 0;
    while (result.ok && (f.has("L") || f.has("location")) && [301, 302, 307, 308].includes(result.res.status) && redirects < 5) {
      const loc = result.res.headers.find(([k]) => k === "Location")?.[1];
      if (!loc) break;
      if (result.res.status < 307) method = head ? "HEAD" : "GET";
      result = await http(method, new URL(loc, result.url).toString(), headers);
      redirects++;
    }
    if (!result.ok) return ok("", silent && !showErr ? "" : `curl: (${result.code}) ${result.message}\n`, result.code);
    const res = result.res;
    let stderr = "";
    if (f.has("v") || f.has("verbose")) {
      const u = result.url!;
      stderr += `*   Trying ${result.ip}:${result.port}...\n* Connected to ${u.hostname} (${result.ip}) port ${result.port}\n> ${method} ${u.pathname}${u.search} HTTP/1.1\n> Host: ${u.host}\n> User-Agent: curl/8.5.0\n> Accept: */*\n${Object.entries(headers).map(([k, v]) => `> ${k}: ${v}\n`).join("")}>\n< HTTP/1.1 ${res.status} ${res.reason}\n${res.headers.filter(([, v]) => v).map(([k, v]) => `< ${k}: ${v}\n`).join("")}<\n`;
    }
    if ((f.has("f") || f.has("fail")) && res.status >= 400) return ok("", silent && !showErr ? stderr : `${stderr}curl: (22) The requested URL returned error: ${res.status}\n`, 22);
    let stdout = head ? headerBlock(res) : (f.has("i") || f.has("include") ? headerBlock(res) : "") + (method === "HEAD" ? "" : res.body);
    const outFile = p.values.o ?? p.values.output ?? (f.has("O") || f.has("remote-name") ? result.url!.pathname.split("/").pop() || "" : undefined);
    if (outFile !== undefined) {
      if (!outFile) return fail("curl: (23) Remote file name has no length", 23);
      try {
        await fs.writeFile(normalizePath(ctx.cwd, outFile), stdout);
      } catch (e) {
        return fail(`curl: (23) Failure writing output to destination${(e as { code?: string }).code === "EACCES" ? " (Permission denied)" : ""}`, 23);
      }
      if (!silent) {
        const n = Buffer.byteLength(stdout);
        stderr += `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n100 ${String(n).padStart(5)}  100 ${String(n).padStart(5)}    0     0   ${String(n * 40).padStart(5)}      0 --:--:-- --:--:-- --:--:-- ${String(n * 40).padStart(5)}\n`;
      }
      stdout = "";
    }
    const wo = p.values.w ?? p.values["write-out"];
    if (wo)
      stdout += wo
        .replace(/%\{http_code\}|%\{response_code\}/g, String(res.status))
        .replace(/%\{size_download\}/g, String(Buffer.byteLength(res.body)))
        .replace(/%\{time_total\}/g, (result.ip.startsWith("127") || result.ip.startsWith("10.") ? 0.0012 : 0.0421).toFixed(6))
        .replace(/%\{url_effective\}/g, result.url!.toString())
        .replace(/%\{content_type\}/g, res.headers.find(([k]) => k === "Content-Type")?.[1] ?? "")
        .replace(/\\n/g, "\n");
    return ok(stdout, stderr);
  });

  const wget = command("wget", async (args, ctx) => {
    const p = parseArgs(args, "OPT", ["output-document", "directory-prefix", "timeout", "tries"]);
    const quiet = p.flags.has("q") || p.flags.has("quiet");
    const target = p.rest[0];
    if (!target) return fail("wget: missing URL\nUsage: wget [OPTION]... [URL]...", 1);
    const result = await http("GET", target, {});
    const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
    let log = `--${stamp()}--  ${/^[a-z]+:\/\//i.test(target) ? target : `http://${target}/`}\n`;
    if (!result.ok) {
      const host = target.replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0];
      log += result.code === 6 ? `Resolving ${host} (${host})... failed: Name or service not known.\nwget: unable to resolve host address ‘${host}’\n` : `Connecting to ${host}... failed: ${result.code === 7 ? "Connection refused" : "Connection timed out"}.\n`;
      return ok("", quiet ? "" : log, 4);
    }
    const res = result.res;
    const u = result.url!;
    log += `Resolving ${u.hostname} (${u.hostname})... ${result.ip}\nConnecting to ${u.hostname} (${u.hostname})|${result.ip}|:${result.port}... connected.\nHTTP request sent, awaiting response... ${res.status} ${res.reason}\n`;
    if (res.status >= 400) return ok("", quiet ? "" : `${log}${stamp()} ERROR ${res.status}: ${res.reason}.\n\n`, 8);
    if (p.flags.has("spider")) return ok("", quiet ? "" : `${log}Remote file exists.\n\n`);
    const name = p.values.O ?? p.values["output-document"] ?? (u.pathname.split("/").pop() || "index.html");
    const n = Buffer.byteLength(res.body);
    if (name === "-") return ok(res.body, quiet ? "" : log);
    const dir = p.values.P ?? p.values["directory-prefix"] ?? ".";
    const path = normalizePath(ctx.cwd, name.startsWith("/") ? name : `${dir}/${name}`);
    try {
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!(await fs.inner.exists(parent))) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(path, res.body);
    } catch {
      return fail(`${log}${name}: Permission denied`, 3);
    }
    log += `Length: ${n} [${(res.headers.find(([k]) => k === "Content-Type")?.[1] ?? "text/plain").split(";")[0]}]\nSaving to: ‘${name}’\n\n${name.padEnd(20).slice(0, 20)}100%[===================>] ${String(n).padStart(7)}  --.-KB/s    in 0s\n\n${stamp()} (${(n / 10).toFixed(1)} KB/s) - ‘${name}’ saved [${n}/${n}]\n\n`;
    return ok("", quiet ? "" : log);
  });

  // ---- addresses, routes, sockets --------------------------------------------------------

  const ip = command("ip", async (args) => {
    const brief = args.includes("-br") || args.includes("-brief");
    const rest = args.filter((a) => !a.startsWith("-"));
    const obj = rest[0] ?? "help";
    const dev = rest.includes("dev") ? rest[rest.indexOf("dev") + 1] : rest[2] && ["show", "list"].includes(rest[1]) ? rest[2] : undefined;
    const lo = "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n";
    const ens = "2: ens5: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc mq state UP group default qlen 1000\n    link/ether 0a:1b:2c:3d:4e:5f brd ff:ff:ff:ff:ff:ff\n    altname enp0s5\n";
    if (/^a(d(d(r(e(s(s)?)?)?)?)?)?$/.test(obj)) {
      if (brief) return ok(`lo               UNKNOWN        127.0.0.1/8 ::1/128\nens5             UP             10.0.1.23/24 metric 100 fe80::81b:2cff:fe3d:4e5f/64\n`);
      const loA = `${lo}    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n    inet6 ::1/128 scope host noprefixroute\n       valid_lft forever preferred_lft forever\n`;
      const ensA = `${ens}    inet 10.0.1.23/24 metric 100 brd 10.0.1.255 scope global dynamic ens5\n       valid_lft 2954sec preferred_lft 2954sec\n    inet6 fe80::81b:2cff:fe3d:4e5f/64 scope link\n       valid_lft forever preferred_lft forever\n`;
      if (dev === "lo") return ok(loA);
      if (dev === "ens5") return ok(ensA);
      if (dev) return fail(`Device "${dev}" does not exist.`);
      return ok(loA + ensA);
    }
    if (/^r(o(u(t(e)?)?)?)?$/.test(obj))
      return ok("default via 10.0.1.1 dev ens5 proto dhcp src 10.0.1.23 metric 100\n10.0.0.2 via 10.0.1.1 dev ens5 proto dhcp src 10.0.1.23 metric 100\n10.0.1.0/24 dev ens5 proto kernel scope link src 10.0.1.23 metric 100\n10.0.1.1 dev ens5 proto dhcp scope link src 10.0.1.23 metric 100\n");
    if (/^l(i(n(k)?)?)?$/.test(obj)) return ok(brief ? "lo               UNKNOWN        00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>\nens5             UP             0a:1b:2c:3d:4e:5f <BROADCAST,MULTICAST,UP,LOWER_UP>\n" : lo + ens);
    if (/^n(e(i(g(h)?)?)?)?$/.test(obj)) return ok("10.0.1.1 dev ens5 lladdr 0a:ff:ee:dd:cc:01 REACHABLE\n");
    return fail("Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | route | link | neigh }");
  });

  interface Sock {
    proto: "tcp" | "udp";
    state: string;
    local: string;
    port: number;
    peer: string;
    procs: Proc[];
    backlog: number;
  }

  function sockets(): Sock[] {
    const s = state();
    const out: Sock[] = [];
    const byPort = new Map<number, Proc[]>();
    for (const p of s.procs) for (const port of p.ports ?? []) byPort.set(port, [...(byPort.get(port) ?? []), p]);
    for (const [port, procs] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
      const owners = procs[0].unit === "nginx" ? s.procs.filter((p) => p.unit === "nginx") : procs;
      if (port === 53) {
        out.push({ proto: "udp", state: "UNCONN", local: "127.0.0.53%lo", port, peer: "0.0.0.0:*", procs: owners, backlog: 0 });
        out.push({ proto: "tcp", state: "LISTEN", local: "127.0.0.53%lo", port, peer: "0.0.0.0:*", procs: owners, backlog: 4096 });
        continue;
      }
      const local = procs[0].unit === "webapp" ? "*" : "0.0.0.0";
      out.push({ proto: "tcp", state: "LISTEN", local, port, peer: local === "*" ? "*:*" : "0.0.0.0:*", procs: owners, backlog: procs[0].unit === "nginx" ? 511 : procs[0].unit === "ssh" ? 4096 : 128 });
      if (procs[0].unit === "nginx" || procs[0].unit === "ssh") out.push({ proto: "tcp", state: "LISTEN", local: "[::]", port, peer: "[::]:*", procs: owners, backlog: procs[0].unit === "nginx" ? 511 : 4096 });
    }
    const sshd = s.procs.find((p) => p.pid === 1902);
    if (sshd) out.push({ proto: "tcp", state: "ESTAB", local: "10.0.1.23", port: 22, peer: "203.0.113.50:52314", procs: [sshd], backlog: 0 });
    const app = s.procs.find((p) => p.unit === "webapp" && p.ppid === 1);
    if (app) out.push({ proto: "tcp", state: "ESTAB", local: "10.0.1.23", port: 44512, peer: "10.0.2.15:5432", procs: [app], backlog: 0 });
    return out;
  }

  const ss = command("ss", async (args) => {
    const p = parseArgs(args);
    const f = p.flags;
    if (f.has("s") || f.has("summary"))
      return ok("Total: 152\nTCP:   8 (estab 2, closed 1, orphaned 0, timewait 1)\n\nTransport Total     IP        IPv6\nRAW\t  0         0         0\nUDP\t  2         2         0\nTCP\t  7         5         2\nINET\t  9         7         2\nFRAG\t  0         0         0\n");
    const tcp = f.has("t") || f.has("tcp");
    const udp = f.has("u") || f.has("udp");
    const listening = f.has("l") || f.has("listening");
    const all = f.has("a") || f.has("all");
    const numeric = f.has("n") || f.has("numeric");
    const showProc = f.has("p") || f.has("processes");
    const filter = /([sd])port\s*=\s*:?(\d+)/.exec(p.rest.join(" "));
    let list = sockets().filter((s) => (!tcp && !udp) || (tcp && s.proto === "tcp") || (udp && s.proto === "udp"));
    list = list.filter((s) => (all ? true : listening ? s.state === "LISTEN" || s.state === "UNCONN" : s.state === "ESTAB"));
    if (filter) list = list.filter((s) => (filter[1] === "s" ? s.port : Number(s.peer.split(":").pop())) === Number(filter[2]));
    const name = (port: number) => (numeric ? String(port) : (SERVICES[port] ?? String(port)));
    const users = (s: Sock) => {
      const visible = s.procs.filter((p) => m.isRoot() || p.user === m.user.user);
      return showProc && visible.length ? `users:(${[...visible].reverse().map((p) => `("${comm(p)}",pid=${p.pid},fd=${p.unit === "nginx" ? 6 : 3})`).join(",")})` : "";
    };
    const rows = [[...(tcp !== udp ? [] : ["Netid"]), "State", "Recv-Q", "Send-Q", "Local Address:Port", "Peer Address:Port", "Process"]];
    for (const s of list) rows.push([...(tcp !== udp ? [] : [s.proto]), s.state, "0", String(s.backlog), `${s.local}:${name(s.port)}`, s.peer, users(s)]);
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return ok(rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 1))).join(" ").trimEnd()).join("\n") + "\n");
  });

  const netstat = command("netstat", async (args) => {
    const f = parseArgs(args).flags;
    if (f.has("r")) return ok("Kernel IP routing table\nDestination     Gateway         Genmask         Flags   MSS Window  irtt Iface\n0.0.0.0         10.0.1.1        0.0.0.0         UG        0 0          0 ens5\n10.0.0.2        10.0.1.1        255.255.255.255 UGH       0 0          0 ens5\n10.0.1.0        0.0.0.0         255.255.255.0   U         0 0          0 ens5\n10.0.1.1        0.0.0.0         255.255.255.255 UH        0 0          0 ens5\n");
    if (f.has("i")) return ok("Kernel Interface table\nIface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg\nens5      9001  4182231      0      0 0       3921874      0      0      0 BMRU\nlo       65536    81233      0      0 0         81233      0      0      0 LRU\n");
    const listening = f.has("l");
    const all = f.has("a");
    const numeric = f.has("n");
    const showProc = f.has("p");
    const want = (proto: string) => (!f.has("t") && !f.has("u")) || (f.has("t") && proto === "tcp") || (f.has("u") && proto === "udp");
    const list = sockets().filter((s) => want(s.proto) && (all || (listening ? s.state !== "ESTAB" : s.state === "ESTAB")));
    let out = "";
    if (showProc && !m.isRoot()) out += "(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)\n";
    out += `Active Internet connections (${listening && !all ? "only servers" : all ? "servers and established" : "w/o servers"})\nProto Recv-Q Send-Q Local Address           Foreign Address         State       ${showProc ? "PID/Program name    " : ""}\n`;
    for (const s of list) {
      const addr = s.local === "[::]" ? "::" : s.local.replace("%lo", "").replace("*", "0.0.0.0");
      const local = `${addr}:${numeric ? s.port : (SERVICES[s.port] ?? s.port)}`;
      const owner = s.procs[0];
      const proc = showProc ? (m.isRoot() || owner.user === m.user.user ? `${owner.pid}/${owner.cmd}`.slice(0, 19) : "-") : "";
      const proto = s.local === "[::]" ? `${s.proto}6` : s.proto;
      out += `${proto.padEnd(6)}${"0".padStart(6)} ${"0".padStart(6)} ${local.padEnd(24)}${s.peer.replace("*:*", "0.0.0.0:*").replace("[::]:*", ":::*").padEnd(24)}${(s.state === "ESTAB" ? "ESTABLISHED" : s.state === "UNCONN" ? "" : s.state).padEnd(12)}${proc}\n`;
    }
    return ok(out);
  });

  // ---- reachability ----------------------------------------------------------------------

  const ping = command("ping", async (args) => {
    const p = parseArgs(args, "ciWwsI");
    const host = p.rest[0];
    if (!host) return fail("ping: usage error: Destination address required", 1);
    const r = await resolveHost(m, host);
    if (!r) return fail(`ping: ${host}: Name or service not known`, 2);
    const count = Math.min(Number(p.values.c ?? 4), 20);
    const rand = rng(host.length * 7919);
    let out = `PING ${host} (${r.ip}) 56(84) bytes of data.\n`;
    const times: number[] = [];
    if (r.info.up)
      for (let i = 1; i <= count; i++) {
        const t = Number(fmtMs(r.info.ms, rand));
        times.push(t);
        if (!p.flags.has("q")) out += `64 bytes from ${r.self ? r.ip : r.ip}: icmp_seq=${i} ttl=${r.self ? 64 : r.ip.startsWith("10.") ? 64 : 52} time=${t} ms\n`;
      }
    const loss = r.info.up ? 0 : 100;
    out += `\n--- ${host} ping statistics ---\n${count} packets transmitted, ${times.length} received, ${loss}% packet loss, time ${(count - 1) * 1001 + 2}ms\n`;
    if (times.length) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      out += `rtt min/avg/max/mdev = ${Math.min(...times).toFixed(3)}/${avg.toFixed(3)}/${Math.max(...times).toFixed(3)}/${(Math.max(...times) - avg).toFixed(3)} ms\n`;
    }
    return ok(out, p.values.c ? "" : "(ping runs until Ctrl+C in a real terminal; this lab stops after 4 packets. Use -c to choose.)\n", r.info.up ? 0 : 1);
  });

  const traceroute = command("traceroute", async (args) => {
    const host = parseArgs(args, "mqw").rest[0];
    if (!host) return fail("Usage:\n  traceroute [ -46dFITnreAUDV ] [ -f first_ttl ] host [ packetlen ]", 2);
    const r = await resolveHost(m, host);
    if (!r) return fail(`${host}: Name or service not known\nCannot handle "host" cmdline arg \`${host}' on position 1 (argc 1)`, 2);
    const rand = rng(host.length * 31);
    const t = (ms: number) => `${fmtMs(ms, rand)} ms`;
    let out = `traceroute to ${host} (${r.ip}), 30 hops max, 60 byte packets\n`;
    if (r.self) return ok(`${out} 1  localhost (127.0.0.1)  0.031 ms  0.008 ms  0.007 ms\n`);
    if (r.ip.startsWith("10.")) {
      out += r.info.up ? ` 1  ${host} (${r.ip})  ${t(r.info.ms)}  ${t(r.info.ms)}  ${t(r.info.ms)}\n` : ` 1  * * *\n 2  * * *\n 3  * * *\n 4  * * *\n`;
      return ok(out, r.info.up ? "" : "(traceroute keeps probing up to 30 hops; this lab stops here)\n");
    }
    out += ` 1  244.5.0.111 (244.5.0.111)  ${t(0.9)}  244.5.0.103 (244.5.0.103)  ${t(1)}  ${t(1.1)}\n 2  * * *\n 3  100.66.8.218 (100.66.8.218)  ${t(1.4)}  ${t(1.5)}  ${t(1.3)}\n 4  52.93.28.141 (52.93.28.141)  ${t(1.6)}  ${t(1.7)}  ${t(1.6)}\n`;
    if (!r.info.up) return ok(`${out} 5  * * *\n 6  * * *\n 7  * * *\n`, "(traceroute keeps probing up to 30 hops; this lab stops here)\n");
    return ok(`${out} 5  ae-1.r21.ashbva04.us.bb.gin.ntt.net (129.250.2.172)  ${t(2.1)}  ${t(2.2)}  ${t(2)}\n 6  ${r.ip} (${r.ip})  ${t(r.info.ms)}  ${t(r.info.ms)}  ${t(r.info.ms)}\n`);
  });

  async function dnsAnswer(name: string, type: string) {
    const r = await resolveHost(m, name, false);
    if (!r || r.self) return name.toLowerCase() === "localhost" ? { status: "NOERROR", answers: [["localhost.", "0", "A", "127.0.0.1"]] } : r?.self ? { status: "NOERROR", answers: [[`${HOSTNAME}.ec2.internal.`, "60", "A", "10.0.1.23"]] } : { status: "NXDOMAIN", answers: [] };
    const fq = `${r.name}.`;
    if (type === "MX") return { status: "NOERROR", answers: r.name.endsWith("example.com") ? [[fq, "300", "MX", "0 ."]] : [] };
    if (type === "NS") return { status: "NOERROR", answers: r.name.endsWith(".internal") ? [] : [[fq, "86400", "NS", "a.iana-servers.net."], [fq, "86400", "NS", "b.iana-servers.net."]] };
    const answers: string[][] = [];
    if (r.info.cname) answers.push([fq, "300", "CNAME", `${r.info.cname}.`]);
    if (type === "A" || type === "ANY") answers.push([r.info.cname ? `${r.info.cname}.` : fq, r.name.endsWith(".internal") ? "60" : "300", "A", r.ip]);
    return { status: "NOERROR", answers };
  }

  const dig = command("dig", async (args) => {
    const short = args.includes("+short");
    const server = args.find((a) => a.startsWith("@"))?.slice(1) ?? "127.0.0.53";
    const plain = args.filter((a) => !a.startsWith("+") && !a.startsWith("@") && !a.startsWith("-"));
    const type = (plain.find((a) => /^(A|AAAA|MX|NS|CNAME|TXT|ANY)$/i.test(a)) ?? "A").toUpperCase();
    const name = plain.find((a) => !/^(A|AAAA|MX|NS|CNAME|TXT|ANY)$/i.test(a)) ?? ".";
    const { status, answers } = await dnsAnswer(name, type);
    if (short) return ok(answers.map((a) => `${a[3]}\n`).join(""));
    const now = new Date();
    return ok(
      `\n; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${args.join(" ")}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: ${4000 + name.length * 97}\n;; flags: qr rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; OPT PSEUDOSECTION:\n; EDNS: version: 0, flags:; udp: 65494\n;; QUESTION SECTION:\n;${name.replace(/\.?$/, ".")}\t\t\tIN\t${type}\n` +
        (answers.length ? `\n;; ANSWER SECTION:\n${answers.map((a) => `${a[0]}\t\t${a[1]}\tIN\t${a[2]}\t${a[3]}`).join("\n")}\n` : "") +
        `\n;; Query time: ${name.endsWith(".internal") ? 0 : 3} msec\n;; SERVER: ${server}#53(${server}) (UDP)\n;; WHEN: ${now.toUTCString().replace("GMT", "UTC")}\n;; MSG SIZE  rcvd: ${40 + answers.length * 16}\n\n`,
    );
  });

  const nslookup = command("nslookup", async (args) => {
    const name = args.find((a) => !a.startsWith("-"));
    if (!name) return fail("nslookup: interactive mode is not available in this lab. Usage: nslookup NAME", 1);
    const server = args[args.indexOf(name) + 1] ?? "127.0.0.53";
    const { status, answers } = await dnsAnswer(name, "A");
    let out = `Server:\t\t${server}\nAddress:\t${server}#53\n\n`;
    if (status === "NXDOMAIN") return ok(`${out}** server can't find ${name}: NXDOMAIN\n\n`, "", 1);
    if (!name.endsWith(".internal")) out += "Non-authoritative answer:\n";
    for (const a of answers) out += a[2] === "CNAME" ? `${a[0].slice(0, -1)}\tcanonical name = ${a[3]}\n` : `Name:\t${a[0].slice(0, -1)}\nAddress: ${a[3]}\n`;
    return ok(`${out}\n`);
  });

  const host = command("host", async (args) => {
    const name = args.find((a) => !a.startsWith("-"));
    if (!name) return fail("Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]\n            [-R number] [-m flag] [-p port] hostname [server]");
    const { status, answers } = await dnsAnswer(name, "A");
    if (status === "NXDOMAIN") return fail(`Host ${name} not found: 3(NXDOMAIN)`, 1);
    return ok(answers.map((a) => (a[2] === "CNAME" ? `${a[0].slice(0, -1)} is an alias for ${a[3].slice(0, -1)}.\n` : `${a[0].slice(0, -1)} has address ${a[3]}\n`)).join(""));
  });

  const getent = command("getent", async (args) => {
    const [db, key] = args;
    if (db === "passwd") {
      const lines = (await readPasswd(fs)).filter((p) => !key || p.name === key || String(p.uid) === key).map((p) => `${p.name}:x:${p.uid}:${p.gid}:${p.gecos}:${p.home}:${p.shell}`);
      return lines.length ? ok(`${lines.join("\n")}\n`) : ok("", "", 2);
    }
    if (db === "group") {
      const lines = (await readGroups(fs)).filter((g) => !key || g.name === key || String(g.gid) === key).map((g) => `${g.name}:x:${g.gid}:${g.members.join(",")}`);
      return lines.length ? ok(`${lines.join("\n")}\n`) : ok("", "", 2);
    }
    if (db === "hosts" || db === "ahosts") {
      if (!key) return ok("127.0.0.1       localhost\n");
      const r = await resolveHost(m, key);
      return r ? ok(`${r.ip.padEnd(16)}${key}\n`) : ok("", "", 2);
    }
    return fail(`Unknown database: ${db ?? ""}\nTry \`getent --help' or \`getent --usage' for more information.`);
  });

  const nc = command("nc", async (args) => {
    const p = parseArgs(args, "wpis");
    const [host, portText] = p.rest;
    const port = Number(portText);
    if (p.flags.has("l")) return ok("", "nc: listening keeps the terminal busy; start it in the background with & (e.g. nc -l 9000 &)\n", 1);
    if (!host || !port) return fail("usage: nc [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-M ttl]\n\t  [-m minttl] [-O length] [-P proxy_username] [-p source_port]\n\t  [-q seconds] [-s sourceaddr] [-T keyword] [-V rtable] [-W recvlimit]\n\t  [-w timeout] [-X proxy_protocol] [-x proxy_address[:port]]\n\t  [destination] [port]");
    const r = await resolveHost(m, host);
    if (!r) return fail(`nc: getaddrinfo for host "${host}" port ${port}: Name or service not known`);
    const open = r.self ? state().procs.some((x) => x.ports?.includes(port)) : r.info.up && (r.info.ports ?? []).includes(port);
    const svc = SERVICES[port] ? `tcp/${SERVICES[port]}` : "tcp/*";
    if (open) return ok("", p.flags.has("v") || p.flags.has("z") ? `Connection to ${host} (${r.ip}) ${port} port [${svc}] succeeded!\n` : "");
    return fail(`nc: connect to ${host} (${r.ip}) port ${port} (tcp) failed: ${r.self || r.info.up ? "Connection refused" : "Connection timed out"}`);
  });

  // ---- ssh family ------------------------------------------------------------------------

  async function keyProblem(ctx: Ctx, keyArg: string | undefined): Promise<string | undefined> {
    const home = await m.homeOf(m.user.user);
    const candidates = keyArg ? [normalizePath(ctx.cwd, keyArg)] : ["id_ed25519", "id_rsa", "id_ecdsa"].map((k) => `${home}/.ssh/${k}`);
    let warn = "";
    for (const key of candidates) {
      if (!(await fs.inner.exists(key))) {
        if (keyArg) warn += `Warning: Identity file ${keyArg} not accessible: No such file or directory.\n`;
        continue;
      }
      const mode = (await fs.inner.stat(key)).mode & 0o777;
      if (mode & 0o077)
        return `${warn}@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nPermissions 0${mode.toString(8)} for '${keyArg ?? key}' are too open.\nIt is required that your private key files are NOT accessible by others.\nThis private key will be ignored.\nLoad key "${keyArg ?? key}": bad permissions\n`;
      const text = await fs.readFile(key).catch(() => "");
      if (!text.includes("PRIVATE KEY")) return `${warn}Load key "${keyArg ?? key}": invalid format\n`;
      return undefined;
    }
    return `${warn}NO_KEY`;
  }

  async function connect(ctx: Ctx, target: string, keyArg: string | undefined): Promise<{ err?: string; host?: string; user?: string; code?: number }> {
    const [userPart, hostPart] = target.includes("@") ? target.split("@") : [m.user.user, target];
    const r = await resolveHost(m, hostPart);
    if (!r) return { err: `ssh: Could not resolve hostname ${hostPart}: Name or service not known\n`, code: 255 };
    if (hostPart === "github.com") return { host: "github.com", user: userPart };
    const info = SSH_HOSTS[r.ip];
    if (!r.self && (!r.info.up || !info)) return { err: `ssh: connect to host ${hostPart} port 22: Connection timed out\n`, code: 255 };
    const problem = await keyProblem(ctx, keyArg);
    if (problem) return { err: `${problem.replace("NO_KEY", "")}${userPart}@${hostPart}: Permission denied (publickey).\n`, code: 255 };
    if (!info.users.includes(userPart)) return { err: `${userPart}@${hostPart}: Permission denied (publickey).\n`, code: 255 };
    const home = await m.homeOf(m.user.user);
    const known = `${home}/.ssh/known_hosts`;
    const knownText = await fs.inner.readFile(known).catch(() => "");
    let note = "";
    if (!knownText.split("\n").some((l) => l.split(" ")[0] === hostPart)) {
      try {
        if (!(await fs.inner.exists(`${home}/.ssh`))) await fs.mkdir(`${home}/.ssh`);
        await fs.appendFile(known, `${hostPart} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${createHash("sha256").update(hostPart).digest("base64").slice(0, 43)}\n`);
      } catch {
        /* unwritable known_hosts: ssh still connects */
      }
      note = `Warning: Permanently added '${hostPart}' (ED25519) to the list of known hosts.\n`;
    }
    return { host: info.name, user: userPart, err: note || undefined, code: 0 };
  }

  // ponytail: other servers only remember up to 200 uploaded files of 4 KB each; a real remote fs if lessons ever need one
  function upload(hostName: string, path: string, content: string, dry = false) {
    if (dry) return;
    const files = ((m.state.remote ??= {})[hostName] ??= {});
    if (path in files || Object.keys(files).length < 200) files[path] = content.slice(0, 4096);
  }

  function remote(hostName: string, user: string, cmd: string) {
    const [tool, ...paths] = cmd.trim().split(/\s+/).filter((w) => !w.startsWith("-"));
    if ((tool === "ls" || tool === "cat") && paths.length && hostName !== HOSTNAME) {
      const files = m.state.remote?.[hostName] ?? {};
      return paths
        .map((raw) => {
          const path = normalizePath(`/home/${user}`, raw.replace(/^~(?=\/|$)/, `/home/${user}`));
          if (tool === "cat") return files[path] ?? `cat: ${raw}: No such file or directory\n`;
          if (path in files) return `${raw}\n`;
          const inside = Object.keys(files).filter((f) => f.startsWith(`${path === "/" ? "" : path}/`));
          if (!inside.length) return `ls: cannot access '${raw}': No such file or directory\n`;
          return `${[...new Set(inside.map((f) => f.slice(path === "/" ? 1 : path.length + 1).split("/")[0]))].sort().join("\n")}\n`;
        })
        .join("");
    }
    if (/^hostname$/.test(cmd)) return `${hostName === HOSTNAME ? HOSTNAME : `ip-${hostName === "db-1" ? "10-0-2-15" : "10-0-1-50"}`}\n`;
    if (/^whoami$/.test(cmd)) return `${user}\n`;
    if (/^uptime/.test(cmd)) return ` ${new Date().toISOString().slice(11, 19)} up 12 days,  3:04,  0 users,  load average: 0.15, 0.10, 0.09\n`;
    if (/^df\b/.test(cmd)) return "Filesystem      Size  Used Avail Use% Mounted on\n/dev/root       7.6G  3.1G  4.5G  41% /\n";
    if (/^free\b/.test(cmd)) return "               total        used        free      shared  buff/cache   available\nMem:           1.9Gi       702Mi       410Mi       1.0Mi       812Mi       1.1Gi\n";
    if (/^systemctl is-active/.test(cmd)) return "active\n";
    if (/^cat \/etc\/os-release/.test(cmd)) return 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\n';
    return `(simulated) '${cmd}' ran on ${hostName} as ${user}\n`;
  }

  const ssh = command("ssh", async (args, ctx) => {
    const p = parseArgs(args, "ipoLlFJW");
    const [target, ...cmdParts] = p.rest;
    if (!target) return fail("usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           [-i identity_file] [-J destination] [-L address] [-l login_name]\n           [-p port] [-W host:port] destination [command [argument ...]]", 255);
    const dest = p.values.l ? `${p.values.l}@${target}` : target;
    const c = await connect(ctx, dest, p.values.i);
    if (c.code) return ok("", c.err ?? "", c.code);
    if (c.host === "github.com") {
      const problem = await keyProblem(ctx, p.values.i);
      return problem ? ok("", `${problem.replace("NO_KEY", "")}git@github.com: Permission denied (publickey).\n`, 255) : ok("", `Hi ${m.user.user}! You've successfully authenticated, but GitHub does not provide shell access.\n`, 1);
    }
    if (p.values.L || p.flags.has("N")) return ok("", `${c.err ?? ""}(Port forwarding ${p.values.L ?? ""} would stay open until Ctrl+C; this lab only checks that the connection works.)\n`);
    const cmd = cmdParts.join(" ");
    if (cmd) return ok(remote(c.host!, c.user!, cmd), c.err ?? "");
    return ok(
      `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-1012-aws x86_64)\n\nLast login: ${new Date(Date.now() - 86400_000).toUTCString()} from 10.0.1.23\n${c.user}@${c.host}:~$ logout\nConnection to ${dest.split("@").pop()} closed.\n`,
      `${c.err ?? ""}(Interactive remote shells aren't available in this lab. Run one command instead, e.g.: ssh ${dest} 'uptime')\n`,
    );
  });

  const scp = command("scp", async (args, ctx) => {
    const p = parseArgs(args, "iPoF");
    if (p.rest.length < 2) return fail("usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config]\n           [-i identity_file] [-J destination] [-l limit] [-o ssh_option]\n           [-P port] [-S program] [-X sftp_option] source ... target", 1);
    const target = p.rest.at(-1)!;
    const sources = p.rest.slice(0, -1);
    const isRemote = (s: string) => /^([\w.-]+@)?[\w.-]+:/.test(s) && !s.startsWith("/") && !s.startsWith(".");
    const remoteSpec = [target, ...sources].find(isRemote);
    if (!remoteSpec) {
      const r = await ctx.exec!(`cp ${p.flags.has("r") ? "-r " : ""}${p.rest.map((x) => `'${x}'`).join(" ")}`, { cwd: ctx.cwd });
      return r;
    }
    const c = await connect(ctx, remoteSpec.split(":")[0], p.values.i);
    if (c.code) return ok("", (c.err ?? "").replace(/^ssh: /gm, "ssh: "), c.code === 255 ? 1 : c.code);
    let out = "";
    if (isRemote(target)) {
      const dry = p.flags.has("lab-dry");
      const rawDest = target.split(":").slice(1).join(":").replace(/^~(?=\/|$)/, `/home/${c.user}`);
      const dest = normalizePath(`/home/${c.user}`, rawDest || ".");
      for (const s of sources) {
        const path = normalizePath(ctx.cwd, s);
        if (!(await fs.inner.exists(path))) return fail(`scp: stat local "${s}": No such file or directory`);
        const st = await fs.inner.stat(path);
        if (st.isDirectory && !p.flags.has("r")) return fail(`scp: omitting directory "${s}"`);
        const size = st.isDirectory ? 4096 : st.size;
        const name = path.split("/").pop()!;
        out += `${name.padEnd(40)}100% ${String(size).padStart(6)}   ${(size / 1024 / 0.05).toFixed(1)}KB/s   00:00\n`;
        if (!st.isDirectory) {
          // "host:/dir/" and "host:/dir" (no extension) are directories; "host:/dir/new-name.txt" renames
          const intoDir = sources.length > 1 || !rawDest || rawDest.endsWith("/") || !/\.[^/]+$/.test(dest);
          upload(c.host!, intoDir ? normalizePath(dest, name) : dest, await fs.readFile(path).catch(() => ""), dry);
          continue;
        }
        // rsync's "src/" copies the contents; scp -r and rsync "src" copy the directory itself
        const base = p.flags.has("lab-rsync") && s.endsWith("/") ? dest : normalizePath(dest, name);
        const walk = async (dir: string): Promise<void> => {
          for (const child of await fs.inner.readdir(dir)) {
            const full = `${dir}/${child}`;
            if ((await fs.inner.stat(full)).isDirectory) await walk(full);
            else upload(c.host!, `${base}${full.slice(path.length)}`, await fs.readFile(full).catch(() => ""), dry);
          }
        };
        await walk(path);
      }
    } else {
      const remotePath = sources[0].split(":").slice(1).join(":");
      const name = remotePath.split("/").pop() || "file";
      let dest = normalizePath(ctx.cwd, target);
      if ((await fs.inner.exists(dest)) && (await fs.inner.stat(dest)).isDirectory) dest = normalizePath(dest, name);
      const uploaded = m.state.remote?.[c.host!]?.[normalizePath(`/home/${c.user}`, remotePath)];
      const body = uploaded ?? (/\.log$/.test(name) ? `${new Date().toISOString()} INFO copied from ${c.host}:${remotePath}\n` : `(file copied from ${c.host}:${remotePath})\n`);
      try {
        await fs.writeFile(dest, body);
      } catch {
        return fail(`scp: open local "${target}": Permission denied`);
      }
      out += `${name.padEnd(40)}100% ${String(body.length).padStart(6)}   ${(body.length / 1024 / 0.05).toFixed(1)}KB/s   00:00\n`;
    }
    return ok(p.flags.has("q") ? "" : out, c.err ?? "");
  });

  const sshKeygen = command("ssh-keygen", async (args, ctx) => {
    const p = parseArgs(args, "tbfNCF");
    const home = await m.homeOf(m.user.user);
    const type = (p.values.t ?? "ed25519").toLowerCase();
    if (!["ed25519", "rsa", "ecdsa"].includes(type)) return fail(`unknown key type ${type}`);
    const file = normalizePath(ctx.cwd, p.values.f ?? `${home}/.ssh/id_${type}`);
    const fingerprint = async (path: string) => {
      const pub = (await fs.readFile(path.endsWith(".pub") ? path : `${path}.pub`).catch(() => undefined)) ?? (await fs.readFile(path).catch(() => undefined));
      if (!pub) return undefined;
      const [, blob, comment] = pub.trim().split(/\s+/);
      return `${type === "rsa" ? 3072 : 256} SHA256:${createHash("sha256").update(blob ?? pub).digest("base64").replace(/=+$/, "")} ${comment ?? "no comment"} (${(pub.split(" ")[0] ?? "").replace("ssh-", "").toUpperCase()})`;
    };
    if (p.flags.has("l")) {
      const fp = await fingerprint(file);
      return fp ? ok(`${fp}\n`) : fail(`${p.values.f ?? file} is not a public key file.`);
    }
    if (p.flags.has("y")) {
      const text = await fs.readFile(file).catch(() => undefined);
      if (!text?.includes("PRIVATE KEY")) return fail(`Load key "${p.values.f ?? file}": invalid format`);
      const pub = await fs.readFile(`${file}.pub`).catch(() => `ssh-${type} AAAAC3NzaC1lZDI1NTE5AAAAI${createHash("sha256").update(text).digest("base64").slice(0, 43)}\n`);
      return ok(pub.endsWith("\n") ? pub : `${pub}\n`);
    }
    if (await fs.inner.exists(file)) return fail(`${file} already exists.\nOverwrite (y/n)? n\n(Remove the old key first, or pick another file with -f.)`);
    const comment = p.values.C ?? `${m.user.user}@${HOSTNAME}`;
    const prefix = type === "ed25519" ? "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" : type === "rsa" ? "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ" : "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAI";
    const pub = `${prefix}${randomBytes(type === "rsa" ? 96 : 32).toString("base64").replace(/=+$/, "")} ${comment}\n`;
    const priv = `-----BEGIN OPENSSH PRIVATE KEY-----\n${randomBytes(type === "rsa" ? 600 : 300).toString("base64").replace(/(.{70})/g, "$1\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
    try {
      const dir = file.slice(0, file.lastIndexOf("/"));
      if (!(await fs.inner.exists(dir))) {
        await fs.mkdir(dir, { recursive: true });
        await fs.chmod(dir, 0o700);
      }
      await fs.writeFile(file, priv);
      await fs.chmod(file, 0o600);
      await fs.writeFile(`${file}.pub`, pub);
      await fs.chmod(`${file}.pub`, 0o644);
    } catch {
      return fail(`Saving key "${file}" failed: Permission denied`);
    }
    const fp = await fingerprint(`${file}.pub`);
    const note = p.values.N === undefined ? "(No passphrase prompt in this lab; the key was created without one. Use -N 'passphrase' to set one.)\n" : "";
    return ok(
      `Generating public/private ${type} key pair.\nYour identification has been saved in ${file}\nYour public key has been saved in ${file}.pub\nThe key fingerprint is:\n${fp?.split(" ").slice(1, 3).join(" ")}\nThe key's randomart image is:\n+--[${type.toUpperCase()} ${type === "rsa" ? 3072 : 256}]--+\n|        .o+*B=.  |\n|       . ooBo=   |\n|        o.=.+ .  |\n|       ..+ o o   |\n|        S.o +    |\n|       . + o .   |\n|        o . .    |\n|       . . E     |\n|        .        |\n+----[SHA256]-----+\n`,
      note,
    );
  });

  const sshCopyId = command("ssh-copy-id", async (args, ctx) => {
    const p = parseArgs(args, "ip");
    const target = p.rest[0];
    if (!target) return fail("Usage: /usr/bin/ssh-copy-id [-h|-?|-f|-n|-s|-x] [-i [identity_file]] [-p port] [-F alternative ssh_config file] [-t target_path] [[-o <ssh -o options>] ...] [user@]hostname");
    const home = await m.homeOf(m.user.user);
    const pub = p.values.i ? normalizePath(ctx.cwd, p.values.i.endsWith(".pub") ? p.values.i : `${p.values.i}.pub`) : `${home}/.ssh/id_ed25519.pub`;
    if (!(await fs.inner.exists(pub))) return fail(`/usr/bin/ssh-copy-id: ERROR: failed to open ID file '${pub}': No such file`);
    const r = await resolveHost(m, target.split("@").pop()!);
    if (!r || (!r.self && !r.info.up)) return fail(`ssh: connect to host ${target.split("@").pop()} port 22: Connection timed out`);
    return ok(`\nNumber of key(s) added: 1\n\nNow try logging into the machine, with:   "ssh '${target}'"\nand check to make sure that only the key(s) you wanted were added.\n\n`, `/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${pub}"\n`);
  });

  return [curl, wget, ip, ss, netstat, ping, traceroute, dig, nslookup, host, getent, nc, ssh, scp, sshKeygen, sshCopyId];
}
