import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';
import {createPreviewRuntime} from '../packages/studio-companion/src/preview-runtime.mjs';

const composition = {width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const post = (body) => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

test('deleting a project removes its export snapshots and invalidates only its in-memory output records', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-associated-'));
  const purged = [];
  const runtime = {async prepare(project) {const previewId = randomUUID(); return {previewId, projectId: project.id, revision: project.revision, previewUrl: `http://127.0.0.1:4180/previews/${previewId}/player.html`};},
    async getExportSnapshot() {return {};}, async handle() {return false;}, async purgeProject(id) {purged.push(id);}};
  const server = createStudioServer({dataDir: path.join(root, 'projects'), exportDataDir: path.join(root, 'exports'), previewRuntime: runtime,
    exportRenderer: (args) => ({promise: writeFile(args.output, png), cancel() {}})});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await server.studio.exports.shutdown(); await server.studio.controller.settled(); await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root, {recursive: true, force: true});});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const one = await (await fetch(`${origin}/projects`, post({name: 'first', composition}))).json();
  const two = await (await fetch(`${origin}/projects`, post({name: 'second', composition}))).json();
  const makeJob = async (project) => {
    const args = {expectedRevision: project.revision, requestId: randomUUID(), options: {format: 'png', width: 320, height: 400, frame: 0}};
    const response = await fetch(`${origin}/projects/${project.id}/exports`, post(args)); assert.equal(response.status, 202); return response.json();
  };
  const first = await makeJob(one); await server.studio.exports.settled();
  const second = await makeJob(two); await server.studio.exports.settled();
  const deleted = await fetch(`${origin}/projects/${one.id}`, {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({expectedRevision: one.revision})});
  assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), {projectId: one.id, deleted: true});
  assert.deepEqual(purged, [one.id]);
  await assert.rejects(readFile(path.join(root, 'exports', first.id, 'job.json')), {code: 'ENOENT'});
  assert.ok(await readFile(path.join(root, 'exports', second.id, 'job.json')));
  assert.equal((await fetch(`${origin}/projects/${one.id}/exports/${first.id}`)).status, 404);
  assert.equal((await fetch(`${origin}/projects/${two.id}/exports/${second.id}`)).status, 200);
});

test('preview cleanup removes only matching verified snapshots and invalidates the cached player', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-preview-cleanup-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runtime = createPreviewRuntime({dataDir: root});
  const target = randomUUID(), other = randomUUID(), one = randomUUID(), two = randomUUID(), corrupt = randomUUID();
  const add = async (id, projectId, broken = false) => {
    const dir = path.join(root, id); await mkdir(dir); const data = {previewId: id, projectId, state: 'ready'};
    await writeFile(path.join(dir, 'preview.json'), JSON.stringify(data));
    await writeFile(path.join(dir, 'snapshot.json'), broken ? '{' : JSON.stringify(data));
    await writeFile(path.join(dir, 'player.html'), 'test');
  };
  await add(one, target); await add(two, other); await add(corrupt, target, true);
  // Populate runtime's version map through the public read-only handler.
  const response = {setHeader() {}, writeHead(code) {this.status = code;}, end() {}};
  assert.equal(await runtime.handle({url:`/previews/${one}/player.html`,method:'GET'}, response), true); assert.equal(response.status, 200);
  await assert.rejects(runtime.purgeProject(target), /정리/);
  assert.ok(!(await readdir(root)).includes(one)); assert.ok((await readdir(root)).includes(two)); assert.ok((await readdir(root)).includes(corrupt));
  const after = {setHeader() {}, writeHead(code) {this.status = code;}, end() {}};
  await runtime.handle({url:`/previews/${one}/player.html`,method:'GET'}, after); assert.equal(after.status, 404);
});

test('failed associated cleanup retains durable intent and retries before removing the tombstone', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-cleanup-retry-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = createProjectStore({dataDir: root, cleanupDeletedProject: async () => {throw new Error('locked');}});
  const project = await store.createProject({name:'retry', composition});
  assert.deepEqual(await store.deleteProject(project.id, {expectedRevision:1}), {projectId:project.id,deleted:true,cleanupPending:true});
  assert.ok((await readdir(root)).some((name) => name.startsWith(`.deleted-${project.id}-`)));
  // Other standalone readers (including preview workers) cannot discard the
  // tombstone without being able to clean outputs and previews.
  assert.deepEqual(await createProjectStore({dataDir:root}).listProjects(), []);
  assert.ok((await readdir(root)).some((name) => name.startsWith(`.deleted-${project.id}-`)));
  const seen = [];
  const restarted = createProjectStore({dataDir: root, cleanupDeletedProject: async (id) => {seen.push(id);}});
  assert.deepEqual(await restarted.listProjects(), []); assert.deepEqual(seen, [project.id]);
  assert.ok(!(await readdir(root)).some((name) => name.startsWith(`.deleted-${project.id}-`)));
});

test('an unavailable preview cleanup never reports complete deletion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-no-cleanup-'));
  const server = createStudioServer({dataDir:path.join(root,'projects'), exportDataDir:path.join(root,'exports'), previewRuntime:{async handle() {return false;}}});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await server.studio.exports.shutdown(); await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await (await fetch(`${base}/projects`,post({name:'no preview cleanup',composition}))).json();
  await server.studio.exports.settled();
  const response = await fetch(`${base}/projects/${project.id}`, {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:project.revision})});
  assert.deepEqual(await response.json(), {projectId:project.id,deleted:true,cleanupPending:true});
  assert.ok((await readdir(path.join(root,'projects'))).some((name) => name.startsWith(`.deleted-${project.id}-`)));
});

test('server restart retries a partial deletion before admitting project requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-server-retry-'));
  let fail = true, calls = 0;
  const runtime = {async handle() {return false;}, async purgeProject() {calls++; if (fail) throw new Error('locked');}};
  const create = () => createStudioServer({dataDir:path.join(root,'projects'), exportDataDir:path.join(root,'exports'), previewRuntime:runtime});
  let server = create();
  const close = async () => {await server.studio.exports.shutdown(); await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);});};
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await close(); await rm(root,{recursive:true,force:true});});
  let base = `http://127.0.0.1:${server.address().port}`;
  const project = await (await fetch(`${base}/projects`,post({name:'server retry',composition}))).json();
  await server.studio.exports.settled();
  const response = await fetch(`${base}/projects/${project.id}`, {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:project.revision})});
  assert.equal((await response.json()).cleanupPending, true);
  await close(); fail = false; server = create();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/projects`)).json(), []);
  assert.equal(calls, 2);
  assert.ok(!(await readdir(path.join(root,'projects'))).some((name) => name.startsWith(`.deleted-${project.id}-`)));
});

test('recovery preserves a tombstone if that project ID is present again', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-cleanup-collision-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const store = createProjectStore({dataDir:root, cleanupDeletedProject:async () => {throw new Error('locked');}});
  const project = await store.createProject({name:'collision',composition});
  await store.deleteProject(project.id,{expectedRevision:1});
  await mkdir(path.join(root,project.id));
  await writeFile(path.join(root,project.id,'sentinel'), 'preserve');
  const seen = [];
  const restarted = createProjectStore({dataDir:root, cleanupDeletedProject:async (id) => {seen.push(id);}});
  await restarted.recoverPendingDeletions();
  assert.deepEqual(seen, []);
  assert.equal(await readFile(path.join(root,project.id,'sentinel'),'utf8'), 'preserve');
  assert.ok((await readdir(root)).some((name) => name.startsWith(`.deleted-${project.id}-`)));
});

test('explicitly keeping associated files preserves exports and preview artifacts through project deletion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-preserve-associated-'));
  const calls = [];
  const runtime = {async prepare(project) {const previewId = randomUUID(); return {previewId, projectId: project.id, revision: project.revision, previewUrl: `http://127.0.0.1:4180/previews/${previewId}/player.html`};},
    async getExportSnapshot() {return {};}, async handle() {return false;}, async purgeProject(id) {calls.push(id);}};
  const server = createStudioServer({dataDir: path.join(root, 'projects'), exportDataDir: path.join(root, 'exports'), previewRuntime: runtime,
    exportRenderer: (args) => ({promise: writeFile(args.output, png), cancel() {}})});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await server.studio.exports.shutdown(); await server.studio.controller.settled(); await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root, {recursive: true, force: true});});
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await (await fetch(`${base}/projects`, post({name: 'preserve', composition}))).json();
  const preview = path.join(root, 'preview-sentinel'); await writeFile(preview, 'preserved');
  const job = await (await fetch(`${base}/projects/${project.id}/exports`, post({expectedRevision: 1, requestId: randomUUID(), options: {format: 'png', width: 320, height: 400, frame: 0}}))).json();
  await server.studio.exports.settled();
  for (const option of [undefined, null, 'false', 0]) {
    const response = await fetch(`${base}/projects/${project.id}/delete`, post({expectedRevision: 1, ...(option === undefined ? {} : {deleteAssociatedFiles: option})}));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_DELETE_OPTIONS');
    assert.equal((await server.studio.store.readProject(project.id)).id, project.id);
  }
  const response = await fetch(`${base}/projects/${project.id}/delete`, post({expectedRevision: 1, deleteAssociatedFiles: false}));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {projectId: project.id, deleted: true});
  assert.deepEqual(calls, []);
  assert.equal(await readFile(preview, 'utf8'), 'preserved');
  assert.ok(await readFile(path.join(root, 'exports', job.id, 'job.json')));
  await assert.rejects(server.studio.store.readProject(project.id), {code: 'PROJECT_NOT_FOUND'});
});

test('a preserve-choice tombstone retries project-folder cleanup without purging associated files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-preserve-retry-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const seen = [];
  const store = createProjectStore({dataDir: root, cleanupDeletedProject: async (id) => {seen.push(id);},
    removeDeletedDirectory: async () => {throw new Error('locked');}});
  const project = await store.createProject({name:'preserve retry', composition});
  assert.deepEqual(await store.deleteProject(project.id, {expectedRevision: 1, deleteAssociatedFiles: false}), {projectId: project.id, deleted: true, cleanupPending: true});
  assert.deepEqual(seen, []);
  assert.ok((await readdir(root)).some((name) => name.startsWith(`.deleted-keep-${project.id}-`)));
  const restarted = createProjectStore({dataDir: root, cleanupDeletedProject: async (id) => {seen.push(id);}});
  await restarted.recoverPendingDeletions();
  assert.deepEqual(seen, []);
  assert.ok(!(await readdir(root)).some((name) => name.startsWith(`.deleted-keep-${project.id}-`)));
});

test('new explicit-delete route cleans associated files when requested and rejects invalid methods', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-explicit-delete-'));
  const purged = [];
  const runtime = {async handle() {return false;}, async purgeProject(id) {purged.push(id);}};
  const server = createStudioServer({dataDir: path.join(root, 'projects'), exportDataDir: path.join(root, 'exports'), previewRuntime: runtime});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await server.studio.exports.shutdown(); await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root, {recursive: true, force: true});});
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await (await fetch(`${base}/projects`, post({name: 'clean', composition}))).json();
  await server.studio.exports.settled();
  assert.equal((await fetch(`${base}/projects/${project.id}/delete`)).status, 405);
  const response = await fetch(`${base}/projects/${project.id}/delete`, post({expectedRevision: 1, deleteAssociatedFiles: true}));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {projectId: project.id, deleted: true});
  assert.deepEqual(purged, [project.id]);
});
