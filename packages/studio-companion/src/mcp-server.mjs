import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CODEX_TOOLS, MCP_INSTRUCTIONS} from './codex-tools.mjs';

export function createStudioMcpServer({url = 'http://127.0.0.1:4180', fetchImpl = fetch} = {}) {
  const service = new URL(url);
  if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1' || service.pathname !== '/' || service.search || service.hash || service.username || service.password) throw new TypeError('MCP service must be an HTTP URL on 127.0.0.1.');
  const server = new McpServer({name: 'vyvyd-studio', version: '0.2.0'}, {instructions: MCP_INSTRUCTIONS});
  let heartbeat;
  const request = async (pathname, args) => {
    let response;
    try {
      response = await fetchImpl(new URL(pathname, service), {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-MCP-Client': encodeURIComponent(server.server.getClientVersion()?.name ?? 'MCP client')}, body: JSON.stringify(args), signal: AbortSignal.timeout(180000)});
    } catch {throw new Error('포스터 메이커 서비스에 연결할 수 없습니다. vyvyd에서 npm run studio:server를 실행해 주세요.');}
    const result = await response.json();
    if (!response.ok) throw new Error(`${result.error?.code ?? response.status}: ${result.error?.message ?? '로컬 프로젝트 요청에 실패했습니다.'}`);
    return result;
  };
  for (const definition of CODEX_TOOLS) {
    server.registerTool(definition.name, {description: definition.description, inputSchema: definition.shape, annotations: {readOnlyHint: definition.readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false}}, async (args) => {
      try {
        const result = await request(`/codex/tools/${definition.name}`, args);
        if (result.image) return {content: [{type: 'text', text: JSON.stringify(result.metadata)}, {type: 'image', ...result.image}]};
        return {content: [{type: 'text', text: JSON.stringify(result)}]};
      } catch (cause) {return {isError: true, content: [{type: 'text', text: cause.message}]};}
    });
  }
  server.server.oninitialized = () => {
    const connect = () => request('/codex/connect', {}).catch(() => undefined);
    void connect();
    heartbeat = setInterval(() => {void connect();}, 20000);
    heartbeat.unref();
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {clearInterval(heartbeat); await originalClose();};
  server.server.onclose = () => {clearInterval(heartbeat);};
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createStudioMcpServer({url: process.env.STUDIO_SERVICE_URL ?? 'http://127.0.0.1:4180'});
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {maxBufferSize: 32 * 1024 * 1024}));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {void server.close();});
}
