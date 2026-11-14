import type { AddressInfo, Server } from 'node:net';
import { AutotaskMcpServer } from '../src/mcp/server';
import { Logger } from '../src/utils/logger';
import type { EnvironmentConfig } from '../src/utils/config';
import type { McpServerConfig } from '../src/types/mcp';

const token = 'synthetic-sdk-backend-token';
const localFetch = globalThis.fetch;
let server: AutotaskMcpServer;
let url: string;
let upstreamCalls: number;
const originalToken = process.env.AUTOTASK_BACKEND_TOKEN;

async function request(method: string, params: unknown, version: string, suppliedToken = token) {
  return localFetch(url, { method: 'POST', headers: {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': version,
    connection: 'close',
    ...(suppliedToken ? { 'x-summit-autotask-backend-token': suppliedToken } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

async function body(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5).trim() : text);
}

describe('v2 SDK Node HTTP compatibility with Summit authentication', () => {
  beforeEach(async () => {
    process.env.AUTOTASK_BACKEND_TOKEN = token;
    upstreamCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const destination = new URL(String(input));
      if (destination.hostname === '127.0.0.1') return localFetch(input, init);
      if (destination.hostname !== 'sdk-fixture.invalid' || !destination.pathname.endsWith('/Tickets/123')) throw new Error('Unexpected outbound request');
      upstreamCalls++;
      return new Response(JSON.stringify({ item: { id: 123, ticketNumber: 'T20261012.0001', title: 'Fixture ticket', companyID: 42 } }));
    });
    const config: McpServerConfig = { name: 'sdk-fixture', version: '0', autotask: {
      username: 'synthetic', secret: 'synthetic', integrationCode: 'synthetic', apiUrl: 'https://sdk-fixture.invalid/atservicesrest/',
    } };
    const env: EnvironmentConfig = { autotask: {}, server: { name: config.name, version: config.version },
      transport: { type: 'http', port: 0, host: '127.0.0.1' }, logging: { level: 'error', format: 'simple' }, auth: { mode: 'env' } };
    server = new AutotaskMcpServer(config, new Logger('error'), env);
    await server.start();
    const http = (server as unknown as { httpServer: Server }).httpServer;
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });
  afterEach(async () => {
    await server.stop();
    jest.restoreAllMocks();
    if (originalToken === undefined) delete process.env.AUTOTASK_BACKEND_TOKEN;
    else process.env.AUTOTASK_BACKEND_TOKEN = originalToken;
  });

  test.each(['2024-11-05', '2025-06-18', '2025-11-25'])('preserves initialize, discovery and a mocked ticket read on %s', async version => {
    const init = await request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'fixture', version: '0' } }, version);
    expect(init.status).toBe(200);
    expect((await body(init)).result.protocolVersion).toBe(version);
    const list = await request('tools/list', {}, version);
    expect(list.status).toBe(200);
    expect((await body(list)).result.tools.map((tool: { name: string }) => tool.name)).toContain('autotask_get_ticket_details');
    const read = await request('tools/call', { name: 'autotask_get_ticket_details', arguments: { ticketID: 123 } }, version);
    expect(read.status).toBe(200);
    const result = (await body(read)).result;
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Fixture ticket');
    expect(upstreamCalls).toBe(1);
  });

  test.each(['', 'wrong-synthetic-token'])('rejects unauthenticated reads before the mocked provider (%s)', async suppliedToken => {
    const response = await request('tools/call', { name: 'autotask_get_ticket_details', arguments: { ticketID: 123 } }, '2025-06-18', suppliedToken);
    expect(response.status).toBe(401);
    await response.text();
    expect(upstreamCalls).toBe(0);
  });
});
