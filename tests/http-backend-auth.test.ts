import { AutotaskMcpServer } from '../src/mcp/server.js';
import { Logger } from '../src/utils/logger.js';
import type { EnvironmentConfig } from '../src/utils/config.js';
import type { McpServerConfig } from '../src/types/mcp.js';

function buildEnvConfig(port: number): EnvironmentConfig {
  return {
    autotask: {},
    server: { name: 'autotask-mcp-test', version: '0.0.0-test' },
    transport: { type: 'http', port, host: '127.0.0.1' },
    logging: { level: 'error', format: 'simple' },
    auth: { mode: 'env' },
  };
}

function buildMcpConfig(): McpServerConfig {
  return {
    name: 'autotask-mcp-test',
    version: '0.0.0-test',
    autotask: { username: '', secret: '', integrationCode: '' },
  } as McpServerConfig;
}

function pickPort(): number {
  return 40000 + Math.floor(Math.random() * 1000);
}

const MCP_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'backend-auth-test', version: '0' },
  },
});

describe('HTTP proxy-to-provider authentication', () => {
  const originalToken = process.env.AUTOTASK_BACKEND_TOKEN;
  let server: AutotaskMcpServer;
  let port: number;

  beforeEach(async () => {
    process.env.AUTOTASK_BACKEND_TOKEN = 'backend-secret';
    port = pickPort();
    server = new AutotaskMcpServer(
      buildMcpConfig(),
      new Logger('error', 'simple'),
      buildEnvConfig(port),
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    if (originalToken === undefined) delete process.env.AUTOTASK_BACKEND_TOKEN;
    else process.env.AUTOTASK_BACKEND_TOKEN = originalToken;
  });

  it('keeps health open when the backend token is absent', async () => {
    delete process.env.AUTOTASK_BACKEND_TOKEN;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
  });

  it('reports readiness only when the backend token is configured', async () => {
    delete process.env.AUTOTASK_BACKEND_TOKEN;
    const notReady = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(notReady.status).toBe(503);

    process.env.AUTOTASK_BACKEND_TOKEN = 'backend-secret';
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);
  });

  it('fails closed before MCP dispatch when the token is absent', async () => {
    delete process.env.AUTOTASK_BACKEND_TOKEN;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MCP_BODY,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Backend authentication is not configured.',
    });
  });

  it('rejects a missing or incorrect token before MCP dispatch', async () => {
    const missing = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MCP_BODY,
    });
    expect(missing.status).toBe(401);

    const incorrect = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-summit-autotask-backend-token': 'wrong-token',
      },
      body: MCP_BODY,
    });
    expect(incorrect.status).toBe(401);
  });

  it('accepts the configured token for normal MCP requests', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-summit-autotask-backend-token': 'backend-secret',
      },
      body: MCP_BODY,
    });
    expect(response.status).toBe(200);
  });
});
