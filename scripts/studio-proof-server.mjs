import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stage 0 connectivity probe only. It does not execute projects or expose their files.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredPort = process.env.STUDIO_PROOF_PORT ?? '4179';
if (!/^\d+$/.test(configuredPort) || Number(configuredPort) < 1 || Number(configuredPort) > 65535) {
  throw new Error('STUDIO_PROOF_PORT must be an integer between 1 and 65535.');
}
const port = Number(configuredPort);
const serverOrigin = `http://127.0.0.1:${port}`;
const allowedOrigins = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'https://vyvyd.pages.dev',
]);
const additionalOrigin = process.env.STUDIO_PROOF_ALLOWED_ORIGIN;
if (additionalOrigin) {
  let parsed;
  try {
    parsed = new URL(additionalOrigin);
  } catch {
    throw new Error('STUDIO_PROOF_ALLOWED_ORIGIN must be an exact HTTP(S) origin.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== additionalOrigin) {
    throw new Error('STUDIO_PROOF_ALLOWED_ORIGIN must be an exact HTTP(S) origin without a path.');
  }
  allowedOrigins.add(additionalOrigin);
}

const preview = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>로컬 연결 검증</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #0b0c10; color: #eeeaf8; font-family: system-ui, sans-serif; }
    main { text-align: center; max-width: 440px; }
    .orbit { width: min(180px, 50vw); height: auto; animation: float 3s ease-in-out infinite; }
    h1 { margin: 24px 0 8px; font-size: 22px; }
    p { margin: 0; color: #aaa5bb; font-size: 14px; line-height: 1.6; }
    .status { display: inline-block; margin-top: 18px; padding: 6px 12px; border: 1px solid #38b78b; border-radius: 999px; color: #7fe5b6; font-size: 12px; }
    @keyframes float { 0%, 100% { transform: translateY(0) rotate(-5deg); } 50% { transform: translateY(-12px) rotate(5deg); } }
    @media (prefers-reduced-motion: reduce) { .orbit { animation: none; } }
  </style>
</head>
<body>
  <main>
    <img class="orbit" src="/assets/orbit.svg" alt="연결 검증용 궤도 이미지" width="180" height="180">
    <h1>로컬 연결 검증</h1>
    <p>로컬 서비스의 화면과 이미지가 브라우저에 도착했습니다.</p>
    <span class="status">Stage 0 · HTTP / iframe / image</span>
  </main>
</body>
</html>`;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(body);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'origin');
  response.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network');

  const origin = request.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    sendError(response, 403, 'origin_not_allowed', 'This origin is not permitted for the stage 0 probe.');
    return;
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
  }
  // A permitted parent can embed the probe under vyvyd's existing COEP policy.
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  if (request.method === 'OPTIONS') {
    if (!origin) {
      sendError(response, 400, 'origin_required', 'A preflight request must include an allowed Origin.');
      return;
    }
    const requestedMethod = request.headers['access-control-request-method'];
    if (requestedMethod && !['GET', 'HEAD'].includes(requestedMethod)) {
      sendError(response, 405, 'method_not_allowed', 'The probe only accepts GET and HEAD.');
      return;
    }
    const requestedHeaders = request.headers['access-control-request-headers'];
    if (requestedHeaders && requestedHeaders.split(',').some((header) => header.trim().toLowerCase() !== 'content-type')) {
      sendError(response, 400, 'headers_not_allowed', 'The probe does not accept custom request headers.');
      return;
    }
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.headers['access-control-request-private-network'] === 'true') {
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD, OPTIONS');
    sendError(response, 405, 'method_not_allowed', 'The probe only accepts GET and HEAD.');
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, serverOrigin).pathname;
  } catch {
    sendError(response, 400, 'invalid_url', 'The request URL is invalid.');
    return;
  }

  try {
    if (pathname === '/health') {
      sendJson(response, 200, { stage: 0, status: 'ok', protocolVersion: 1 });
      return;
    }
    if (pathname === '/preview') {
      response.setHeader('Content-Security-Policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self' ${[...allowedOrigins].join(' ')}; base-uri 'none'; object-src 'none'`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : preview);
      return;
    }
    if (pathname === '/assets/orbit.svg') {
      const asset = await readFile(path.join(repoRoot, 'public', 'studio-proof', 'orbit.svg'));
      response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : asset);
      return;
    }
    sendError(response, 404, 'not_found', 'This path is not part of the stage 0 probe.');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendError(response, 503, 'asset_not_ready', 'The stage 0 image asset is not ready yet.');
    } else {
      console.error('Stage 0 probe request failed:', error.message);
      sendError(response, 500, 'probe_failed', 'The local probe could not complete this request.');
    }
  }
});

server.on('error', (error) => {
  console.error(`Stage 0 probe failed to start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Stage 0 connectivity probe: ${serverOrigin}`);
  console.log('Allowed browser origins:', [...allowedOrigins].join(', '));
  console.log('Browser local-network permission may still be required; CORS/PNA headers do not grant it.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
