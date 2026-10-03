import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';
import {MAX_ASSET_BYTES} from '../packages/studio-companion/src/project-store.mjs';

const origin = 'http://127.0.0.1:5173';
const composition = {width: 640, height: 480, fps: 30, durationInFrames: 90};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
const start = async (dataDir, allowedOrigins = []) => {
  const server = createStudioServer({dataDir, allowedOrigins});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {server, url: `http://127.0.0.1:${server.address().port}`};
};
const close = (server) => new Promise((resolve, reject) => {
  server.close((cause) => cause ? reject(cause) : resolve());
  server.closeIdleConnections();
});
const fixture = async (t, allowedOrigins) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-server-test-'));
  const service = await start(directory, allowedOrigins);
  t.after(async () => {if (service.server.listening) await close(service.server); await rm(directory, {recursive: true, force: true});});
  return {...service, directory};
};
const jsonRequest = (url, method, body, extraHeaders = {}) => fetch(url, {method, headers: {'Content-Type': 'application/json', Origin: origin, ...extraHeaders}, body: JSON.stringify(body)});
const create = async (url) => {
  const response = await jsonRequest(`${url}/projects`, 'POST', {name: 'HTTP 홍보물', composition});
  assert.equal(response.status, 201);
  return response.json();
};
const upload = (url, project, name = '로고.png') => fetch(`${url}/projects/${project.id}/assets`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent(name), 'X-Expected-Revision': String(project.revision)}, body: png});

test('HTTP create, upload, save and actual server restart restore document and image bytes', async (t) => {
  const {server, url, directory} = await fixture(t);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), {service: 'vyvyd-studio', protocolVersion: 2, status: 'ok'});
  const created = await create(url);
  const firstResponse = await upload(url, created);
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  const secondResponse = await upload(url, first);
  const second = await secondResponse.json();
  assert.equal(second.assets.length, 2);
  assert.notEqual(second.assets[0].relativePath, second.assets[1].relativePath);
  const edited = {...second, name: '다시 열 홍보물', composition: {...second.composition, width: 1080}, edits: {...second.edits, backgroundColor: '#ff00aa'}};
  const savedResponse = await jsonRequest(`${url}/projects/${created.id}`, 'PUT', {expectedRevision: second.revision, project: edited});
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  await close(server);
  const restarted = await start(directory);
  t.after(() => close(restarted.server));
  assert.deepEqual(await (await fetch(`${restarted.url}/projects/${created.id}`)).json(), saved);
  const imageResponse = await fetch(`${restarted.url}/projects/${created.id}/assets/${saved.assets[0].id}`, {headers: {Origin: origin}});
  assert.equal(imageResponse.headers.get('Content-Type'), 'image/png');
  assert.equal(imageResponse.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(imageResponse.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  const summaries = await (await fetch(`${restarted.url}/projects`)).json();
  assert.deepEqual(summaries, [{id: saved.id, name: saved.name, revision: saved.revision, updatedAt: saved.updatedAt, composition: saved.composition, assetCount: 2}]);
});

test('exact allowed Origin and custom upload headers work; foreign and no-Origin browser writes fail', async (t) => {
  const {url} = await fixture(t, ['https://studio.example.test']);
  for (const allowed of [origin, 'http://localhost:5173', 'https://vyvyd.pages.dev', 'https://studio.example.test']) {
    const response = await fetch(`${url}/health`, {headers: {Origin: allowed}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowed);
  }
  for (const denied of ['https://evil.example', 'http://127.0.0.1:51730', 'null', 'https://vyvyd.pages.dev.evil.example']) {
    const response = await fetch(`${url}/health`, {headers: {Origin: denied}});
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ORIGIN_NOT_ALLOWED');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const preflight = await fetch(`${url}/projects`, {method: 'OPTIONS', headers: {Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type,X-File-Name,X-Expected-Revision', 'Access-Control-Request-Private-Network': 'true'}});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Expected-Revision/);
  assert.equal(preflight.headers.get('Access-Control-Allow-Private-Network'), 'true');
  const browserWrite = await jsonRequest(`${url}/projects`, 'POST', {name: 'blocked', composition}, {Origin: '', 'Sec-Fetch-Site': 'same-origin'});
  assert.equal(browserWrite.status, 403);
  const noOriginBrowser = await fetch(`${url}/projects`, {method: 'POST', headers: {'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin'}, body: JSON.stringify({name: 'blocked', composition})});
  assert.equal(noOriginBrowser.status, 403);
  assert.equal((await noOriginBrowser.json()).error.code, 'ORIGIN_REQUIRED');
  const cli = await fetch(`${url}/projects`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'CLI allowed', composition})});
  assert.equal(cli.status, 201);
});

test('stale HTTP writes, malformed requests and unregistered asset IDs are rejected', async (t) => {
  const {url} = await fixture(t);
  const initial = await create(url);
  const saved = await jsonRequest(`${url}/projects/${initial.id}`, 'PUT', {expectedRevision: 1, project: {...initial, name: 'saved'}});
  assert.equal(saved.status, 200);
  const stale = await jsonRequest(`${url}/projects/${initial.id}`, 'PUT', {expectedRevision: 1, project: initial});
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
  const unknown = await fetch(`${url}/projects/${initial.id}/assets/${randomUUID()}`);
  assert.equal(unknown.status, 404);
  const invalidId = await fetch(`${url}/projects/not-a-project`);
  assert.equal(invalidId.status, 400);
  const badJson = await fetch(`${url}/projects`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{broken'});
  assert.equal((await badJson.json()).error.code, 'INVALID_JSON');
  const form = await fetch(`${url}/projects`, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'name=unsupported'});
  assert.equal(form.status, 415);
  const malformedUpload = await fetch(`${url}/projects/${initial.id}/assets`, {method: 'POST', headers: {'Content-Type': 'image/png', 'X-File-Name': '%ZZ', 'X-Expected-Revision': '2'}, body: png});
  assert.equal(malformedUpload.status, 400);
  const forgedSource = {...await saved.json(), source: {...initial.source, files: {...initial.source.files, 'src/../../../escape.tsx': 'escape'}}};
  const escape = await jsonRequest(`${url}/projects/${initial.id}`, 'PUT', {expectedRevision: 2, project: forgedSource});
  assert.equal(escape.status, 400);
});

test('encoded traversal and image signature/MIME/size mismatches are rejected without changing revision', async (t) => {
  const {url} = await fixture(t);
  const initial = await create(url);
  const rawPath = await new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/projects/%2e%2e%2fescape`, (response) => {response.resume(); response.on('end', () => resolve(response.statusCode));});
    request.on('error', reject);
    request.end();
  });
  assert.equal(rawPath, 400);
  const invalid = await fetch(`${url}/projects/${initial.id}/assets`, {method: 'POST', headers: {'Content-Type': 'image/png', 'X-File-Name': 'fake.png', 'X-Expected-Revision': '1'}, body: Buffer.from('<svg/>')});
  assert.equal((await invalid.json()).error.code, 'INVALID_IMAGE');
  const mismatched = await fetch(`${url}/projects/${initial.id}/assets`, {method: 'POST', headers: {'Content-Type': 'image/jpeg', 'X-File-Name': 'fake.jpg', 'X-Expected-Revision': '1'}, body: png});
  assert.equal(mismatched.status, 415);
  const tooLarge = await fetch(`${url}/projects/${initial.id}/assets`, {method: 'POST', headers: {'Content-Type': 'image/png', 'X-File-Name': 'huge.png', 'X-Expected-Revision': '1'}, body: Buffer.alloc(MAX_ASSET_BYTES + 1)});
  assert.equal(tooLarge.status, 413);
  assert.equal((await (await fetch(`${url}/projects/${initial.id}`)).json()).revision, 1);
});
