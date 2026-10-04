import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';
import {createStudioController} from '../packages/studio-companion/src/studio-controller.mjs';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';

const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const sourceArgs = (project, files) => ({projectId: project.id, expectedRevision: project.revision, requestId: randomUUID(), files});
const deferred = () => {let resolve; const promise = new Promise((done) => {resolve = done;}); return {promise, resolve};};
const fakeRuntime = (onPrepare) => ({
  prepared: [],
  async prepare(project) {
    this.prepared.push(structuredClone(project));
    await onPrepare?.(project);
    const previewId = randomUUID();
    return {previewId, previewUrl: `http://127.0.0.1:4180/previews/${previewId}/player.html`, composition: project.composition};
  },
  async handle() {return false;},
});
async function fixture(t, onPrepare) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-history-'));
  const store = createProjectStore({dataDir});
  const runtime = fakeRuntime(onPrepare);
  const controller = createStudioController({store, runtime});
  t.after(async () => {await controller.settled(); await rm(dataDir, {recursive: true, force: true});});
  const project = await store.createProject({name: '이력 검증', composition});
  return {dataDir, store, runtime, controller, project};
}
const finishSaved = async (controller, project) => {await controller.compile(project.id, project.revision); await controller.settled();};

test('immutable history includes create, browser/source changes and uploads across a store restart', async (t) => {
  const {dataDir, store, project} = await fixture(t);
  const second = await store.updateProject(project.id, {expectedRevision: 1, project: {...project, name: '문구 수정',
    source: {...project.source, files: {...project.source.files, 'src/note.ts': 'export const note = "saved";'}},
    edits: {...project.edits, backgroundColor: '#8844ee'}}});
  const third = await store.uploadAsset(project.id, {expectedRevision: 2, name: '보관.png', mimeType: 'image/png', bytes: png});
  const restarted = createProjectStore({dataDir});
  const history = await restarted.listHistory(project.id);
  assert.deepEqual(history.versions.map((entry) => entry.revision), [3, 2, 1]);
  assert.equal(history.currentRevision, 3);
  assert.equal(history.versions[0].assetCount, 1);
  assert.deepEqual(await restarted.readHistory(project.id, 1), project);
  assert.deepEqual(await restarted.readHistory(project.id, 2), second);
  assert.deepEqual(await restarted.readHistory(project.id, 3), third);
  const fourth = await restarted.updateProject(project.id, {expectedRevision: 3, project: {...third, name: '다음 저장'}});
  assert.equal(fourth.revision, 4);
  assert.deepEqual(await restarted.readHistory(project.id, 2), second);
  assert.ok(!JSON.stringify(history).includes('_studio'));
  assert.ok(!JSON.stringify(history).includes('sha256'));
});

test('a legacy project exposes its current baseline and records that exact baseline on its first new commit', async (t) => {
  const {dataDir, project} = await fixture(t);
  const legacy = {...project, revision: 7, name: '기존 버전 7'};
  await writeFile(path.join(dataDir, project.id, 'project.json'), JSON.stringify(legacy));
  const migrated = createProjectStore({dataDir});
  assert.deepEqual((await migrated.listHistory(project.id)).versions.map((entry) => entry.revision), [7]);
  assert.deepEqual(await migrated.readHistory(project.id, 7), legacy);
  const saved = await migrated.updateProject(project.id, {expectedRevision: 7, project: {...legacy, name: '새 저장'}});
  assert.equal(saved.revision, 8);
  assert.deepEqual((await migrated.listHistory(project.id)).versions.map((entry) => entry.revision), [8, 7]);
  assert.deepEqual(await createProjectStore({dataDir}).readHistory(project.id, 7), legacy);
  await assert.rejects(migrated.readHistory(project.id, 1), {code: 'HISTORY_NOT_FOUND'});
});

test('a failed write never publishes its prepared history file or request receipt', async (t) => {
  const {dataDir, store, project} = await fixture(t);
  await mkdir(path.join(dataDir, project.id, 'src', 'blocked.ts'));
  const requestId = randomUUID();
  await assert.rejects(store.updateProject(project.id, {expectedRevision: 1, requestId, fingerprint: 'a'.repeat(64),
    project: {...project, name: '반영 실패', source: {...project.source, files: {...project.source.files, 'src/blocked.ts': 'blocked'}}}}), {code: 'UNSAFE_STORAGE_PATH'});
  assert.deepEqual(await store.readProject(project.id), project);
  assert.deepEqual((await store.listHistory(project.id)).versions.map((entry) => entry.revision), [1]);
  assert.equal(await store.getRequest(project.id, requestId), null);
  assert.equal((await readdir(path.join(dataDir, project.id, 'history'))).length, 2);
  const successful = await store.updateProject(project.id, {expectedRevision: 1, project: {...project, name: '반영 성공'}});
  assert.deepEqual(await createProjectStore({dataDir}).readHistory(project.id, 2), successful);
  assert.deepEqual((await store.listHistory(project.id)).versions.map((entry) => entry.revision), [2, 1]);
});

test('modified history bytes are rejected without changing the canonical project', async (t) => {
  const {dataDir, store, controller, project} = await fixture(t);
  const saved = await store.updateProject(project.id, {expectedRevision: 1, project: {...project, name: '현재 저장본'}});
  const internal = JSON.parse(await readFile(path.join(dataDir, project.id, 'project.json'), 'utf8'));
  const first = internal._studioHistory.find((entry) => entry.revision === 1);
  await writeFile(path.join(dataDir, project.id, first.file), JSON.stringify({...project, name: '임의 수정'}));
  await assert.rejects(store.readHistory(project.id, 1), {code: 'INVALID_STORED_HISTORY'});
  await assert.rejects(controller.restoreVersion(project.id, {targetRevision: 1, expectedRevision: 2, requestId: randomUUID()}), {code: 'INVALID_STORED_HISTORY'});
  assert.deepEqual(await store.readProject(project.id), saved);
});

test('validated restore commits a new revision with old source/edits and all current assets; retry survives restart', async (t) => {
  const {dataDir, store, runtime, controller, project} = await fixture(t);
  await controller.tool('studio_apply_source', sourceArgs(project, {
    'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// original-animation`,
    'src/layers.json': JSON.stringify([{id: 'title', type: 'text', label: '제목', editable: ['x', 'text'], defaults: {x: 10, text: '기본 문구'}}]),
  }), 'history-test');
  const second = await store.readProject(project.id);
  const target = await controller.save(project.id, {expectedRevision: second.revision, requestId: randomUUID(),
    project: {...second, edits: {...second.edits, layers: {title: {x: 42, text: '수동 문구'}}}}});
  await finishSaved(controller, target);
  const uploaded = await store.uploadAsset(project.id, {expectedRevision: target.revision, name: '나중에 추가.png', mimeType: 'image/png', bytes: png});
  await controller.tool('studio_apply_source', sourceArgs(uploaded, {'src/Root.tsx': `${uploaded.source.files['src/Root.tsx']}\n// later-animation`}), 'history-test');
  const before = await store.readProject(project.id);
  const args = {targetRevision: target.revision, expectedRevision: before.revision, requestId: randomUUID()};
  const restored = await controller.restoreVersion(project.id, args);
  assert.equal(restored.project.revision, before.revision + 1);
  assert.equal(restored.appliedRevision, restored.project.revision);
  assert.equal(restored.replayed, false);
  assert.deepEqual(restored.project.source, target.source);
  assert.deepEqual(restored.project.edits, target.edits);
  assert.deepEqual(restored.project.assets, before.assets);
  assert.deepEqual(await store.readHistory(project.id, target.revision), target);
  assert.deepEqual(runtime.prepared.at(-1).edits, target.edits);
  assert.equal(runtime.prepared.at(-1).revision, restored.project.revision);
  const count = runtime.prepared.length;
  assert.equal((await controller.restoreVersion(project.id, args)).replayed, true);
  assert.equal(runtime.prepared.length, count);
  const later = await controller.save(project.id, {expectedRevision: restored.project.revision, project: {...restored.project, name: '복원 이후 이름'}});
  await finishSaved(controller, later);
  const restartedStore = createProjectStore({dataDir});
  const restartedRuntime = fakeRuntime();
  const restarted = createStudioController({store: restartedStore, runtime: restartedRuntime});
  const repeated = await restarted.restoreVersion(project.id, args);
  assert.equal(repeated.appliedRevision, restored.project.revision);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.project, later);
  assert.equal(restartedRuntime.prepared.length, 0);
  assert.deepEqual((await restartedStore.readAsset(project.id, before.assets[0].id)).bytes, png);
});

test('a failed restore validation preserves the current source, history, receipt and last good preview', async (t) => {
  let failOldSource = false;
  const {store, controller, project} = await fixture(t, async (doc) => {
    if (failOldSource && !doc.source.files['src/Root.tsx'].includes('// newer-source')) throw new Error('복원한 소스 검증 실패');
  });
  await controller.tool('studio_apply_source', sourceArgs(project, {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// newer-source`}), 'history-test');
  const current = await store.readProject(project.id);
  const before = await controller.status(project.id);
  const beforeHistory = await store.listHistory(project.id);
  const requestId = randomUUID();
  failOldSource = true;
  await assert.rejects(controller.restoreVersion(project.id, {targetRevision: 1, expectedRevision: current.revision, requestId}), {code: 'SOURCE_VALIDATION_FAILED'});
  assert.deepEqual(await store.readProject(project.id), current);
  assert.deepEqual(await store.listHistory(project.id), beforeHistory);
  assert.equal(await store.getRequest(project.id, requestId), null);
  const after = await controller.status(project.id);
  assert.equal(after.compile.state, 'failed');
  assert.equal(after.compile.previewUrl, before.compile.previewUrl);
  assert.equal(after.compile.revision, current.revision);
});

test('a concurrent browser write wins over a restore validated against an older revision', async (t) => {
  let blockRestore = false;
  const entered = deferred();
  const release = deferred();
  const {store, controller, project} = await fixture(t, async (doc) => {
    if (blockRestore && !doc.source.files['src/Root.tsx'].includes('// newer-source')) {entered.resolve(); await release.promise;}
  });
  await controller.tool('studio_apply_source', sourceArgs(project, {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// newer-source`}), 'history-test');
  const current = await store.readProject(project.id);
  const requestId = randomUUID();
  blockRestore = true;
  const pending = controller.restoreVersion(project.id, {targetRevision: 1, expectedRevision: current.revision, requestId});
  const rejected = assert.rejects(pending, {code: 'REVISION_CONFLICT'});
  await entered.promise;
  const browser = await store.updateProject(project.id, {expectedRevision: current.revision, project: {...current, name: '검증 중 새 저장'}});
  release.resolve();
  await rejected;
  assert.deepEqual(await store.readProject(project.id), browser);
  assert.equal(await store.getRequest(project.id, requestId), null);
  assert.deepEqual(await store.readHistory(project.id, browser.revision), browser);
  assert.deepEqual((await store.listHistory(project.id)).versions.map((entry) => entry.revision), [3, 2, 1]);
});

test('HTTP history, restore and lost-save receipt recovery expose only public data and retry once', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-history-http-'));
  const runtime = fakeRuntime();
  const server = createStudioServer({dataDir, previewRuntime: runtime});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {await server.studio.controller.settled(); await new Promise((resolve) => server.close(resolve)); await rm(dataDir, {recursive: true, force: true});});
  const call = (route, method = 'GET', body) => fetch(`${base}${route}`, {method, headers: {Origin: 'http://127.0.0.1:5173', ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const project = await (await call('/projects', 'POST', {name: 'HTTP 이력', composition})).json();
  const requestId = randomUUID();
  const saveBody = {expectedRevision: 1, requestId, project: {...project, name: '응답 복구 저장'}};
  const saves = await Promise.all([call(`/projects/${project.id}`, 'PUT', saveBody), call(`/projects/${project.id}`, 'PUT', saveBody)]);
  assert.deepEqual(saves.map((response) => response.status), [200, 200]);
  assert.deepEqual((await Promise.all(saves.map((response) => response.json()))).map((doc) => doc.revision), [2, 2]);
  const receipt = await (await call(`/projects/${project.id}/requests/${requestId}`)).json();
  assert.deepEqual(receipt, {projectId: project.id, requestId, appliedRevision: 2, kind: 'update'});
  const current = await server.studio.store.readProject(project.id);
  await server.studio.controller.tool('studio_apply_source', sourceArgs(current, {'src/Root.tsx': `${current.source.files['src/Root.tsx']}\n// after-ack-loss`}), 'history-http');
  const retry = await call(`/projects/${project.id}`, 'PUT', saveBody);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).revision, 3);
  assert.equal((await call(`/projects/${project.id}`, 'PUT', {...saveBody, project: {...saveBody.project, name: '다른 요청'}})).status, 409);
  const restoreBody = {targetRevision: 1, expectedRevision: 3, requestId: randomUUID()};
  const restored = await (await call(`/projects/${project.id}/restore`, 'POST', restoreBody)).json();
  assert.equal(restored.project.revision, 4);
  assert.equal(restored.appliedRevision, 4);
  assert.deepEqual(restored.project.source, project.source);
  const replay = await (await call(`/projects/${project.id}/restore`, 'POST', restoreBody)).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.project.revision, 4);
  const history = await (await call(`/projects/${project.id}/history`)).json();
  assert.deepEqual(history.versions.map((entry) => entry.revision), [4, 3, 2, 1]);
  assert.deepEqual(await (await call(`/projects/${project.id}/history/1`)).json(), project);
  assert.ok(!JSON.stringify(history).includes('fingerprint'));
  assert.ok(!JSON.stringify(history).includes('file'));
  assert.equal((await call(`/projects/${project.id}/requests/${randomUUID()}`)).status, 404);
  assert.equal((await call(`/projects/${project.id}/history/0`)).status, 400);
  assert.equal((await call(`/projects/${project.id}/restore`, 'POST', {targetRevision: 999, expectedRevision: 4, requestId: randomUUID()})).status, 404);
  assert.equal((await call(`/projects/${project.id}/restore`, 'POST', {targetRevision: 1, expectedRevision: 4, requestId: 'invalid'})).status, 400);
  const foreign = await fetch(`${base}/projects/${project.id}/history`, {headers: {Origin: 'https://foreign.invalid'}});
  assert.equal(foreign.status, 403);
});
