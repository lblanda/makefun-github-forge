// HTTP entrypoint: one process, one in-memory store. Routes:
//   GET  /healthz            no auth, {"ok": true}
//   /api/v3/*                REST v3 (Bearer auth)
//   POST /api/graphql        GraphQL v4 (Bearer auth)
//   POST|DELETE /mcp         MCP Streamable HTTP (Bearer auth)
//   /{owner}/{repo}.git/*    git smart HTTP (Bearer auth)
// Everything else is 404 JSON. The server never crashes on a bad request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${expectedToken}`;
}

export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req, res) => {
    void handleRequest(req, res, store, expectedToken).catch((error: unknown) => {
      console.error('request failed', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': store.nextRequestId() });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } else {
        res.end();
      }
    });
  });
  // The timed workloads reuse one keep-alive connection for thousands of
  // sequential requests; keep it alive well past the default 5 s so a slow
  // round does not pay a reconnect per request.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 65_000;
  return server;
}

function sendJson(res: ServerResponse, store: Store, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': store.nextRequestId(), ...extraHeaders };
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sendRaw(res: ServerResponse, store: Store, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'X-GitHub-Request-Id': store.nextRequestId() });
  res.end(body);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store, expectedToken: string): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const host = req.headers.host ?? '127.0.0.1';

  // Health check: no auth, always up.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, store, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req, expectedToken)) {
    sendJson(res, store, 401, { message: 'Unauthorized' });
    return;
  }

  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : Buffer.alloc(0);

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const segments = pathname.split('/').filter((part) => part.length > 0).slice(2);
    let parsed: unknown = undefined;
    let bodyInvalid = false;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        bodyInvalid = true;
      }
    }
    const result = handleRest(store, method, segments, url.searchParams, parsed, bodyInvalid, host);
    sendJson(res, store, result.status, result.body, result.headers ?? {});
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, store, 405, { message: 'Method Not Allowed' });
      return;
    }
    let parsed: unknown = undefined;
    let bodyInvalid = false;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        bodyInvalid = true;
      }
    } else {
      bodyInvalid = true;
    }
    const result = handleGraphQL(store, parsed, bodyInvalid, host);
    sendJson(res, store, result.status, result.body);
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    let parsed: unknown = undefined;
    let bodyInvalid = false;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        bodyInvalid = true;
      }
    }
    const result = handleMcp(store, method, parsed, bodyInvalid);
    sendJson(res, store, result.status, result.body);
    return;
  }

  // Git smart HTTP.
  if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(pathname)) {
    const result = handleGit(method, pathname, url.searchParams, req.headers, body, store);
    sendRaw(res, store, result.status, result.contentType, result.body);
    return;
  }

  sendJson(res, store, 404, { message: 'Not Found' });
}
