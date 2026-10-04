import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProjectStore, DEFAULT_DATA_DIR, MAX_ASSET_BYTES, StudioStoreError} from './project-store.mjs';
import {createStudioController} from './studio-controller.mjs';
import {parseTool} from './codex-tools.mjs';
import {createWorkerPreviewRuntime} from './worker-preview-runtime.mjs';

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://vyvyd.pages.dev'];
const JSON_BODY_LIMIT = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const error = (code, message, statusCode = 400) => new StudioStoreError(code, message, statusCode);
const contentType = (request) => String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();

const readBody = (request, limit) => new Promise((resolve, reject) => {
  if (Number(request.headers['content-length'] ?? 0) > limit) {
    request.resume();
    reject(error('BODY_TOO_LARGE', '요청 파일 또는 문서의 크기가 제한을 초과했습니다.', 413));
    return;
  }
  let size = 0;
  const chunks = [];
  const cleanup = () => {
    request.removeListener('data', onData);
    request.removeListener('end', onEnd);
    request.removeListener('error', onError);
    request.removeListener('aborted', onAborted);
  };
  const onData = (chunk) => {
    size += chunk.length;
    if (size > limit) {
      cleanup();
      chunks.length = 0;
      request.resume();
      reject(error('BODY_TOO_LARGE', '요청 파일 또는 문서의 크기가 제한을 초과했습니다.', 413));
    } else chunks.push(chunk);
  };
  const onEnd = () => {cleanup(); resolve(Buffer.concat(chunks));};
  const onError = (cause) => {cleanup(); reject(cause);};
  const onAborted = () => {cleanup(); reject(error('REQUEST_ABORTED', '요청이 중단되었습니다.'));};
  request.on('data', onData);
  request.on('end', onEnd);
  request.on('error', onError);
  request.on('aborted', onAborted);
});

const readJson = async (request, limit = JSON_BODY_LIMIT) => {
  if (contentType(request) !== 'application/json') throw error('UNSUPPORTED_CONTENT_TYPE', 'application/json 요청이 필요합니다.', 415);
  const bytes = await readBody(request, limit);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value;
  } catch {throw error('INVALID_JSON', 'JSON 객체를 읽을 수 없습니다.');}
};

const json = (response, statusCode, value) => {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body)});
  response.end(body);
};

export function createStudioServer({dataDir = DEFAULT_DATA_DIR, allowedOrigins = [], previewRuntime} = {}) {
  const origins = new Set([...DEFAULT_ORIGINS, ...allowedOrigins].map((origin) => {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') throw new TypeError('Allowed origins must be HTTP or HTTPS origins');
    return parsed.origin;
  }));
  const store = createProjectStore({dataDir});
  const runtime = previewRuntime ?? createWorkerPreviewRuntime({storeDataDir: store.dataDir,
    previewDataDir: path.join(path.dirname(store.dataDir), 'previews'), parentOrigins: [...origins]});
  const controller = createStudioController({store, runtime, origin: () => {
    const address = server.address();
    return `http://127.0.0.1:${address?.port ?? 4180}`;
  }});

  const server = createServer(async (request, response) => {
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const hostname = String(request.headers.host ?? '').split(':', 1)[0];
      if (!['127.0.0.1', 'localhost'].includes(hostname)) throw error('HOST_NOT_ALLOWED', '로컬 주소에서만 프로젝트 서비스에 연결할 수 있습니다.', 403);
      const pathname = (request.url ?? '/').split('?', 1)[0];
      if (pathname.includes('\\') || pathname.includes('%') || pathname.split('/').includes('..')) throw error('INVALID_PATH', '올바른 프로젝트 경로가 필요합니다.');
      // Opaque sandbox previews can only read immutable preview snapshots, never project APIs.
      if (pathname.startsWith('/previews/')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw error('METHOD_NOT_ALLOWED', '미리보기 파일은 읽기만 가능합니다.', 405);
        if (await runtime.handle(request, response)) return;
        throw error('NOT_FOUND', '미리보기 파일을 찾을 수 없습니다.', 404);
      }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== 'string' || !origins.has(origin)) throw error('ORIGIN_NOT_ALLOWED', '허용된 vyvyd 화면에서만 연결할 수 있습니다.', 403);
        response.setHeader('Access-Control-Allow-Origin', origin);
      }
      const mutation = request.method === 'POST' || request.method === 'PUT';
      // Node fetch also adds Sec-Fetch-Mode; Site/Dest identify browser requests without rejecting local CLI clients.
      if (mutation && origin === undefined && (request.headers['sec-fetch-site'] !== undefined || request.headers['sec-fetch-dest'] !== undefined)) {
        throw error('ORIGIN_REQUIRED', '브라우저 수정 요청에는 Origin이 필요합니다.', 403);
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-Expected-Revision');
        response.setHeader('Access-Control-Max-Age', '600');
        if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.writeHead(204);
        response.end();
        return;
      }
      if (pathname === '/health' && request.method === 'GET') {
        json(response, 200, {service: 'vyvyd-studio', protocolVersion: 2, status: 'ok'});
        return;
      }
      if (pathname.startsWith('/codex/')) {
        if (request.method !== 'POST') throw error('METHOD_NOT_ALLOWED', 'MCP 요청은 POST를 사용합니다.', 405);
        if (origin !== undefined || request.headers['sec-fetch-site'] !== undefined || request.headers['sec-fetch-dest'] !== undefined) throw error('MCP_BROWSER_REQUEST_FORBIDDEN', 'MCP 연결은 로컬 Codex 프로세스에서만 사용할 수 있습니다.', 403);
        let clientName;
        try {clientName = decodeURIComponent(String(request.headers['x-studio-mcp-client'] ?? ''));} catch {throw error('INVALID_MCP_CLIENT', 'MCP 클라이언트 이름을 읽을 수 없습니다.');}
        if (!clientName || clientName.length > 80 || /[\u0000-\u001f\u007f]/.test(clientName)) throw error('INVALID_MCP_CLIENT', 'MCP 클라이언트 정보가 필요합니다.');
        const args = await readJson(request, 30 * 1024 * 1024);
        if (pathname === '/codex/connect') json(response, 200, controller.connect(clientName));
        else {
          const toolRoute = /^\/codex\/tools\/([a-z_]+)$/.exec(pathname);
          if (!toolRoute) throw error('NOT_FOUND', 'MCP 도구를 찾을 수 없습니다.', 404);
          let parsed;
          try {parsed = parseTool(toolRoute[1], args);} catch {throw error('INVALID_TOOL_ARGUMENTS', 'MCP 도구 인자가 올바르지 않습니다. 프로젝트 ID, 수정 번호와 요청 ID를 확인해 주세요.');}
          if (!parsed) throw error('UNKNOWN_TOOL', 'MCP 도구를 찾을 수 없습니다.', 404);
          json(response, 200, await controller.tool(parsed.definition.name, parsed.args, clientName));
        }
        return;
      }
      if (pathname === '/projects') {
        if (request.method === 'GET') json(response, 200, await store.listProjects());
        else if (request.method === 'POST') json(response, 201, await store.createProject(await readJson(request)));
        else throw error('METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.', 405);
        return;
      }
      const projectRoute = /^\/projects\/([^/]+)$/.exec(pathname);
      if (projectRoute) {
        if (request.method === 'GET') json(response, 200, await store.readProject(projectRoute[1]));
        else if (request.method === 'PUT') json(response, 200, await controller.save(projectRoute[1], await readJson(request)));
        else throw error('METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.', 405);
        return;
      }
      const historyRoute = /^\/projects\/([^/]+)\/history$/.exec(pathname);
      if (historyRoute) {
        if (request.method !== 'GET') throw error('METHOD_NOT_ALLOWED', '수정 이력은 GET으로 읽을 수 있습니다.', 405);
        json(response, 200, await store.listHistory(historyRoute[1]));
        return;
      }
      const historyVersionRoute = /^\/projects\/([^/]+)\/history\/([^/]+)$/.exec(pathname);
      if (historyVersionRoute) {
        if (request.method !== 'GET') throw error('METHOD_NOT_ALLOWED', '수정 이력은 GET으로 읽을 수 있습니다.', 405);
        if (!/^[1-9]\d*$/.test(historyVersionRoute[2])) throw error('INVALID_REVISION', '올바른 수정 번호가 필요합니다.');
        json(response, 200, await store.readHistory(historyVersionRoute[1], Number(historyVersionRoute[2])));
        return;
      }
      const requestRoute = /^\/projects\/([^/]+)\/requests\/([^/]+)$/.exec(pathname);
      if (requestRoute) {
        if (request.method !== 'GET') throw error('METHOD_NOT_ALLOWED', '요청 기록은 GET으로 읽을 수 있습니다.', 405);
        const receipt = await store.getRequest(requestRoute[1], requestRoute[2]);
        if (!receipt) throw error('REQUEST_NOT_FOUND', '반영된 요청 기록을 찾을 수 없습니다.', 404);
        json(response, 200, {projectId: requestRoute[1].toLowerCase(), requestId: receipt.requestId,
          appliedRevision: receipt.revision, kind: receipt.kind});
        return;
      }
      const restoreRoute = /^\/projects\/([^/]+)\/restore$/.exec(pathname);
      if (restoreRoute) {
        if (request.method !== 'POST') throw error('METHOD_NOT_ALLOWED', '버전 복원은 POST를 사용합니다.', 405);
        json(response, 200, await controller.restoreVersion(restoreRoute[1], await readJson(request)));
        return;
      }
      const statusRoute = /^\/projects\/([^/]+)\/status$/.exec(pathname);
      if (statusRoute && request.method === 'GET') {
        json(response, 200, await controller.status(statusRoute[1]));
        return;
      }
      const compileRoute = /^\/projects\/([^/]+)\/compile$/.exec(pathname);
      if (compileRoute && request.method === 'POST') {
        const input = await readJson(request);
        json(response, 202, await controller.compile(compileRoute[1], input.expectedRevision));
        return;
      }
      const uploadRoute = /^\/projects\/([^/]+)\/assets$/.exec(pathname);
      if (uploadRoute) {
        if (request.method !== 'POST') throw error('METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.', 405);
        const mimeType = contentType(request);
        if (!IMAGE_TYPES.has(mimeType)) throw error('UNSUPPORTED_IMAGE_TYPE', 'PNG, JPEG, WebP, GIF 파일만 추가할 수 있습니다.', 415);
        let name;
        try {name = decodeURIComponent(String(request.headers['x-file-name'] ?? ''));} catch {throw error('INVALID_FILE_NAME', '파일 이름을 읽을 수 없습니다.');}
        const header = request.headers['x-expected-revision'];
        if (typeof header !== 'string' || !/^[1-9]\d*$/.test(header)) throw error('INVALID_REVISION', '현재 수정 번호가 필요합니다.');
        const bytes = await readBody(request, MAX_ASSET_BYTES);
        const saved = await store.uploadAsset(uploadRoute[1], {expectedRevision: Number(header), name, mimeType, bytes});
        json(response, 201, saved);
        void controller.refresh(saved.id, saved.revision).catch(() => undefined);
        return;
      }
      const assetRoute = /^\/projects\/([^/]+)\/assets\/([^/]+)$/.exec(pathname);
      if (assetRoute) {
        if (!['GET', 'HEAD'].includes(request.method)) throw error('METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.', 405);
        const {asset, bytes} = await store.readAsset(assetRoute[1], assetRoute[2]);
        response.writeHead(200, {'Content-Type': asset.mimeType, 'Content-Length': bytes.length});
        response.end(request.method === 'HEAD' ? undefined : bytes);
        return;
      }
      throw error('NOT_FOUND', '요청한 작업을 찾을 수 없습니다.', 404);
    } catch (cause) {
      request.resume();
      if (response.destroyed || response.writableEnded) return;
      const known = cause instanceof StudioStoreError;
      json(response, known ? cause.statusCode : 500, {error: {code: known ? cause.code : 'INTERNAL_ERROR', message: known ? cause.message : '로컬 프로젝트 저장소에서 오류가 발생했습니다.', ...(known && cause.diagnostics ? {diagnostics: cause.diagnostics} : {})}});
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.studio = {store, controller, runtime};
  return server;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const port = Number(process.env.STUDIO_PORT ?? 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('STUDIO_PORT must be between 1 and 65535');
  const server = createStudioServer({dataDir: process.env.STUDIO_DATA_DIR ?? DEFAULT_DATA_DIR, allowedOrigins: process.env.STUDIO_ALLOWED_ORIGIN ? [process.env.STUDIO_ALLOWED_ORIGIN] : []});
  server.listen(port, '127.0.0.1', () => process.stdout.write(`vyvyd studio: http://127.0.0.1:${port}\n`));
  server.on('error', (cause) => {process.stderr.write(`${cause.message}\n`); process.exitCode = 1;});
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
