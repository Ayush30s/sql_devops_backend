import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A very small HTTP layer: pattern routing, a cookie jar, and conversion between Node's
 * request/response and the Web `Request`/`Response` the handlers are written against.
 * No framework — the handlers are plain functions of a context.
 */

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  path?: string;
  expires?: Date;
  maxAge?: number;
}

/** Reads the request's cookies and collects the ones a handler wants to set. */
export class CookieJar {
  private readonly incoming = new Map<string, string>();
  readonly outgoing: string[] = [];

  constructor(header?: string | null) {
    for (const part of (header ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      this.incoming.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
    }
  }

  get(name: string) {
    return this.incoming.get(name);
  }

  set(name: string, value: string, options: CookieOptions = {}) {
    const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`];
    if (options.httpOnly ?? true) bits.push("HttpOnly");
    bits.push(`SameSite=${(options.sameSite ?? "lax").replace(/^./, (c) => c.toUpperCase())}`);
    if (options.secure) bits.push("Secure");
    if (options.expires) bits.push(`Expires=${options.expires.toUTCString()}`);
    if (options.maxAge !== undefined) bits.push(`Max-Age=${options.maxAge}`);
    this.outgoing.push(bits.join("; "));
  }

  delete(name: string) {
    this.set(name, "", { expires: new Date(0), maxAge: 0 });
  }
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string | string[]>;
  cookies: CookieJar;
}

/**
 * The current request, available anywhere in the call tree. Handlers stay plain functions and
 * `currentUser()` can read the session cookie without every helper taking a context parameter.
 */
export const requestContext = new AsyncLocalStorage<Ctx>();

export function context(): Ctx {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("No request in scope: this must be called while handling a request.");
  return ctx;
}

export type Handler = (req: Request, extra: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;

export interface Route {
  method: string;
  /** `/api/admin/users/:id`, or `/api/topics/*rest` for the rest of the path. */
  pattern: string;
  handler: Handler;
}

/** Matches a path against a pattern, returning its parameters or undefined. */
export function match(pattern: string, path: string): Record<string, string | string[]> | undefined {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  const params: Record<string, string | string[]> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i];
    if (part.startsWith("*")) {
      // A catch-all hands over the remaining segments, the shape the handlers were written for.
      params[part.slice(1)] = s.slice(i).map(decodeURIComponent);
      return params;
    }
    if (i >= s.length) return undefined;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(s[i]);
    else if (part !== s[i]) return undefined;
  }
  return p.length === s.length ? params : undefined;
}

export const find = (routes: Route[], method: string, path: string) => {
  let methodMismatch = false;
  for (const route of routes) {
    const params = match(route.pattern, path);
    if (!params) continue;
    if (route.method !== method) {
      methodMismatch = true;
      continue;
    }
    return { route, params };
  }
  return methodMismatch ? "wrong-method" : undefined;
};

const MAX_BODY = 1_000_000;

/** Node's IncomingMessage as a Web Request, so handlers stay framework-free. */
export async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new PayloadTooLarge();
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks).toString("utf8");
  }
  return new Request(new URL(req.url ?? "/", origin), { method: req.method, headers, body });
}

export class PayloadTooLarge extends Error {}

export async function send(res: ServerResponse, response: Response, setCookies: string[] = []) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (setCookies.length) headers["set-cookie"] = setCookies;
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}
