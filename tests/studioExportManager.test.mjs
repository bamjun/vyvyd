import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createExportManager} from '../packages/studio-companion/src/export-manager.mjs';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';

const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const deferred = () => {let resolve; const promise = new Promise((done) => {resolve = done;}); return {promise, resolve};};
const argsFor = (project, options = {format: 'png', width: 320, height: 400, frame: 5}) => ({expectedRevision: project.revision, requestId: randomUUID(), options});
const fakeRuntime = (onPrepare) => {
  const snapshots = new Map();
  return {prepared: [], async prepare(project, {readAsset}) {
    const frozen = structuredClone(project);
    this.prepared.push({project: frozen, assets: await Promise.all(project.assets.map(async (asset) => Buffer.from(await readAsset(asset.id))))});
    await onPrepare?.(frozen);
    const previewId = randomUUID();
    snapshots.set(previewId, {serveUrl: 'http://127.0.0.1:4180/previews/frozen/render/', composition: project.composition,
      inputProps: {composition: project.composition, backgroundColor: project.edits.backgroundColor, layers: project.edits.layers}});
    return {previewId};
  }, async getExportSnapshot(id) {return snapshots.get(id);}};
};
const fakeRenderer = (onRender) => (args) => {
  let cancelled = false;
  const stop = deferred();
  const promise = (async () => {
    const outcome = onRender?.(args, stop.promise);
    if (outcome) await outcome;
    if (cancelled) throw new Error('cancelled');
    args.onProgress(1);
    await writeFile(args.output, png);
    return {size: png.length};
  })();
  return {promise, cancel: () => {cancelled = true; stop.resolve();}};
};
async function fixture(t, {onPrepare, onRender} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-export-'));
  const dataDir = path.join(root, 'exports');
  const store = createProjectStore({dataDir: path.join(root, 'projects')});
  const runtime = fakeRuntime(onPrepare);
  const manager = createExportManager({store, runtime, dataDir, runRender: fakeRenderer(onRender)});
  t.after(async () => {await manager.shutdown(); await rm(root, {recursive: true, force: true});});
  const project = await store.createProject({name: '고정 출력', composition});
  return {root, dataDir, store, runtime, manager, project};
}

test('render jobs freeze source, props and asset bytes while later project edits stay independent', async (t) => {
  const gate = deferred();
  const preparing = deferred();
  const {store, runtime, manager, project} = await fixture(t, {onPrepare: async () => {preparing.resolve(); await gate.promise;}});
  const withAsset = await store.uploadAsset(project.id, {expectedRevision: 1, name: 'image.png', mimeType: 'image/png', bytes: png});
  const job = await manager.start(project.id, argsFor(withAsset));
  await preparing.promise;
  const current = await store.updateProject(project.id, {expectedRevision: 2, project: {...withAsset, name: '렌더 중 변경',
    edits: {...withAsset.edits, backgroundColor: '#ff0000'}, source: {...withAsset.source,
      files: {...withAsset.source.files, 'src/change.ts': 'export const changed = true;'}}}});
  gate.resolve();
  await manager.settled();
  const finished = await manager.get(project.id, job.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.revision, 2);
  assert.equal(runtime.prepared[0].project.name, withAsset.name);
  assert.deepEqual(runtime.prepared[0].project.source, withAsset.source);
  assert.deepEqual(runtime.prepared[0].assets[0], png);
  assert.equal((await store.readProject(project.id)).revision, current.revision);
  assert.ok(!JSON.stringify(finished).includes('projectHash'));
  const result = await manager.readResult(project.id, job.id);
  assert.deepEqual(await readFile(result.path), png);
});

test('request replay is durable after newer saves and altered request intents are rejected', async (t) => {
  const {dataDir, store, runtime, manager, project} = await fixture(t);
  const args = argsFor(project);
  const first = await manager.start(project.id, args);
  const duplicate = await manager.start(project.id, args);
  assert.equal(first.id, duplicate.id);
  await manager.settled();
  await store.updateProject(project.id, {expectedRevision: 1, project: {...project, name: '새 버전'}});
  const restarted = createExportManager({store, runtime, dataDir, runRender: fakeRenderer()});
  t.after(() => restarted.shutdown());
  assert.equal((await restarted.start(project.id, args)).id, first.id);
  assert.equal((await restarted.list(project.id)).length, 1);
  await assert.rejects(restarted.start(project.id, {...args, options: {...args.options, frame: 6}}), {code: 'REQUEST_ID_REUSED'});
  assert.deepEqual(await readFile((await restarted.readResult(project.id, first.id)).path), png);
});

test('queued and running cancellation do not publish partial output or cancel another job', async (t) => {
  const rendering = deferred();
  let calls = 0;
  const {manager, project, dataDir} = await fixture(t, {onRender: async (args, stop) => {
    calls += 1;
    if (calls === 1) {await writeFile(args.output, png); rendering.resolve(); await stop;}
  }});
  const first = await manager.start(project.id, argsFor(project));
  await rendering.promise;
  const queued = await manager.start(project.id, argsFor(project));
  const next = await manager.start(project.id, argsFor(project));
  assert.equal((await manager.cancel(project.id, queued.id)).state, 'cancelled');
  assert.equal((await manager.cancel(project.id, first.id)).state, 'cancelled');
  await manager.settled();
  assert.equal((await manager.get(project.id, next.id)).state, 'completed');
  assert.equal(calls, 2);
  await assert.rejects(manager.readResult(project.id, first.id), {code: 'EXPORT_NOT_READY'});
  assert.ok(!(await readdir(path.join(dataDir, first.id))).includes('result.png'));
});

test('cancel during preparation stays cancelled and retries render the same source despite newer canonical versions', async (t) => {
  const gate = deferred();
  const preparing = deferred();
  let calls = 0;
  const {store, manager, runtime, project} = await fixture(t, {onPrepare: async () => {
    calls += 1; if (calls === 1) {preparing.resolve(); await gate.promise;}
  }});
  const job = await manager.start(project.id, argsFor(project));
  await preparing.promise;
  await manager.cancel(project.id, job.id);
  await store.updateProject(project.id, {expectedRevision: 1, project: {...project, name: '다른 현재 버전'}});
  gate.resolve(); await manager.settled();
  const requestId = randomUUID();
  const retry = await manager.retry(project.id, job.id, {requestId});
  assert.notEqual(retry.id, job.id);
  assert.equal((await manager.retry(project.id, job.id, {requestId})).id, retry.id);
  await manager.settled();
  assert.equal((await manager.get(project.id, retry.id)).state, 'completed');
  assert.deepEqual(runtime.prepared[1].project, project);
});

test('interrupted durable jobs become failed after restart and frozen snapshots can be retried', async (t) => {
  const gate = deferred(); const preparing = deferred();
  const {store, runtime, manager, project, dataDir} = await fixture(t, {onPrepare: async () => {preparing.resolve(); await gate.promise;}});
  const job = await manager.start(project.id, argsFor(project));
  await preparing.promise;
  const restarted = createExportManager({store, runtime: fakeRuntime(), dataDir, runRender: fakeRenderer()});
  t.after(() => restarted.shutdown());
  const recovered = await restarted.get(project.id, job.id);
  assert.equal(recovered.state, 'failed');
  assert.match(recovered.message, /중단/);
  // Close the original in-memory manager before allowing its old compile to finish.
  const shuttingDown = manager.shutdown(); gate.resolve(); await shuttingDown;
  const retry = await restarted.retry(project.id, job.id, {requestId: randomUUID()});
  await restarted.settled();
  assert.equal((await restarted.get(project.id, retry.id)).state, 'completed');
  assert.equal(runtime.prepared.length, 1);
});

test('failed render errors are safe and retries remain possible; tampered snapshots and result bytes are rejected', async (t) => {
  const {manager, store, runtime, project, dataDir} = await fixture(t, {onRender: () => {throw new Error('failed C:\\private\\source.tsx');}});
  const failed = await manager.start(project.id, argsFor(project)); await manager.settled();
  const state = await manager.get(project.id, failed.id);
  assert.equal(state.state, 'failed'); assert.ok(!state.message.includes('C:\\private'));
  await writeFile(path.join(dataDir, failed.id, 'project.json'), '{}');
  await assert.rejects(manager.retry(project.id, failed.id, {requestId: randomUUID()}), {code: 'EXPORT_SNAPSHOT_CHANGED'});
  const goodManager = createExportManager({store, runtime, dataDir, runRender: fakeRenderer()});
  t.after(() => goodManager.shutdown());
  const good = await goodManager.start(project.id, argsFor(project)); await goodManager.settled();
  await writeFile(path.join(dataDir, good.id, 'result.png'), Buffer.from('changed'));
  await assert.rejects(goodManager.readResult(project.id, good.id), {code: 'EXPORT_RESULT_CHANGED'});
});

test('revision checks, bounded queue, project scope and unsafe file paths reject unintended jobs', async (t) => {
  const gate = deferred(); const preparing = deferred();
  const {manager, store, project, dataDir} = await fixture(t, {onPrepare: async () => {preparing.resolve(); await gate.promise;}});
  await assert.rejects(manager.start(project.id, {...argsFor(project), expectedRevision: 2}), {code: 'REVISION_CONFLICT'});
  const job = await manager.start(project.id, argsFor(project)); await preparing.promise;
  const other = await store.createProject({name: '다른 프로젝트', composition});
  await assert.rejects(manager.cancel(other.id, job.id), {code: 'EXPORT_NOT_FOUND'});
  await assert.rejects(manager.get(project.id, '../outside'), {code: 'INVALID_ID'});
  for (let index = 1; index < 8; index += 1) await manager.start(project.id, argsFor(project));
  await assert.rejects(manager.start(project.id, argsFor(project)), {code: 'EXPORT_QUEUE_FULL'});
  gate.resolve(); await manager.settled();
  const result = path.join(dataDir, job.id, 'result.png');
  const outside = path.join(dataDir, 'outside.png');
  await writeFile(outside, png); await rm(result);
  try {await symlink(outside, result, 'file');} catch (cause) {
    if (cause.code === 'EPERM') return; throw cause;
  }
  await assert.rejects(manager.readResult(project.id, job.id), {code: 'UNSAFE_STORAGE_PATH'});
});
