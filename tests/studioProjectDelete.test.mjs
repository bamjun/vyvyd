import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';

const composition = {width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const deferred = () => {let resolve; const promise = new Promise((done) => {resolve = done;}); return {promise, resolve};};

test('delete removes one project and its source, image and history only with the current revision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = createProjectStore({dataDir: root, cleanupDeletedProject: async () => {}});
  const project = await store.createProject({name: '삭제 대상', composition});
  const other = await store.createProject({name: '다른 프로젝트', composition});
  const uploaded = await store.uploadAsset(project.id, {expectedRevision: 1, name: 'image.png', mimeType: 'image/png', bytes: png});
  await assert.rejects(store.deleteProject(project.id, {expectedRevision: 1}), {code: 'REVISION_CONFLICT'});
  assert.equal((await store.readProject(project.id)).revision, 2);
  assert.deepEqual(await store.deleteProject(project.id, {expectedRevision: uploaded.revision}), {projectId: project.id, deleted: true});
  await assert.rejects(store.readProject(project.id), {code: 'PROJECT_NOT_FOUND'});
  await assert.rejects(store.readHistory(project.id, 1), {code: 'PROJECT_NOT_FOUND'});
  await assert.rejects(store.readAsset(project.id, uploaded.assets[0].id), {code: 'PROJECT_NOT_FOUND'});
  await assert.rejects(store.deleteProject(project.id, {expectedRevision: 2}), {code: 'PROJECT_NOT_FOUND'});
  assert.deepEqual((await store.listProjects()).map((item) => item.id), [other.id]);
  assert.equal((await store.readProject(other.id)).name, '다른 프로젝트');
  await assert.rejects(store.deleteProject('../other', {expectedRevision: 1}), {code: 'INVALID_ID'});
});

test('serialized delete never removes a concurrent newer save or resurrects a deleted project', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-race-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = createProjectStore({dataDir: root, cleanupDeletedProject: async () => {}});
  const first = await store.createProject({name: 'first', composition});
  const save = store.updateProject(first.id, {expectedRevision: 1, project: {...first, name: 'newer'}});
  const staleDelete = store.deleteProject(first.id, {expectedRevision: 1});
  assert.equal((await save).revision, 2);
  await assert.rejects(staleDelete, {code: 'REVISION_CONFLICT'});
  assert.equal((await store.readProject(first.id)).name, 'newer');
  const second = await store.createProject({name: 'second', composition});
  const deleting = store.deleteProject(second.id, {expectedRevision: 1});
  const racingUpload = store.uploadAsset(second.id, {expectedRevision: 1, name: 'image.png', mimeType: 'image/png', bytes: png});
  await deleting;
  await assert.rejects(racingUpload, {code: 'PROJECT_NOT_FOUND'});
  await assert.rejects(store.readProject(second.id), {code: 'PROJECT_NOT_FOUND'});
});

test('partial cleanup leaves no damaged visible project and is retried on store restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-cleanup-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = createProjectStore({dataDir:root, cleanupDeletedProject: async () => {}, removeDeletedDirectory: async () => {throw new Error('locked');}});
  const project = await store.createProject({name:'locked files', composition});
  assert.deepEqual(await store.deleteProject(project.id, {expectedRevision:1}), {projectId:project.id,deleted:true,cleanupPending:true});
  assert.deepEqual(await store.listProjects(), []);
  const tombstone = (await readdir(root)).find((name) => name.startsWith(`.deleted-${project.id}-`));
  assert.ok(tombstone);
  assert.equal(JSON.parse(await readFile(path.join(root, tombstone, 'project.json'), 'utf8')).id, project.id);
  const restarted = createProjectStore({dataDir:root, cleanupDeletedProject: async () => {}});
  assert.deepEqual(await restarted.listProjects(), []);
  assert.ok(!(await readdir(root)).includes(tombstone));
});

test('delete refuses a project directory junction and never deletes through a nested junction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-path-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-outside-'));
  t.after(async () => {await rm(root, {recursive: true, force: true}); await rm(outside, {recursive: true, force: true});});
  const store = createProjectStore({dataDir: root, cleanupDeletedProject: async () => {}});
  const project = await store.createProject({name: 'safe', composition});
  const sentinel = path.join(outside, 'keep.txt');
  await writeFile(sentinel, 'keep');
  try {await symlink(outside, path.join(root, project.id, 'external'), process.platform === 'win32' ? 'junction' : 'dir');}
  catch (cause) {if (['EPERM', 'EACCES'].includes(cause.code)) return t.skip('Directory links unavailable'); throw cause;}
  await store.deleteProject(project.id, {expectedRevision: 1});
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  const second = await store.createProject({name: 'linked', composition});
  await rename(path.join(root, second.id), path.join(root, 'held'));
  await symlink(outside, path.join(root, second.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.deleteProject(second.id, {expectedRevision: 1}), {code: 'UNSAFE_STORAGE_PATH'});
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('HTTP delete enforces CORS, origin, storage scope, revision and active preview gates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-http-'));
  const entered = deferred(), release = deferred();
  const runtime = {async prepare(project) {entered.resolve(); await release.promise; const previewId = randomUUID();
    return {previewId, projectId: project.id, revision: project.revision, previewUrl: `http://127.0.0.1:4180/previews/${previewId}/player.html`};}, async handle() {return false;}, async purgeProject() {}};
  const server = createStudioServer({dataDir: path.join(root, 'projects'), exportDataDir: path.join(root, 'exports'), previewRuntime: runtime});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {release.resolve(); await server.studio.controller.settled(); await server.studio.exports.shutdown();
    await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root, {recursive: true, force: true});});
  const url = `http://127.0.0.1:${server.address().port}`, origin = 'http://127.0.0.1:5173';
  const make = (method, body, headers = {}) => ({method, headers: {'Content-Type':'application/json', Origin:origin, ...headers}, body:JSON.stringify(body)});
  const project = await (await fetch(`${url}/projects`, make('POST', {name:'delete', composition}))).json();
  await server.studio.exports.settled();
  const route = `${url}/projects/${project.id}`;
  const preflight = await fetch(route, {method:'OPTIONS', headers:{Origin:origin, 'Access-Control-Request-Method':'DELETE'}});
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  const forbidden = await fetch(route, {method:'DELETE', headers:{'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},body:'{"expectedRevision":1}'});
  assert.equal((await forbidden.json()).error.code, 'ORIGIN_REQUIRED');
  const foreign = await fetch(route, make('DELETE', {expectedRevision:1}, {Origin:'https://foreign.invalid'}));
  assert.equal((await foreign.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  const wrongScope = await fetch(route, make('DELETE', {expectedRevision:1}, {'X-Studio-Storage-Id':randomUUID()}));
  assert.equal((await wrongScope.json()).error.code, 'STORAGE_CHANGED');
  const stale = await fetch(route, make('DELETE', {expectedRevision:2}));
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
  await server.studio.controller.compile(project.id, 1);
  await entered.promise;
  const busy = await fetch(route, make('DELETE', {expectedRevision:1}));
  assert.equal((await busy.json()).error.code, 'PROJECT_BUSY');
  assert.equal((await server.studio.store.readProject(project.id)).id, project.id);
  release.resolve(); await server.studio.controller.settled();
  const response = await fetch(route, make('DELETE', {expectedRevision:1}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {projectId:project.id,deleted:true});
  assert.equal((await fetch(route)).status, 404);
});

test('HTTP deletion waits for read-only status snapshot recovery and clears its cached state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-restore-'));
  const entered = deferred(), release = deferred();
  const runtime = {async findSnapshot(project) {entered.resolve(); await release.promise;
    return {revision:project.revision, previewUrl:'http://127.0.0.1:4180/previews/recovered/player.html'};},
  async handle() {return false;}, async purgeProject() {}};
  const server = createStudioServer({dataDir:path.join(root,'projects'), exportDataDir:path.join(root,'exports'), previewRuntime:runtime});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {release.resolve(); await server.studio.exports.shutdown();
    await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root,{recursive:true,force:true});});
  const project = await server.studio.store.createProject({name:'status',composition});
  await server.studio.exports.settled();
  const pending = server.studio.controller.status(project.id);
  await entered.promise;
  const url = `http://127.0.0.1:${server.address().port}/projects/${project.id}`;
  const opts = {method:'DELETE', headers:{Origin:'http://127.0.0.1:5173','Content-Type':'application/json'},body:'{"expectedRevision":1}'};
  const busy = await fetch(url, opts);
  assert.equal((await busy.json()).error.code, 'PROJECT_BUSY');
  release.resolve(); await pending;
  const deleted = await fetch(url, opts);
  assert.equal(deleted.status, 200);
  await assert.rejects(server.studio.controller.status(project.id), {code:'PROJECT_NOT_FOUND'});
});

test('a deletion holds the write gate until complete, including writes to other projects', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-delete-gate-'));
  const entered = deferred(), release = deferred();
  const runtime = {async handle() {return false;}, async purgeProject() {}};
  const server = createStudioServer({dataDir:path.join(root,'projects'), exportDataDir:path.join(root,'exports'), previewRuntime:runtime});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {release.resolve(); await server.studio.exports.shutdown();
    await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root,{recursive:true,force:true});});
  const project = await server.studio.store.createProject({name:'first',composition});
  const other = await server.studio.store.createProject({name:'second',composition});
  await server.studio.exports.settled();
  const originalDelete = server.studio.store.deleteProject.bind(server.studio.store);
  server.studio.store.deleteProject = async (...args) => {entered.resolve(); await release.promise; return originalDelete(...args);};
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (method, body) => ({method, headers:{Origin:'http://127.0.0.1:5173','Content-Type':'application/json'},body:JSON.stringify(body)});
  const pending = fetch(`${base}/projects/${project.id}`,request('DELETE',{expectedRevision:1}));
  await entered.promise;
  const write = await fetch(`${base}/projects/${other.id}`,request('PUT',{expectedRevision:1,project:{...other,name:'blocked'}}));
  assert.equal((await write.json()).error.code, 'PROJECT_DELETE_BUSY');
  release.resolve(); assert.equal((await pending).status, 200);
  assert.equal((await server.studio.store.readProject(other.id)).name,'second');
});
