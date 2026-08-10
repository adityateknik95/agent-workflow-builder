// Local stand-in for nhost's functions runtime.
//
// nhost maps every file under functions/ to an HTTP route and calls its default
// export with express-style (req, res). This server does the same thing over
// node:http, so the handler files that run locally are byte-for-byte the ones that
// get deployed -- no local-only wrapper, no second code path.
//
//   node --import tsx tools/functions-dev-server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';

const FUNCTIONS_DIR = join(import.meta.dirname, '..', 'functions');
const PORT = Number(process.env.FUNCTIONS_PORT ?? 3001);

type Handler = (req: unknown, res: unknown) => unknown;

/** Collects handler files, mirroring nhost: `_`-prefixed paths are libraries. */
function collectRoutes(dir: string, routes = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_') || entry === 'node_modules') continue;
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      collectRoutes(full, routes);
    } else if (/\.(ts|js|mjs)$/.test(entry)) {
      const route = '/' + relative(FUNCTIONS_DIR, full).split(sep).join('/').replace(/\.(ts|js|mjs)$/, '');
      routes.set(route, full);
    }
  }
  return routes;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

/** The subset of the express response API the handlers use. */
function makeResponse(res: ServerResponse) {
  let statusCode = 200;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      const payload = JSON.stringify(body);
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(payload);
    },
    send(body?: unknown) {
      res.writeHead(statusCode, { 'content-type': 'text/plain' });
      res.end(body === undefined ? '' : String(body));
    },
  };
}

const routes = collectRoutes(FUNCTIONS_DIR);

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routes: [...routes.keys()].sort() }));
    return;
  }

  const file = routes.get(path);
  if (!file) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `no function at ${path}`, routes: [...routes.keys()].sort() }));
    return;
  }

  const started = Date.now();
  try {
    // Cache-busted so editing a handler takes effect without restarting.
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const handler = (module.default ?? module.handler) as Handler | undefined;
    if (typeof handler !== 'function') throw new Error(`${path} has no default export`);

    const body = await readBody(req);
    await handler({ method: req.method, headers: req.headers, body }, makeResponse(res));
    console.log(`${req.method} ${path} -> ${res.statusCode} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(`${req.method} ${path} threw:`, error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message: error instanceof Error ? error.message : 'handler crashed',
          extensions: { code: 'internal-error' },
        })
      );
    }
  }
});

server.listen(PORT, () => {
  console.log(`functions dev server on http://localhost:${PORT}`);
  for (const route of [...routes.keys()].sort()) console.log(`  ${route}`);
});
