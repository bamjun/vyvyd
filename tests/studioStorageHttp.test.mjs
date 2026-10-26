import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';
import {workspaceMetadata} from '../packages/studio-companion/src/storage-workspace.mjs';

const browserOrigin = 'http://127.0.0.1:5173';
const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const deferred = () => {let resolve; const promise = new Promise((done) => {resolve = done;}); return {promise, resolve};};
const headers = (storageId) => ({Origin: browserOrigin, 'Content-Type': 'application/json', ...(storageId ? {'X-Studio-Storage-Id': storageId} : {})});

async function fixture(t, {save, onPrepare, renderer, projectsLeaf = 'projects'} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-storage-http-'));
  const baseA = path.join(root, 'first');
  const baseB = path.join(root, 'second');
  const runtime = {
    async prepare(project) {await onPrepare?.(); return {previewId: randomUUID(), previewUrl: 'http://127.0.0.1:4180/previews/frozen/player.html', composition: project.composition};},
    async getExportSnapshot() {return {serveUrl: 'http://127.0.0.1:4180/previews/frozen/render/', composition, inputProps: {}};},
    async handle() {return false;},
  };
  const server = createStudioServer({dataDir: path.join(baseA, projectsLeaf), previewRuntime: runtime,
    ...(save ? {storageSettings: {persistent: true, save}} : {}),
    exportRenderer: renderer ?? ((args) => ({promise: writeFile(args.output, png).then(() => ({size: png.length})), cancel() {}}))});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await server.studio.exports.settled();
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await server.studio.controller.settled();
    await server.studio.exports.shutdown();
    await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);});
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^vyvyd-storage-http-/);
    await rm(root, {recursive: true, force: true});
  });
  const current = () => fetch(`${url}/storage`, {headers: {Origin: browserOrigin}}).then((response) => response.json());
  const change = (metadata, directory = baseB, extra = {}) => fetch(`${url}/storage`, {method: 'PUT', headers: {...headers(metadata.storageId), ...extra},
    body: JSON.stringify({baseDirectory: directory, expectedStorageId: metadata.storageId})});
  return {root, baseA, baseB, runtime, server, url, current, change};
}

test('workspace metadata and switching preserve same-ID projects and reject stale native and API requests', async (t) => {
  const savedSettings = [];
  const f = await fixture(t, {save: async (directory) => {savedSettings.push(directory);}});
  const first = await f.current();
  assert.equal(first.baseDirectory, f.baseA);
  assert.equal(first.projectsDirectory, path.join(f.baseA, 'projects'));
  assert.equal(first.previewsDirectory, path.join(f.baseA, 'previews'));
  assert.equal(first.exportsDirectory, path.join(f.baseA, 'exports'));
  assert.equal(first.persistent, true);
  assert.match(first.workspaceKey, /^[a-f0-9]{64}$/);
  const original = await f.server.studio.store.createProject({name: '원래 포스터', composition});
  await mkdir(path.join(f.baseB, 'projects'), {recursive: true});
  await cp(path.join(f.baseA, 'projects', original.id), path.join(f.baseB, 'projects', original.id), {recursive: true});
  const otherStore = createProjectStore({dataDir: path.join(f.baseB, 'projects')});
  const secondProject = await otherStore.updateProject(original.id, {expectedRevision: 1, project: {...original, name: '다른 폴더 포스터'}});
  const firstProject = await f.server.studio.store.updateProject(original.id, {expectedRevision: 1, project: {...original, name: '기존 폴더 포스터'}});
  assert.equal(firstProject.revision, secondProject.revision);
  const oldStore = f.server.studio.store;
  const response = await f.change(first);
  assert.equal(response.status, 200);
  const second = await response.json();
  assert.notEqual(second.storageId, first.storageId);
  assert.notEqual(second.workspaceKey, first.workspaceKey);
  assert.deepEqual(savedSettings, [f.baseB]);
  assert.equal(response.headers.get('X-Studio-Storage-Id'), second.storageId);
  const staleRead = await fetch(`${f.url}/projects/${original.id}`, {headers: headers(first.storageId)});
  assert.equal(staleRead.status, 409);
  assert.equal((await staleRead.json()).error.code, 'STORAGE_CHANGED');
  const staleWrite = await fetch(`${f.url}/projects/${original.id}`, {method: 'PUT', headers: headers(first.storageId),
    body: JSON.stringify({expectedRevision: firstProject.revision, project: {...firstProject, name: '오래된 탭'}})});
  assert.equal(staleWrite.status, 409);
  const unscopedWrite = await fetch(`${f.url}/projects`, {method: 'POST', headers: headers(), body: JSON.stringify({name: '오래된 앱', composition})});
  assert.equal(unscopedWrite.status, 409);
  const staleNative = await fetch(`${f.url}/projects/${original.id}/bundle/2?storageId=${first.storageId}`);
  assert.equal(staleNative.status, 409);
  const conflictedScope = await fetch(`${f.url}/projects/${original.id}?storageId=${first.storageId}`, {headers: headers(second.storageId)});
  assert.equal(conflictedScope.status, 409);
  assert.equal((await (await fetch(`${f.url}/projects/${original.id}`, {headers: headers(second.storageId)})).json()).name, secondProject.name);
  assert.deepEqual(await oldStore.readProject(original.id), firstProject);
  const backResponse = await f.change(second, f.baseA);
  const back = await backResponse.json();
  assert.equal(back.workspaceKey, first.workspaceKey);
  assert.notEqual(back.storageId, first.storageId);
  assert.deepEqual(await f.server.studio.store.readProject(original.id), firstProject);
});

test('folder selection validates paths, preserves active workspace on save failure, and retains origin protection', async (t) => {
  const f = await fixture(t, {save: async () => {throw new Error('disk unavailable');}});
  const first = await f.current();
  assert.equal((await f.change(first, '../relative')).status, 400);
  const file = path.join(f.root, 'ordinary-file');
  await writeFile(file, 'keep');
  assert.equal((await f.change(first, file)).status, 400);
  const denied = await f.change(first, f.baseB, {Origin: 'https://evil.example'});
  assert.equal(denied.status, 403);
  const stale = await f.change({...first, storageId: randomUUID()});
  assert.equal(stale.status, 409);
  const failure = await f.change(first);
  assert.equal(failure.status, 500);
  assert.equal((await failure.json()).error.code, 'STORAGE_SETTINGS_FAILED');
  assert.deepEqual(await f.current(), first);
  assert.equal(await readFile(file, 'utf8'), 'keep');
  const preflight = await fetch(`${f.url}/storage`, {method: 'OPTIONS', headers: {Origin: browserOrigin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'X-Studio-Storage-Id'}});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Studio-Storage-Id/);
});

test('saving the current folder persists the preference without replacing its storage epoch', async (t) => {
  const saved = [];
  const f = await fixture(t, {save: async (directory) => {saved.push(directory);}});
  const first = await f.current();
  const response = await f.change(first, f.baseA);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), first);
  assert.deepEqual(saved, [f.baseA]);
});

test('applying a legacy custom project leaf parent cannot silently select an empty sibling store', async (t) => {
  const saved = [];
  const f = await fixture(t, {projectsLeaf: 'my-projects', save: async (directory) => {saved.push(directory);}});
  const first = await f.current();
  const oldStore = f.server.studio.store;
  const project = await oldStore.createProject({name: '사용자 지정 저장소', composition});
  assert.equal(first.projectsDirectory, path.join(f.baseA, 'my-projects'));
  const rejected = await f.change(first, f.baseA);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, 'STORAGE_LEGACY_LAYOUT');
  assert.deepEqual(await f.current(), first);
  assert.deepEqual(saved, []);
  await assert.rejects(lstat(path.join(f.baseA, 'projects')), {code: 'ENOENT'});
  assert.deepEqual(await oldStore.readProject(project.id), project);
  const selected = await f.change(first, f.baseB);
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).projectsDirectory, path.join(f.baseB, 'projects'));
  assert.deepEqual(saved, [f.baseB]);
  assert.deepEqual(await oldStore.readProject(project.id), project);
});

test('workspace identity is stable before a projects folder is created under a junction ancestor', async (t) => {
  const f = await fixture(t);
  const actual = path.join(f.root, 'actual-parent');
  const alias = path.join(f.root, 'alias-parent');
  await mkdir(actual);
  try {await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');} catch (cause) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(cause.code)) {t.skip('Directory links are not available in this environment.'); return;}
    throw cause;
  }
  const selected = path.join(alias, 'new-workspace', 'projects');
  const before = workspaceMetadata(selected).workspaceKey;
  await mkdir(selected, {recursive: true});
  assert.equal(workspaceMetadata(selected).workspaceKey, before);
  assert.equal(workspaceMetadata(path.join(actual, 'new-workspace', 'projects')).workspaceKey, before);
});

test('folder switch refuses asynchronous compilation until its snapshot is ready', async (t) => {
  const preparing = deferred();
  const release = deferred();
  const f = await fixture(t, {onPrepare: async () => {preparing.resolve(); await release.promise;}});
  const first = await f.current();
  const project = await f.server.studio.store.createProject({name: '컴파일 중', composition});
  const compilation = await fetch(`${f.url}/projects/${project.id}/compile`, {method: 'POST', headers: headers(first.storageId), body: JSON.stringify({expectedRevision: 1})});
  assert.equal(compilation.status, 202);
  await preparing.promise;
  const blocked = await f.change(first);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'STORAGE_BUSY');
  release.resolve();
  await f.server.studio.controller.settled();
  assert.equal((await f.change(first)).status, 200);
});

test('an in-flight scoped GET finishes in its original folder across a workspace switch', async (t) => {
  const f = await fixture(t);
  const first = await f.current();
  const project = await f.server.studio.store.createProject({name: '읽고 있는 기존 폴더', composition});
  const enteredRead = deferred();
  const releaseRead = deferred();
  const originalRead = f.server.studio.store.readProject;
  f.server.studio.store.readProject = async (...args) => {enteredRead.resolve(); await releaseRead.promise; return originalRead(...args);};
  const reading = fetch(`${f.url}/projects/${project.id}`, {headers: headers(first.storageId)});
  await enteredRead.promise;
  try {assert.equal((await f.change(first)).status, 200);} finally {releaseRead.resolve();}
  const response = await reading;
  assert.equal(response.headers.get('X-Studio-Storage-Id'), first.storageId);
  assert.equal((await response.json()).name, project.name);
  assert.equal((await f.current()).baseDirectory, f.baseB);
  assert.deepEqual(await f.server.studio.store.listProjects(), []);
});

test('an in-flight POST still blocks folder switching until its write completes', async (t) => {
  const f = await fixture(t);
  const first = await f.current();
  const enteredWrite = deferred();
  const releaseWrite = deferred();
  const originalStore = f.server.studio.store;
  const createProject = originalStore.createProject;
  originalStore.createProject = async (...args) => {enteredWrite.resolve(); await releaseWrite.promise; return createProject(...args);};
  const writing = fetch(`${f.url}/projects`, {method: 'POST', headers: headers(first.storageId), body: JSON.stringify({name: '저장 중인 프로젝트', composition})});
  await enteredWrite.promise;
  try {
    const blocked = await f.change(first);
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, 'STORAGE_BUSY');
  } finally {releaseWrite.resolve();}
  const response = await writing;
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal((await f.change(first)).status, 200);
  assert.equal((await originalStore.readProject(saved.id)).name, saved.name);
  assert.deepEqual(await f.server.studio.store.listProjects(), []);
});

test('active export blocks workspace switch and completed output stays in the original folder', async (t) => {
  const rendering = deferred();
  const release = deferred();
  const f = await fixture(t, {renderer: (args) => ({promise: (async () => {rendering.resolve(); await release.promise; await writeFile(args.output, png); return {size: png.length};})(), cancel() {release.resolve();}})});
  const first = await f.current();
  const project = await f.server.studio.store.createProject({name: '출력 보관', composition});
  const response = await fetch(`${f.url}/projects/${project.id}/exports`, {method: 'POST', headers: headers(first.storageId),
    body: JSON.stringify({expectedRevision: 1, requestId: randomUUID(), options: {format: 'png', width: 320, height: 400, frame: 0}})});
  assert.equal(response.status, 202);
  const job = await response.json();
  await rendering.promise;
  const blocked = await f.change(first);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'STORAGE_BUSY');
  release.resolve();
  await f.server.studio.exports.settled();
  const enteredDownload = deferred();
  const releaseDownload = deferred();
  const oldExports = f.server.studio.exports;
  const readResult = oldExports.readResult;
  oldExports.readResult = async (...args) => {const result = await readResult(...args); enteredDownload.resolve(); await releaseDownload.promise; return result;};
  const downloading = fetch(`${f.url}/projects/${project.id}/exports/${job.id}/file?storageId=${first.storageId}`);
  await enteredDownload.promise;
  try {assert.equal((await f.change(first)).status, 200);} finally {releaseDownload.resolve();}
  const downloaded = await downloading;
  assert.equal(downloaded.headers.get('X-Studio-Storage-Id'), first.storageId);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  assert.deepEqual(await readFile(path.join(f.baseA, 'exports', job.id, 'result.png')), png);
});

test('MCP re-read moves scope, while connection heartbeats cannot authorize stale writes', async (t) => {
  const f = await fixture(t);
  const project = await f.server.studio.store.createProject({name: 'MCP 기존', composition});
  await mkdir(path.join(f.baseB, 'projects'), {recursive: true});
  await cp(path.join(f.baseA, 'projects', project.id), path.join(f.baseB, 'projects', project.id), {recursive: true});
  const client = new Client({name: 'workspace-mcp-test', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.resolve('packages/studio-companion/src/mcp-server.mjs')], env: {STUDIO_SERVICE_URL: f.url}, stderr: 'pipe'});
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.callTool({name: 'studio_read_project', arguments: {projectId: project.id}})).isError, undefined);
  const first = await f.current();
  assert.equal((await f.change(first)).status, 200);
  await fetch(`${f.url}/codex/connect`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-MCP-Client': 'workspace-mcp-test'}, body: '{}'});
  const args = {projectId: project.id, expectedRevision: 1, requestId: randomUUID(), backgroundColor: '#112233'};
  const stale = await client.callTool({name: 'studio_update_edits', arguments: args});
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STORAGE_CHANGED/);
  assert.equal((await client.callTool({name: 'studio_list_projects', arguments: {}})).isError, undefined);
  const refreshed = await client.callTool({name: 'studio_get_status', arguments: {projectId: project.id}});
  assert.equal(refreshed.isError, undefined);
  assert.equal(JSON.parse(refreshed.content[0].text).revision, 1);
  assert.equal((await f.server.studio.store.readProject(project.id)).revision, 1);
});
