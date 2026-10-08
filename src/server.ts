import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./lib/config.ts";
import { CookieJar, find, PayloadTooLarge, requestContext, send, toRequest, type Ctx, type Handler, type Route } from "./http.ts";

/**
 * The API server: plain `node:http`, no framework. Routes come from the file tree under
 * `src/routes/api`, the same convention the code already used — `[id]` is one segment,
 * `[...rest]` is the rest of the path.
 */

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

async function loadRoutes(dir: string, prefix = ""): Promise<Route[]> {
  const routes: Route[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const segment = entry.name.startsWith("[...") ? `*${entry.name.slice(4, -1)}` : entry.name.startsWith("[") ? `:${entry.name.slice(1, -1)}` : entry.name;
      routes.push(...(await loadRoutes(full, `${prefix}/${segment}`)));
    } else if (entry.name === "route.ts") {
      const module = (await import(pathToFileURL(full).href)) as Record<string, Handler | undefined>;
      for (const method of METHODS) if (module[method]) routes.push({ method, pattern: prefix || "/", handler: module[method] });
    }
  }
  // Literal segments win over parameters, and a catch-all is the last resort.
  return routes.sort((a, b) => rank(a.pattern) - rank(b.pattern));
}

const rank = (pattern: string) => (pattern.includes("*") ? 2 : pattern.includes(":") ? 1 : 0);

const routes = await loadRoutes(path.join(import.meta.dirname, "routes"));
const origin = `http://localhost:${config.port}`;

const server = createServer(async (nodeReq, nodeRes) => {
  const started = Date.now();
  const url = new URL(nodeReq.url ?? "/", origin);

  if (url.pathname === "/health") {
    nodeRes.writeHead(200, { "content-type": "application/json" });
    nodeRes.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
    return;
  }

  const found = find(routes, nodeReq.method ?? "GET", url.pathname);
  if (!found || found === "wrong-method") {
    nodeRes.writeHead(found === "wrong-method" ? 405 : 404, { "content-type": "application/json" });
    nodeRes.end(JSON.stringify({ error: found === "wrong-method" ? "That method is not allowed here." : "Not found." }));
    return;
  }

  let request: Request;
  try {
    request = await toRequest(nodeReq, origin);
  } catch (err) {
    const tooLarge = err instanceof PayloadTooLarge;
    nodeRes.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json" });
    nodeRes.end(JSON.stringify({ error: tooLarge ? "That request is too large." : "Could not read the request." }));
    return;
  }

  const ctx: Ctx = { req: request, url, params: found.params, cookies: new CookieJar(nodeReq.headers.cookie) };
  try {
    const response = await requestContext.run(ctx, () => found.route.handler(request, { params: Promise.resolve(ctx.params) }));
    await send(nodeRes, response, ctx.cookies.outgoing);
  } catch (err) {
    console.error(`${nodeReq.method} ${url.pathname}`, err);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "content-type": "application/json" });
      nodeRes.end(JSON.stringify({ error: "Something went wrong on our side." }));
    }
  } finally {
    if (config.logRequests) console.log(`${nodeReq.method} ${url.pathname} ${nodeRes.statusCode} ${Date.now() - started}ms`);
  }
});

server.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port} — ${routes.length} routes, allowing requests from ${config.appUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
