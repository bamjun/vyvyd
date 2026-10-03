import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createProjectStore, MAX_ASSET_BYTES, MAX_REQUEST_RECEIPTS} from '../packages/studio-companion/src/project-store.mjs';

const composition = {width: 640, height: 480, fps: 30, durationInFrames: 90};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
const fixture = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-store-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return {directory, store: createProjectStore({dataDir: directory})};
};
const rejectsCode = (operation, code) => assert.rejects(operation, (cause) => cause.code === code);
const fingerprintFor = (value) => createHash('sha256').update(value).digest('hex');

test('project document, source edits, stable asset bytes and duplicate names survive a new store', async (t) => {
  const {directory, store} = await fixture(t);
  const first = await store.createProject({name: '새 홍보물', composition});
  assert.equal(first.revision, 1);
  assert.equal(await readFile(path.join(directory, first.id, 'src/Root.tsx'), 'utf8'), first.source.files['src/Root.tsx']);
  const uploaded = await store.uploadAsset(first.id, {expectedRevision: 1, name: '로고.png', mimeType: 'image/png', bytes: png});
  const duplicate = await store.uploadAsset(first.id, {expectedRevision: 2, name: '로고.png', mimeType: 'image/png', bytes: png});
  assert.notEqual(duplicate.assets[0].relativePath, duplicate.assets[1].relativePath);
  const modified = structuredClone(duplicate);
  modified.name = '저장한 홍보물';
  modified.edits.backgroundColor = '#aabbcc';
  modified.edits.layers.title = {text: '손으로 바꾼 문구', x: 12};
  modified.source.files['src/Root.tsx'] += '\n// source update';
  modified.source.files['src/nested/color.css'] = ':root {color: red;}';
  const saved = await store.updateProject(first.id, {expectedRevision: 3, project: modified});
  const restarted = createProjectStore({dataDir: directory});
  assert.deepEqual(await restarted.readProject(first.id), saved);
  assert.deepEqual((await restarted.readAsset(first.id, uploaded.assets[0].id)).bytes, png);
  assert.deepEqual((await restarted.readAsset(first.id, duplicate.assets[1].id)).bytes, png);
  assert.equal(await readFile(path.join(directory, first.id, 'src/nested/color.css'), 'utf8'), modified.source.files['src/nested/color.css']);
  assert.deepEqual(await restarted.listProjects(), [{id: saved.id, name: saved.name, revision: 4, updatedAt: saved.updatedAt, composition: saved.composition, assetCount: 2}]);
  assert.equal(saved.createdAt, first.createdAt);
  assert.deepEqual(saved.assets, duplicate.assets);
  assert.ok((await readdir(path.join(directory, first.id))).every((file) => !file.endsWith('.tmp')));
});

test('concurrent writes with the same expected revision commit exactly one revision', async (t) => {
  const {store} = await fixture(t);
  const initial = await store.createProject({name: '동시 수정', composition});
  const outcomes = await Promise.allSettled([
    store.updateProject(initial.id, {expectedRevision: 1, project: {...initial, name: '첫 변경'}}),
    store.uploadAsset(initial.id.toUpperCase(), {expectedRevision: 1, name: 'asset.png', mimeType: 'image/png', bytes: png}),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal((await store.readProject(initial.id)).revision, 2);
  assert.equal((await store.readProject(initial.id.toUpperCase())).id, initial.id);
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: initial}), 'REVISION_CONFLICT');
});

test('source deletions remove materialized files and protected metadata cannot be forged', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '소스 관리', composition});
  const added = await store.updateProject(initial.id, {expectedRevision: 1, project: {...initial, source: {...initial.source, files: {...initial.source.files, 'src/Extra.tsx': 'export const value = 1;'}}}});
  const reduced = structuredClone(added);
  delete reduced.source.files['src/Extra.tsx'];
  const saved = await store.updateProject(initial.id, {expectedRevision: 2, project: reduced});
  await assert.rejects(readFile(path.join(directory, initial.id, 'src/Extra.tsx')), {code: 'ENOENT'});
  for (const patch of [{id: randomUUID()}, {createdAt: '2020-01-01T00:00:00.000Z'}, {revision: 999}]) {
    await rejectsCode(store.updateProject(initial.id, {expectedRevision: 3, project: {...saved, ...patch}}), 'IMMUTABLE_PROJECT_FIELD');
  }
  const forgedAsset = {id: randomUUID(), name: 'fake.png', mimeType: 'image/png', size: 10, relativePath: '', createdAt: saved.createdAt};
  forgedAsset.relativePath = `assets/${forgedAsset.id}.png`;
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 3, project: {...saved, assets: [forgedAsset]}}), 'IMMUTABLE_PROJECT_FIELD');
  assert.equal((await store.readProject(initial.id)).revision, 3);
});

test('traversal, source aliases, unknown assets, and source junctions cannot escape storage', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '경로 검증', composition});
  await rejectsCode(store.readProject('../outside'), 'INVALID_ID');
  await rejectsCode(store.readAsset(initial.id, randomUUID()), 'ASSET_NOT_FOUND');
  for (const filename of ['src/../../outside.txt', 'src\\outside.tsx', 'project.json', 'assets/file.png', 'src/NUL.tsx', 'src/Root.tsx.']) {
    const altered = {...initial, source: {...initial.source, files: {...initial.source.files, [filename]: 'invalid'}}};
    await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: altered}), 'INVALID_PROJECT');
  }
  const caseAlias = {...initial, source: {...initial.source, files: {...initial.source.files, 'src/root.tsx': 'alias'}}};
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: caseAlias}), 'INVALID_PROJECT');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-store-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  const linked = path.join(directory, initial.id, 'src/linked');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = {...initial, source: {...initial.source, files: {...initial.source.files, 'src/linked/escape.tsx': 'must not write'}}};
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: escaped}), 'UNSAFE_STORAGE_PATH');
  assert.deepEqual(await readdir(outside), []);
  assert.equal((await store.readProject(initial.id)).revision, 1);
});

test('image signature, MIME, filename, 20 MiB and 100 asset bounds are enforced', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '업로드 검증', composition});
  await rejectsCode(store.uploadAsset(initial.id, {expectedRevision: 1, name: 'vector.svg', mimeType: 'image/svg+xml', bytes: Buffer.from('<svg/>')}), 'INVALID_IMAGE');
  await rejectsCode(store.uploadAsset(initial.id, {expectedRevision: 1, name: 'logo.jpg', mimeType: 'image/jpeg', bytes: png}), 'IMAGE_TYPE_MISMATCH');
  await rejectsCode(store.uploadAsset(initial.id, {expectedRevision: 1, name: '../logo.png', mimeType: 'image/png', bytes: png}), 'INVALID_FILE_NAME');
  await rejectsCode(store.uploadAsset(initial.id, {expectedRevision: 1, name: 'huge.png', mimeType: 'image/png', bytes: Buffer.alloc(MAX_ASSET_BYTES + 1)}), 'ASSET_TOO_LARGE');
  const full = {...initial, assets: Array.from({length: 100}, () => {
    const id = randomUUID();
    return {id, name: 'existing.png', mimeType: 'image/png', size: png.length, relativePath: `assets/${id}.png`, createdAt: initial.createdAt};
  })};
  await writeFile(path.join(directory, initial.id, 'project.json'), JSON.stringify(full));
  await rejectsCode(store.uploadAsset(initial.id, {expectedRevision: 1, name: 'extra.png', mimeType: 'image/png', bytes: png}), 'ASSET_LIMIT_REACHED');
  assert.equal((await store.readProject(initial.id)).revision, 1);
});

test('concurrent update retries commit one revision and normalize request identity', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '중복 요청', composition});
  const requestId = randomUUID();
  const fingerprint = fingerprintFor('same source update');
  const project = {...initial, name: '한 번만 반영', source: {...initial.source, files: {...initial.source.files, 'src/style.css': 'body {color: red;}'}}};
  assert.equal(await store.getRequest(initial.id, requestId), null);
  const [first, second] = await Promise.all([
    store.updateProject(initial.id, {expectedRevision: 1, project, requestId, fingerprint}),
    store.updateProject(initial.id.toUpperCase(), {expectedRevision: 1, project, requestId: requestId.toUpperCase(), fingerprint: fingerprint.toUpperCase()}),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.revision, 2);
  assert.equal(Object.hasOwn(first, '_studioRequests'), false);
  assert.deepEqual(await store.getRequest(initial.id, requestId.toUpperCase()), {requestId, fingerprint, kind: 'update', revision: 2});
  const stored = JSON.parse(await readFile(path.join(directory, initial.id, 'project.json'), 'utf8'));
  assert.equal(stored.revision, 2);
  assert.equal(stored._studioRequests.length, 1);
  assert.equal(stored._studioRequests[0].revision, stored.revision);
});

test('update receipts survive restart and normal UI writes without reverting later edits', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '재시작', composition});
  const requestId = randomUUID();
  const fingerprint = fingerprintFor('initial request');
  const request = {expectedRevision: 1, project: {...initial, name: '첫 변경'}, requestId, fingerprint};
  const changed = await store.updateProject(initial.id, request);
  const restarted = createProjectStore({dataDir: directory});
  assert.deepEqual(await restarted.updateProject(initial.id, request), changed);
  const uiSaved = await restarted.updateProject(initial.id, {expectedRevision: 2, project: {...changed, name: '사용자 후속 변경'}});
  assert.deepEqual(await restarted.updateProject(initial.id, request), uiSaved);
  assert.equal(uiSaved.revision, 3);
  assert.equal((await restarted.getRequest(initial.id, requestId)).revision, 2);
  assert.deepEqual(await restarted.readProject(initial.id), uiSaved);
  assert.equal(Object.hasOwn((await restarted.listProjects())[0], '_studioRequests'), false);
});

test('concurrent upload retries and restart retries create one asset', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '업로드 재시도', composition});
  const requestId = randomUUID();
  const fingerprint = fingerprintFor('same image upload');
  const request = {expectedRevision: 1, name: '로고.png', mimeType: 'image/png', bytes: png, requestId, fingerprint};
  const uploads = await Promise.all([store.uploadAsset(initial.id, request), store.uploadAsset(initial.id, request)]);
  assert.deepEqual(uploads[0], uploads[1]);
  assert.equal(uploads[0].revision, 2);
  assert.equal(uploads[0].assets.length, 1);
  assert.equal((await readdir(path.join(directory, initial.id, 'assets'))).length, 1);
  assert.deepEqual(await store.getRequest(initial.id, requestId), {requestId, fingerprint, kind: 'upload', revision: 2});
  const restarted = createProjectStore({dataDir: directory});
  assert.deepEqual(await restarted.uploadAsset(initial.id, request), uploads[0]);
  const updated = await restarted.updateProject(initial.id, {expectedRevision: 2, project: {...uploads[0], name: '업로드 후 수정'}});
  assert.deepEqual(await restarted.uploadAsset(initial.id, request), updated);
  assert.equal((await readdir(path.join(directory, initial.id, 'assets'))).length, 1);
});

test('request IDs cannot be reused with different fingerprints or operation kinds', async (t) => {
  const {store} = await fixture(t);
  const initial = await store.createProject({name: 'ID 재사용 방지', composition});
  const requestId = randomUUID();
  const fingerprint = fingerprintFor('update');
  const changed = await store.updateProject(initial.id, {expectedRevision: 1, project: {...initial, name: '저장본'}, requestId, fingerprint});
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 2, project: {...changed, name: '다른 내용'}, requestId, fingerprint: fingerprintFor('different update')}), 'REQUEST_ID_REUSED');
  await rejectsCode(store.uploadAsset(initial.id, {expectedRevision: 2, name: 'same-id.png', mimeType: 'image/png', bytes: png, requestId, fingerprint}), 'REQUEST_ID_REUSED');
  assert.deepEqual(await store.readProject(initial.id), changed);
});

test('invalid request identity or forged internal receipts cannot bypass project validation', async (t) => {
  const {store} = await fixture(t);
  const initial = await store.createProject({name: '요청 검증', composition});
  const requestId = randomUUID();
  const fingerprint = fingerprintFor('valid identity');
  for (const identity of [{requestId: '../request', fingerprint}, {requestId: null, fingerprint}, {fingerprint}]) {
    await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: initial, ...identity}), 'INVALID_REQUEST_ID');
  }
  for (const value of [undefined, '', 'g'.repeat(64), 'a'.repeat(63)]) {
    await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: initial, requestId, fingerprint: value}), 'INVALID_REQUEST_FINGERPRINT');
  }
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: {...initial, _studioRequests: []}, requestId, fingerprint}), 'INVALID_PROJECT');
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: {...initial, source: {...initial.source, files: {...initial.source.files, 'src/../escape.tsx': 'invalid'}}}, requestId, fingerprint}), 'INVALID_PROJECT');
  assert.equal(await store.getRequest(initial.id, requestId), null);
  assert.equal((await store.readProject(initial.id)).revision, 1);
});

test('failed source materialization does not persist a replay receipt', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '실패한 요청', composition});
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-receipt-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  await symlink(outside, path.join(directory, initial.id, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const requestId = randomUUID();
  await rejectsCode(store.updateProject(initial.id, {
    expectedRevision: 1,
    project: {...initial, source: {...initial.source, files: {...initial.source.files, 'src/linked/file.tsx': 'invalid'}}},
    requestId,
    fingerprint: fingerprintFor('failing write'),
  }), 'UNSAFE_STORAGE_PATH');
  const restarted = createProjectStore({dataDir: directory});
  assert.equal(await restarted.getRequest(initial.id, requestId), null);
  assert.equal((await restarted.readProject(initial.id)).revision, 1);
  assert.deepEqual(await readdir(outside), []);
});

test('receipt retention is bounded and a pruned old request cannot bypass revision checks', async (t) => {
  const {store, directory} = await fixture(t);
  const initial = await store.createProject({name: '기록 제한', composition});
  const receipts = Array.from({length: MAX_REQUEST_RECEIPTS}, (_, index) => ({requestId: randomUUID(), fingerprint: fingerprintFor(`receipt ${index}`), kind: 'update', revision: index + 2}));
  const current = {...initial, revision: MAX_REQUEST_RECEIPTS + 1};
  await writeFile(path.join(directory, initial.id, 'project.json'), JSON.stringify({...current, _studioRequests: receipts}));
  const requestId = randomUUID();
  const saved = await store.updateProject(initial.id, {expectedRevision: current.revision, project: current, requestId, fingerprint: fingerprintFor('new receipt')});
  assert.equal(await store.getRequest(initial.id, receipts[0].requestId), null);
  assert.equal((await store.getRequest(initial.id, receipts[1].requestId)).revision, 3);
  const stored = JSON.parse(await readFile(path.join(directory, initial.id, 'project.json'), 'utf8'));
  assert.equal(stored._studioRequests.length, MAX_REQUEST_RECEIPTS);
  assert.equal(stored._studioRequests.at(-1).requestId, requestId);
  await rejectsCode(store.updateProject(initial.id, {expectedRevision: 1, project: initial, requestId: receipts[0].requestId, fingerprint: receipts[0].fingerprint}), 'REVISION_CONFLICT');
  assert.equal((await store.readProject(initial.id)).revision, saved.revision);
});
