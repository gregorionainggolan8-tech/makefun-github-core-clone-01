// app.ts — the forge's HTTP server: one process serving git smart HTTP, REST v3,
// GraphQL v4 and MCP from a single in-memory store. Only the Node standard library.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, parseJsonBody } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { nextRequestId } from './gitcore.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/** Build the server. It binds nothing until the caller listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://forge');
      } catch {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const path = url.pathname;
      const segments = path.split('/').filter((part) => part !== '');

      try {
        // Health probe: no auth, always 200.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!bearerToken(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Bad Request: malformed JSON body' });
            return;
          }
          const result = handleGraphql(store, body);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP over Streamable HTTP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!bearerToken(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end(JSON.stringify({ message: 'Requires authentication' }));
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, raw.toString('utf8'));
          if (result.status === 202 || result.body === null) {
            res.writeHead(202, { 'content-length': 0 });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          if (!bearerToken(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown = null;
          if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
            try {
              body = parseJsonBody(raw);
            } catch {
              sendJson(res, 400, { message: 'Bad Request: malformed JSON body' });
              return;
            }
          }
          const restSegments = path === '/api/v3' || path === '/api/v3/' ? [''] : path.slice('/api/v3/'.length).split('/');
          const rawUrl = `http://forge${path}${url.search}`;
          const result = handleRest(store, method, restSegments, url.searchParams, rawUrl, body);
          if (result.status === 204) {
            sendJson(res, 204, null, result.headers);
            return;
          }
          sendJson(res, result.status, result.body, result.headers);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -4);
          const repo = store.getRepo(owner, repoName);
          const service = url.searchParams.get('service');
          if (method === 'GET' && segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'Bad Request: unknown service' });
              return;
            }
            const v2 = req.headers['git-protocol'] === 'version=2';
            const result = infoRefs(repo, service, v2);
            sendBytes(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && segments.length === 3 && segments[2] === 'git-upload-pack') {
            const raw = await readBody(req);
            const v2 = req.headers['git-protocol'] === 'version=2';
            const result = uploadPack(repo, v2, raw);
            sendBytes(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && segments.length === 3 && segments[2] === 'git-receive-pack') {
            const raw = await readBody(req);
            const result = receivePack(repo, raw);
            sendBytes(res, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        // A handler must never take the server down: answer JSON 500 and keep serving.
        try {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}

export { Store };
