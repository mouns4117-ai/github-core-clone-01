// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL
// and MCP from the same in-memory store. Created by main.ts (the lifecycle) and
// by dev.ts (local runs).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import {
  advertiseV0,
  advertiseV2,
  applyPush,
  fetchV0Body,
  fetchV2Body,
  lsRefsBody,
  parseFetchArgs,
  parseLsRefsArgs,
  parsePushBody,
  parseV0FetchArgs,
  parseV2Request,
  pushReportBody,
} from './git-http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { newRequestId, Store } from './store.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** The token the suite presents: MAKEFUN_SHOP_TOKEN in a trial, any non-empty token locally. */
function expectedToken(): string {
  return (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? (match[1] as string).trim() : null;
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': newRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': newRequestId(),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, messageText: string): void {
  sendJson(res, status, { message: messageText });
}

/** Create the forge server (the store is fresh per process). */
export function createApp(): Server {
  const store = new Store();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await dispatch(store, req, res);
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}

async function dispatch(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const segments = pathname.split('/').filter((segment) => segment !== '');

  // GET /healthz: no auth, the boot probe.
  if (pathname === '/healthz') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { ok: true });
  }

  // Everything else needs the bearer token.
  if (!authorized(req)) return sendError(res, 401, 'Requires authentication');

  // MCP: POST /mcp (DELETE only closes a session; this server hands out none).
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(405, { 'x-github-request-id': newRequestId() });
      return res.end();
    }
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    const bodyText = (await readBody(req)).toString('utf8');
    const reply = handleMcp(store, bodyText);
    if (reply.body === null) {
      res.writeHead(reply.status, { 'x-github-request-id': newRequestId() });
      return res.end();
    }
    return sendJson(res, reply.status, reply.body);
  }

  // GraphQL: POST /api/graphql.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    const bodyText = (await readBody(req)).toString('utf8');
    let parsed: unknown;
    try {
      parsed = bodyText.trim() === '' ? null : JSON.parse(bodyText);
    } catch {
      return sendJson(res, 400, { data: null, errors: [{ message: 'GraphQL body is not valid JSON.' }] });
    }
    const reply = handleGraphQL(store, parsed);
    return sendJson(res, reply.status, reply.body);
  }

  // REST v3: /api/v3 and everything under it.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restSegments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((segment) => segment !== '');
    const host = req.headers.host ?? '127.0.0.1';
    const baseUrl = `http://${host}`;
    let body: unknown = undefined;
    let bodyMalformed = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyMalformed = true;
        }
      }
    }
    const restReq: RestRequest = { method, segments: restSegments, query: url.searchParams, baseUrl, body, bodyMalformed };
    const reply = handleRest(store, restReq);
    const headers: Record<string, string> = { ...(reply.headers ?? {}) };
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': newRequestId(), ...headers });
      return res.end();
    }
    return sendJson(res, reply.status, reply.body, headers);
  }

  // Smart HTTP: /<owner>/<repo>.git/info/refs and the two services.
  if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
    const owner = decodeURIComponent(segments[0] as string);
    const repoName = decodeURIComponent((segments[1] as string).slice(0, -'.git'.length));
    const repo = store.getRepo(owner, repoName);
    if (!repo) return sendError(res, 404, 'Not Found');
    const tail = segments.slice(2);

    if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return sendError(res, 400, 'service is required');
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      if (service === 'git-receive-pack') {
        return sendBytes(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      }
      if (wantsV2) {
        return sendBytes(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      }
      return sendBytes(res, 200, advertiseV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
    }

    if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) {
        const parsed = parseV2Request(body);
        if (parsed.malformed || (parsed.command !== 'ls-refs' && parsed.command !== 'fetch')) {
          return sendError(res, 400, 'malformed git protocol v2 request');
        }
        if (parsed.command === 'ls-refs') {
          return sendBytes(res, 200, lsRefsBody(repo, parseLsRefsArgs(parsed.args)), 'application/x-git-upload-pack-result');
        }
        return sendBytes(res, 200, fetchV2Body(repo, parseFetchArgs(parsed.args)), 'application/x-git-upload-pack-result');
      }
      const parsed = parseV0FetchArgs(body);
      if (parsed.malformed) return sendError(res, 400, 'malformed git protocol v0 request');
      return sendBytes(res, 200, fetchV0Body(repo, parsed.req), 'application/x-git-upload-pack-result');
    }

    if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const parsed = parsePushBody(body);
      if (parsed.malformed || parsed.commands.length === 0) {
        return sendError(res, 400, 'malformed git receive-pack request');
      }
      const result = applyPush(repo, parsed.commands, parsed.pack);
      return sendBytes(res, 200, pushReportBody(result), 'application/x-git-receive-pack-result');
    }

    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}
