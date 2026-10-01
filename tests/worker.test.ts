// Tests for the Cloudflare Workers entrypoint.
//
// Drives the exported `fetch` handler directly with Web Standard Request objects
// (available natively in Node 18+), exercising the same createMcpHandler
// dual-era serving the Worker uses in production.

import worker, { type Env } from '../src/worker.js';

const MCP_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
  'X-Summit-Autotask-Backend-Token': 'backend-secret',
};

const DEFAULT_ENV: Env = {
  AUTOTASK_BACKEND_TOKEN: 'backend-secret',
};

/**
 * Parse a JSON-RPC response body that may arrive either as plain JSON or as
 * an SSE stream. The v2 SDK's stateless legacy fallback answers 2025-era
 * POSTs with `text/event-stream` (one `message` event per response) — the
 * canonical Streamable HTTP shape every spec-conforming client accepts.
 */
async function mcpBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new Error(`No data frame in SSE body: ${text}`);
    return JSON.parse(last.slice('data:'.length).trim()) as T;
  }
  return JSON.parse(text) as T;
}

async function mcp(
  body: unknown,
  env: Env = {},
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return worker.fetch(
    new Request('http://worker.local/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...extraHeaders },
      body: JSON.stringify(body),
    }),
    { ...DEFAULT_ENV, ...env }
  );
}

describe('Cloudflare Worker entrypoint', () => {
  it('serves a shallow health probe', async () => {
    const res = await worker.fetch(
      new Request('http://worker.local/health'),
      {}
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ok');
  });

  it('answers CORS preflight', async () => {
    const res = await worker.fetch(
      new Request('http://worker.local/mcp', { method: 'OPTIONS' }),
      {}
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('reports readiness only when the backend token is configured', async () => {
    const notReady = await worker.fetch(
      new Request('http://worker.local/ready'),
      {},
    );
    expect(notReady.status).toBe(503);

    const ready = await worker.fetch(
      new Request('http://worker.local/ready'),
      DEFAULT_ENV,
    );
    expect(ready.status).toBe(200);
  });

  it('keeps health open while backend authentication is unavailable', async () => {
    const res = await worker.fetch(
      new Request('http://worker.local/health'),
      {},
    );
    expect(res.status).toBe(200);
  });

  it('rejects MCP requests when the backend token is missing', async () => {
    const res = await mcp(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {},
      },
      { AUTOTASK_BACKEND_TOKEN: '' },
    );
    expect(res.status).toBe(503);
  });

  it('rejects MCP requests with an invalid backend token', async () => {
    const res = await mcp(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'initialize',
        params: {},
      },
      {},
      { 'X-Summit-Autotask-Backend-Token': 'wrong-token' },
    );
    expect(res.status).toBe(401);
  });

  it('preserves optional gateway HMAC enforcement on the Worker entrypoint', async () => {
    const res = await mcp(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'initialize',
        params: {},
      },
      { CONDUIT_S2S_SECRET: 'hmac-secret' },
    );
    expect(res.status).toBe(401);
  });

  it('404s unknown paths', async () => {
    const res = await worker.fetch(new Request('http://worker.local/nope'), {});
    expect(res.status).toBe(404);
  });

  it('handles MCP initialize', async () => {
    const res = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'jest', version: '0' },
      },
    });
    expect(res.status).toBe(200);
    const body = await mcpBody<{
      result?: { serverInfo?: { name?: string } };
    }>(res);
    expect(body.result?.serverInfo?.name).toBe('autotask-mcp');
  });

  it('lists all tools without credentials', async () => {
    const res = await mcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await mcpBody<{
      result?: { tools?: { name: string }[] };
    }>(res);
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('autotask_test_connection');
    expect(names).toContain('autotask_search_companies');
    expect(names.length).toBeGreaterThan(10);
  });

  it('returns a graceful error for a credential-requiring tool when unconfigured', async () => {
    const res = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'autotask_test_connection', arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = await mcpBody<{
      result?: { isError?: boolean; content?: { text?: string }[] };
    }>(res);
    expect(body.result?.isError).toBe(true);
  });

  it('rejects /mcp in gateway mode without credential headers', async () => {
    const res = await mcp(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'autotask_test_connection', arguments: {} },
      },
      { AUTH_MODE: 'gateway' }
    );
    expect(res.status).toBe(401);
  });

  it('accepts /mcp in gateway mode with credential headers', async () => {
    const res = await mcp(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
        params: {},
      },
      { AUTH_MODE: 'gateway' },
      {
        'X-API-Key': 'test-user',
        'X-API-Secret': 'test-secret',
        'X-Integration-Code': 'test-code',
      }
    );
    expect(res.status).toBe(200);
    const body = await mcpBody<{
      result?: { tools?: { name: string }[] };
    }>(res);
    expect((body.result?.tools ?? []).length).toBeGreaterThan(10);
  });
});
