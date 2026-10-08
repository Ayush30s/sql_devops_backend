import { ZodError, type ZodType } from "zod";
import { HttpError } from "./auth.ts";
import { config } from "./config.ts";
import { DatasetError, SandboxUnavailableError } from "./sql/sandbox.ts";

/**
 * One wrapper for every route: it catches errors, turns them into a plain
 * `{ error }` JSON body with a sensible status, and never leaks a stack trace.
 */
export function route<T>(handler: () => Promise<T>) {
  return handler().then(
    (data) => Response.json(data ?? { ok: true }),
    (err: unknown) => {
      if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof ZodError)
        return Response.json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
      if (err instanceof SandboxUnavailableError) return Response.json({ error: "The practice database is not available. Try again in a moment." }, { status: 503 });
      if (err instanceof DatasetError) return Response.json({ error: "This exercise's dataset failed to load. Please report it." }, { status: 500 });
      console.error(err);
      return Response.json({ error: "Something went wrong on our side." }, { status: 500 });
    },
  );
}

/** Parses and validates a JSON body. Rejects anything that isn't JSON. */
export async function body<S extends ZodType>(req: Request, schema: S): Promise<ReturnType<S["parse"]>> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new HttpError(415, "Send JSON.");
  const raw = await req.text();
  if (raw.length > 200_000) throw new HttpError(413, "That request is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "That is not valid JSON.");
  }
  return schema.parse(parsed) as ReturnType<S["parse"]>;
}

/**
 * CSRF defence for cookie-authenticated mutations: the browser sends Origin on
 * every cross-site POST, so requiring our own origin is enough.
 */
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return; // same-origin non-CORS requests (and server-side calls) may omit it
  // The browser talks to the frontend, which proxies to us, so our own origin is never the one to trust.
  const allowed = new Set([config.appUrl, ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:3000", "http://127.0.0.1:3000"])]);
  if (!allowed.has(origin)) throw new HttpError(403, "Cross-site requests are not allowed.");
}

// ponytail: in-memory fixed-window rate limit; swap for Redis if this ever runs on more than one instance.
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    return;
  }
  entry.count++;
  if (entry.count > limit) throw new HttpError(429, `Too many requests. Try again in ${Math.ceil((entry.resetAt - now) / 1000)}s.`);
}

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
