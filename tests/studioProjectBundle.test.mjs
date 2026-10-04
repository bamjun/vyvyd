import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs, {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {exportProjectBundle, importProjectBundle, MAX_BUNDLE_ASSET_BYTES} from '../packages/studio-companion/src/project-bundle.mjs';
import {createProjectStore, MAX_ASSET_BYTES} from '../packages/studio-companion/src/project-store.mjs';

const composition = {width: 640, height: 800, fps: 24, durationInFrames: 72};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-bundle-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const store = createProjectStore({dataDir});
  const created = await store.createProject({name: '내 포스터', composition});
  const uploaded = await store.uploadAsset(created.id, {expectedRevision: 1, name: '원본.png', mimeType: 'image/png', bytes: png});
  const assetId = uploaded.assets[0].id;
  const project = await store.updateProject(uploaded.id, {expectedRevision: 2, project: {...uploaded,
    source: {...uploaded.source, files: {...uploaded.source.files,
      'src/layers.json': JSON.stringify([
        {id: 'title', type: 'text', label: '제목', editable: ['x', 'text', 'color', 'rotation'], defaults: {x: 10, text: '처음 제목'}},
        {id: 'picture', type: 'image', label: '이미지', editable: ['assetId', 'width', 'hidden'], defaults: {assetId, width: 100}},
      ]), 'src/assets.ts': `export const image = '${assetId}';`, 'src/nested/styles.css': '.title {font-weight: bold;}',
    }}, edits: {backgroundColor: '#eeffdd', layers: {
      title: {x: 120.5, text: '수동으로 편집한 제목', color: '#123456', rotation: -4}, picture: {assetId, width: 130, hidden: false},
    }}}});
  return {dataDir, store, project, bundle: await exportProjectBundle(store, project.id, project.revision)};
}

test('a project bundle round-trips all source, composition, stable images and manual edits into an independent project', async (t) => {
  const {dataDir, store, project, bundle} = await fixture(t);
  assert.deepEqual(Object.keys(bundle), ['format', 'version', 'project', 'assets']);
  assert.equal(bundle.format, 'vyvyd-project');
  assert.equal(bundle.version, 1);
  assert.deepEqual(bundle.project, project);
  assert.deepEqual(bundle.assets, [{id: project.assets[0].id, base64: png.toString('base64'), sha256: hash(png)}]);
  const encoded = JSON.stringify(bundle);
  assert.ok(!encoded.includes('_studioHistory'));
  assert.ok(!encoded.includes('_studioRequests'));
  assert.ok(!encoded.includes(dataDir));
  assert.ok(!encoded.includes('previewUrl'));
  const imported = await importProjectBundle(store, JSON.parse(encoded));
  assert.notEqual(imported.id, project.id);
  assert.equal(imported.revision, 1);
  assert.equal(imported.name, '내 포스터 (가져옴)');
  assert.ok(imported.createdAt >= project.createdAt);
  assert.equal(imported.createdAt, imported.updatedAt);
  assert.deepEqual(imported.source, project.source);
  assert.deepEqual(imported.composition, project.composition);
  assert.deepEqual(imported.edits, project.edits);
  assert.deepEqual(imported.assets, project.assets);
  const restarted = createProjectStore({dataDir});
  assert.deepEqual(await restarted.readProject(project.id), project);
  assert.deepEqual(await restarted.readProject(imported.id), imported);
  assert.deepEqual((await restarted.readAsset(imported.id, project.assets[0].id)).bytes, png);
  assert.deepEqual((await restarted.listHistory(imported.id)).versions.map((entry) => entry.revision), [1]);
  assert.deepEqual(await restarted.readHistory(imported.id, 1), imported);
  assert.equal(await readFile(path.join(dataDir, imported.id, 'src/nested/styles.css'), 'utf8'), project.source.files['src/nested/styles.css']);
  const saved = await restarted.updateProject(imported.id, {expectedRevision: 1, project: {...imported, name: '사본 수정'}});
  assert.equal(saved.revision, 2);
  assert.deepEqual(await restarted.readProject(project.id), project);
  const secondCopy = await importProjectBundle(restarted, bundle);
  assert.notEqual(secondCopy.id, imported.id);
  assert.equal((await restarted.listProjects()).length, 3);
});

test('an empty project is portable and imported names stay within the 80-character limit', async (t) => {
  const {store} = await fixture(t);
  const original = await store.createProject({name: '가'.repeat(80), composition});
  const bundle = await exportProjectBundle(store, original.id, 1);
  assert.deepEqual(bundle.assets, []);
  const imported = await importProjectBundle(store, bundle);
  assert.equal(Array.from(imported.name).length, 80);
  assert.ok(imported.name.endsWith(' (가져옴)'));
  assert.deepEqual(imported.source, original.source);
});

test('export checks the requested canonical revision and rejects modified stored image metadata/signatures', async (t) => {
  const {dataDir, store, project} = await fixture(t);
  await assert.rejects(exportProjectBundle(store, project.id, 2), {code: 'REVISION_CONFLICT'});
  await assert.rejects(exportProjectBundle(store, project.id, 0), {code: 'INVALID_REVISION'});
  await writeFile(path.join(dataDir, project.id, project.assets[0].relativePath), Buffer.alloc(png.length));
  await assert.rejects(exportProjectBundle(store, project.id, project.revision), {code: 'INVALID_IMAGE'});
  assert.deepEqual(await store.readProject(project.id), project);
});

test('a concurrent source save does not mix the captured bundle with a later revision', async (t) => {
  const {store, project} = await fixture(t);
  let later;
  const captured = await exportProjectBundle({
    readProject: (id) => store.readProject(id),
    async readAsset(id, assetId) {
      later = await store.updateProject(project.id, {expectedRevision: project.revision, project: {...project, name: '내보내는 중 수정',
        source: {...project.source, files: {...project.source.files, 'src/after.ts': 'export const later = true;'}}}});
      return store.readAsset(id, assetId);
    },
  }, project.id, project.revision);
  assert.deepEqual(captured.project, project);
  assert.equal((await store.readProject(project.id)).revision, later.revision);
  assert.deepEqual(captured.assets[0].base64, png.toString('base64'));
});

test('corrupt bytes, hashes, noncanonical Base64 and missing/extra/duplicate asset payloads never create a partial project', async (t) => {
  const {dataDir, store, project, bundle} = await fixture(t);
  const corrupt = Buffer.from(png); corrupt[corrupt.length - 1] ^= 1;
  const mutations = [
    (copy) => {copy.assets[0].sha256 = '0'.repeat(64);},
    (copy) => {copy.assets[0].base64 = corrupt.toString('base64');},
    (copy) => {copy.assets[0].base64 = `${copy.assets[0].base64}\n`;},
    (copy) => {copy.assets[0].base64 = copy.assets[0].base64.replace(/=$/, '');},
    (copy) => {copy.assets[0].base64 = ' '.repeat(copy.assets[0].base64.length);},
    (copy) => {copy.assets[0].sha256 = 'bad';},
    (copy) => {copy.assets = [];},
    (copy) => {copy.assets.push({...copy.assets[0], id: randomUUID()});},
    (copy) => {copy.assets[0].id = randomUUID();},
    (copy) => {copy.assets[0].path = '../outside.png';},
    (copy) => {copy.project.assets[0].size += 1;},
    (copy) => {copy.project.assets[0].mimeType = 'image/jpeg';},
    (copy) => {copy.project.assets[0].relativePath = `assets/${copy.project.assets[0].id}.jpg`;},
  ];
  const before = await readdir(dataDir);
  for (const mutate of mutations) {
    const copy = structuredClone(bundle); mutate(copy);
    await assert.rejects(importProjectBundle(store, copy), {code: 'INVALID_PROJECT_BUNDLE'});
    assert.deepEqual(await readdir(dataDir), before);
  }
  const doubled = structuredClone(bundle);
  const extraAsset = {...doubled.project.assets[0], id: randomUUID()};
  extraAsset.relativePath = `assets/${extraAsset.id}.png`;
  doubled.project.assets.push(extraAsset); doubled.assets.push({...doubled.assets[0]});
  await assert.rejects(importProjectBundle(store, doubled), {code: 'INVALID_PROJECT_BUNDLE'});
  assert.deepEqual(await store.readProject(project.id), project);
  assert.equal((await store.listProjects()).length, 1);
});

test('unsafe source/asset paths, unknown fields and dangerous JSON keys are rejected before storage', async (t) => {
  const {dataDir, store, bundle} = await fixture(t);
  const mutations = [
    (copy) => {copy.format = 'zip';},
    (copy) => {copy.version = 2;},
    (copy) => {copy.files = {'../../outside.txt': 'no'};},
    (copy) => {copy.project._studioRequests = [];},
    (copy) => {copy.project.source.files['src/../../outside.ts'] = 'no';},
    (copy) => {copy.project.source.files['src\\outside.ts'] = 'no';},
    (copy) => {copy.project.source.files['src/root.tsx'] = 'case alias';},
    (copy) => {copy.project.assets[0].relativePath = '../../outside.png';},
    (copy) => {copy.project.assets[0].name = '../outside.png';},
    (copy) => {copy.project.edits.layers = JSON.parse('{"__proto__":{"polluted":true}}');},
    (copy) => {copy.project.edits.layers.title = JSON.parse('{"constructor":{"polluted":true}}');},
  ];
  const before = await readdir(dataDir);
  for (const mutate of mutations) {
    const copy = structuredClone(bundle); mutate(copy);
    await assert.rejects(importProjectBundle(store, copy));
    assert.deepEqual(await readdir(dataDir), before);
  }
  assert.equal({}.polluted, undefined);
});

test('unregistered, unsupported and missing-asset layer overrides or defaults are rejected', async (t) => {
  const {dataDir, store, bundle} = await fixture(t);
  const mutations = [
    (copy) => {copy.project.edits.layers.missing = {x: 10};},
    (copy) => {copy.project.edits.layers.title.scale = 2;},
    (copy) => {copy.project.edits.layers.picture.assetId = randomUUID();},
    (copy) => {delete copy.project.source.files['src/layers.json'];},
    (copy) => {copy.project.source.files['src/layers.json'] = '[{"id":"title","type":"text","label":"제목","editable":["unsupported"],"defaults":{}}]';},
    (copy) => {const registry = JSON.parse(copy.project.source.files['src/layers.json']); registry[1].defaults.assetId = randomUUID(); copy.project.source.files['src/layers.json'] = JSON.stringify(registry);},
  ];
  const before = await readdir(dataDir);
  for (const mutate of mutations) {
    const copy = structuredClone(bundle); mutate(copy);
    await assert.rejects(importProjectBundle(store, copy), {code: 'INVALID_LAYERS'});
    assert.deepEqual(await readdir(dataDir), before);
  }
});

test('file, aggregate and image-count limits reject metadata before decoding oversized payloads', async (t) => {
  const {dataDir, store, bundle} = await fixture(t);
  const oversized = structuredClone(bundle); oversized.project.assets[0].size = MAX_ASSET_BYTES + 1;
  await assert.rejects(importProjectBundle(store, oversized), {code: 'INVALID_PROJECT_BUNDLE', statusCode: 413});
  const aggregate = structuredClone(bundle);
  aggregate.project.assets = Array.from({length: 6}, (_, index) => {
    const id = index ? randomUUID() : bundle.project.assets[0].id;
    return {...bundle.project.assets[0], id, size: MAX_ASSET_BYTES, relativePath: `assets/${id}.png`};
  });
  assert.ok(aggregate.project.assets.reduce((total, asset) => total + asset.size, 0) > MAX_BUNDLE_ASSET_BYTES);
  await assert.rejects(importProjectBundle(store, aggregate), {code: 'INVALID_PROJECT_BUNDLE', statusCode: 413});
  const many = structuredClone(bundle);
  many.project.assets = Array.from({length: 101}, (_, index) => {
    const id = index ? randomUUID() : bundle.project.assets[0].id;
    return {...bundle.project.assets[0], id, relativePath: `assets/${id}.png`};
  });
  await assert.rejects(importProjectBundle(store, many), {code: 'INVALID_PROJECT_BUNDLE', statusCode: 413});
  assert.equal((await readdir(dataDir)).length, 1);
});

test('an import write failure publishes neither a partial project nor history and removes only its owned new directory', async (t) => {
  const {dataDir, store, project, bundle} = await fixture(t);
  const originalRename = fs.rename;
  let stagedId;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) !== 'project.json') return originalRename(from, to);
    stagedId = path.basename(path.dirname(to));
    assert.notEqual(stagedId, project.id);
    assert.equal(path.dirname(path.dirname(to)), dataDir);
    assert.deepEqual((await store.listProjects()).map((item) => item.id), [project.id]);
    assert.deepEqual(await readFile(path.join(dataDir, stagedId, project.assets[0].relativePath)), png);
    assert.equal(await readFile(path.join(dataDir, stagedId, 'src/assets.ts'), 'utf8'), project.source.files['src/assets.ts']);
    assert.equal((await readdir(path.join(dataDir, stagedId, 'history'))).length, 1);
    throw Object.assign(new Error('simulated atomic publish failure'), {code: 'EIO'});
  });
  syncBuiltinESMExports();
  try {await assert.rejects(importProjectBundle(store, bundle), {code: 'EIO'});} finally {mocked.mock.restore(); syncBuiltinESMExports();}
  assert.ok(stagedId);
  assert.deepEqual(await readdir(dataDir), [project.id]);
  assert.deepEqual(await store.readProject(project.id), project);
  assert.deepEqual((await store.readAsset(project.id, project.assets[0].id)).bytes, png);
});

test('source syntax is preserved without execution on import for the existing editor compile/recovery flow', async (t) => {
  const {store, bundle} = await fixture(t);
  const draft = structuredClone(bundle);
  draft.project.source.files['src/Root.tsx'] = 'export const broken = ;';
  const imported = await importProjectBundle(store, draft);
  assert.equal(imported.source.files['src/Root.tsx'], 'export const broken = ;');
  assert.equal(imported.revision, 1);
  assert.deepEqual(imported.edits, bundle.project.edits);
});
