import type { AddressInfo, Server } from 'node:net';
import { AutotaskMcpServer } from '../src/mcp/server';
import { Logger } from '../src/utils/logger';
import type { EnvironmentConfig } from '../src/utils/config';
import type { McpServerConfig } from '../src/types/mcp';

const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=';
const attachment = { id: 456, ticketID: 123, ticketNoteID: 789, fileName: 'fixture.png', contentType: 'image/png', data: IMAGE };
const config: McpServerConfig = { name: 'http-image-test', version: '0', autotask: {
  username: 'synthetic', secret: 'synthetic', integrationCode: 'synthetic', apiUrl: 'https://image-http.invalid/atservicesrest/',
} };

describe('native image responses over authenticated provider HTTP', () => {
  let server: AutotaskMcpServer;
  let baseUrl: string;
  const localFetch = globalThis.fetch;
  const previousToken = process.env.AUTOTASK_BACKEND_TOKEN;
  let upstreamCalls: number;
  beforeEach(async () => {
    process.env.AUTOTASK_BACKEND_TOKEN = 'synthetic-image-backend-token';
    upstreamCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === '127.0.0.1') return localFetch(input, init);
      if (url.hostname !== 'image-http.invalid') throw new Error('Unexpected outbound request');
      upstreamCalls++;
      if (/\/Ticket(?:Note)?Attachments\/456$/.test(url.pathname)) return new Response(JSON.stringify({ item: attachment }));
      throw new Error('Unexpected Autotask endpoint');
    });
    const env: EnvironmentConfig = {
      autotask: {}, server: { name: config.name, version: config.version },
      transport: { type: 'http', port: 0, host: '127.0.0.1' },
      logging: { level: 'error', format: 'simple' }, auth: { mode: 'env' }, lazyLoading: true,
    };
    server = new AutotaskMcpServer(config, new Logger('error'), env);
    await server.start();
    const httpServer = (server as unknown as { httpServer: Server }).httpServer;
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  });
  afterEach(async () => {
    await server.stop(); jest.restoreAllMocks();
    if (previousToken === undefined) delete process.env.AUTOTASK_BACKEND_TOKEN;
    else process.env.AUTOTASK_BACKEND_TOKEN = previousToken;
  });
  async function request(method: string, params: unknown, version = '2025-06-18', token: string | undefined = 'synthetic-image-backend-token') {
    return localFetch(baseUrl, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      // Each case restarts the fixture on the same origin. Do not reuse a
      // pooled connection from the server that the preceding case closed.
      connection: 'close',
      'mcp-protocol-version': version, ...(token ? { 'x-summit-autotask-backend-token': token } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  }
  async function rpcBody(response: Response) {
    const text = await response.text();
    return JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5).trim() : text);
  }
  test.each(['2024-11-05', '2025-06-18'])('protocol %s transports native ticket image blocks', async version => {
    const init = await request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'image-fixture', version: '0' } }, version);
    expect(init.status).toBe(200);
    await rpcBody(init); // Consume the initialization response before teardown.
    const response = await request('tools/call', { name: 'autotask_get_ticket_attachment', arguments: { ticketId: 123, attachmentId: 456, includeData: true } }, version);
    expect(response.status).toBe(200);
    const body = await rpcBody(response);
    expect(body.result.isError).not.toBe(true);
    expect(body.result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: IMAGE });
    expect(body.result.content[0].text).not.toContain(IMAGE);
    expect(upstreamCalls).toBe(1);
  });
  test('note image transports with parent ticket verification', async () => {
    const response = await request('tools/call', { name: 'autotask_get_ticket_note_attachment', arguments: { ticketId: 123, ticketNoteId: 789, attachmentId: 456, includeData: true } });
    const body = await rpcBody(response);
    expect(body.result.content[1]?.type).toBe('image');
    expect(upstreamCalls).toBe(1);
  });
  test('wrong parent produces only an error over HTTP', async () => {
    const response = await request('tools/call', { name: 'autotask_get_ticket_note_attachment', arguments: { ticketId: 124, ticketNoteId: 789, attachmentId: 456, includeData: true } });
    const body = await rpcBody(response);
    expect(body.result.isError).toBe(true); expect(body.result.content).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(IMAGE);
  });
  test('unauthorized image calls are rejected before fetching data', async () => {
    for (const token of ['', 'incorrect-synthetic-token']) {
      const response = await request('tools/call', { name: 'autotask_get_ticket_attachment', arguments: { ticketId: 123, attachmentId: 456, includeData: true } }, '2025-06-18', token);
      expect(response.status).toBe(401);
    }
    expect(upstreamCalls).toBe(0);
  });
});
