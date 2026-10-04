import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';
import {createStudioController} from '../packages/studio-companion/src/studio-controller.mjs';

const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const sourceArgs = (project, files, layerEdits) => ({projectId: project.id, expectedRevision: project.revision, requestId: randomUUID(), files, ...(layerEdits ? {layerEdits} : {})});
const registryFor = (assetId) => [
  {id: 'title', type: 'text', label: '제목', editable: ['x', 'y', 'rotation', 'text', 'fontSize', 'color', 'opacity', 'hidden', 'locked', 'zIndex'], defaults: {x: 10, y: 20, rotation: 0, text: '기본 문구', fontSize: 32, color: '#101528', opacity: 1, hidden: false, locked: false, zIndex: 0}},
  {id: 'photo', type: 'image', label: '이미지', editable: ['x', 'y', 'width', 'height', 'rotation', 'assetId', 'opacity', 'hidden', 'locked', 'zIndex'], defaults: {x: 30, y: 120, width: 80, height: 60, rotation: 0, assetId, opacity: 1, hidden: false, locked: false, zIndex: 1}},
];

async function fixture(t, failWhen = () => false, onPrepare = async () => {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-layer-integration-'));
  const store = createProjectStore({dataDir});
  const snapshots = new Map();
  const renders = [];
  const runtime = {
    async prepare(project) {
      await onPrepare(project);
      if (failWhen(project)) throw new Error('편집 값으로 인한 렌더 실패');
      const previewId = randomUUID();
      snapshots.set(previewId, structuredClone(project));
      return {previewId, previewUrl: `http://127.0.0.1:4180/previews/${previewId}/player.html`, composition: project.composition};
    },
    async renderPreview(previewId, {frame}) {
      assert.ok(snapshots.has(previewId), 'the controller must render an existing validated snapshot');
      renders.push({project: snapshots.get(previewId), frame});
      return png;
    },
  };
  const controller = createStudioController({store, runtime});
  t.after(async () => {await controller.settled(); await rm(dataDir, {recursive: true, force: true});});
  let project = await store.createProject({name: '레이어 편집 통합', composition});
  project = await store.uploadAsset(project.id, {expectedRevision: project.revision, name: '원본.png', mimeType: 'image/png', bytes: png});
  project = await store.uploadAsset(project.id, {expectedRevision: project.revision, name: '교체.png', mimeType: 'image/png', bytes: png});
  const registry = registryFor(project.assets[0].id);
  await controller.tool('studio_apply_source', sourceArgs(project, {'src/layers.json': JSON.stringify(registry)}), 'layer-integration');
  return {store, controller, snapshots, renders, registry, project: await store.readProject(project.id)};
}

const settleSaved = async (controller, project) => {
  await controller.compile(project.id, project.revision);
  await controller.settled();
};

test('browser layer edits and image replacement survive a Codex animation follow-up and reach the exact saved preview', async (t) => {
  const {store, controller, renders, registry, project} = await fixture(t);
  const manual = {
    title: {x: 42.5, y: 63, rotation: -12, text: '브라우저에서 고친 문구', fontSize: 38, color: '#7246e5', opacity: 0.8, locked: true, zIndex: 4},
    photo: {x: 76, y: 190, width: 120, height: 90, rotation: 8, assetId: project.assets[1].id, hidden: false, zIndex: 2},
  };
  const saved = await controller.save(project.id, {expectedRevision: project.revision, project: {...project, edits: {...project.edits, layers: manual}}});
  await settleSaved(controller, saved);
  assert.equal(saved.revision, project.revision + 1);
  assert.deepEqual(saved.edits.layers, manual);
  const followupRegistry = registry.map((layer) => layer.id === 'title' ? {...layer, defaults: {...layer.defaults, x: 95, text: 'Codex가 바꾼 기본 문구'}} : layer);
  const followup = await controller.tool('studio_apply_source', sourceArgs(saved, {
    'src/Root.tsx': `${saved.source.files['src/Root.tsx']}\n// Codex animation follow-up`,
    'src/layers.json': JSON.stringify(followupRegistry),
  }), 'layer-integration');
  const current = await store.readProject(project.id);
  assert.equal(current.revision, saved.revision + 1);
  assert.deepEqual(current.edits.layers, manual);
  assert.deepEqual(current.assets, saved.assets);
  assert.deepEqual((await store.readAsset(project.id, manual.photo.assetId)).bytes, png);
  const codexRead = await controller.tool('studio_read_project', {projectId: project.id}, 'layer-integration');
  assert.deepEqual(codexRead.edits.layers, manual);
  assert.equal(codexRead.layers.find((layer) => layer.id === 'title').defaults.x, 95);
  const preview = await controller.tool('studio_preview', {projectId: project.id, frame: 17}, 'layer-integration');
  assert.equal(followup.compile.revision, current.revision);
  assert.equal(preview.metadata.revision, current.revision);
  assert.equal(renders.at(-1).project.revision, current.revision);
  assert.deepEqual(renders.at(-1).project.edits.layers, manual);
  assert.equal(renders.at(-1).frame, 17);
});

test('an image ID belonging to another project cannot be saved into a browser layer', async (t) => {
  const {store, controller, snapshots, project} = await fixture(t);
  let other = await store.createProject({name: '다른 이미지 프로젝트', composition});
  other = await store.uploadAsset(other.id, {expectedRevision: other.revision, name: '다른 프로젝트.png', mimeType: 'image/png', bytes: png});
  const beforeStatus = await controller.status(project.id);
  const beforeCount = snapshots.size;
  await assert.rejects(controller.save(project.id, {
    expectedRevision: project.revision,
    project: {...project, edits: {...project.edits, layers: {photo: {assetId: other.assets[0].id}}}},
  }), {code: 'INVALID_LAYERS'});
  assert.deepEqual(await store.readProject(project.id), project);
  assert.deepEqual(await controller.status(project.id), beforeStatus);
  assert.equal(snapshots.size, beforeCount);
});

test('a saved browser edit that fails rendering keeps the previous snapshot and a corrected edit recovers at its own revision', async (t) => {
  const {store, controller, renders, project} = await fixture(t, (doc) => doc.edits.layers.title?.text === '렌더 실패');
  const beforeStatus = await controller.status(project.id);
  const broken = await controller.save(project.id, {
    expectedRevision: project.revision,
    project: {...project, edits: {...project.edits, layers: {title: {x: 45, y: 55, text: '렌더 실패'}}}},
  });
  await settleSaved(controller, broken);
  assert.equal((await store.readProject(project.id)).revision, broken.revision);
  assert.equal((await store.readProject(project.id)).edits.layers.title.text, '렌더 실패');
  const failed = await controller.status(project.id);
  assert.equal(failed.revision, broken.revision);
  assert.equal(failed.compile.state, 'failed');
  assert.equal(failed.compile.revision, project.revision);
  assert.equal(failed.compile.previewUrl, beforeStatus.compile.previewUrl);
  const corrected = await controller.save(project.id, {
    expectedRevision: broken.revision,
    project: {...broken, edits: {...broken.edits, layers: {title: {...broken.edits.layers.title, text: '정상 문구'}}}},
  });
  await settleSaved(controller, corrected);
  const recovered = await controller.status(project.id);
  assert.equal(recovered.compile.state, 'ready');
  assert.equal(recovered.compile.revision, corrected.revision);
  assert.notEqual(recovered.compile.previewUrl, beforeStatus.compile.previewUrl);
  const preview = await controller.tool('studio_preview', {projectId: project.id, frame: 20}, 'layer-integration');
  assert.equal(preview.metadata.revision, corrected.revision);
  assert.deepEqual(renders.at(-1).project.edits.layers.title, {x: 45, y: 55, text: '정상 문구'});
});

test('a Codex capability change must explicitly remove the obsolete override while preserving other browser edits', async (t) => {
  const {store, controller, registry, project} = await fixture(t);
  const manual = {x: 42, y: 64, rotation: 18, text: '수동 위치와 문구 유지'};
  const saved = await controller.save(project.id, {expectedRevision: project.revision, project: {...project, edits: {...project.edits, layers: {title: manual}}}});
  await settleSaved(controller, saved);
  const changedRegistry = registry.map((layer) => layer.id === 'title' ? {...layer, editable: layer.editable.filter((key) => key !== 'rotation')} : layer);
  const files = {'src/layers.json': JSON.stringify(changedRegistry)};
  await assert.rejects(controller.tool('studio_apply_source', sourceArgs(saved, files), 'layer-integration'), {code: 'INVALID_LAYERS'});
  assert.deepEqual(await store.readProject(project.id), saved);
  const cleaned = await controller.tool('studio_apply_source', sourceArgs(saved, files, {title: {rotation: null}}), 'layer-integration');
  const current = await store.readProject(project.id);
  assert.equal(cleaned.appliedRevision, saved.revision + 1);
  assert.deepEqual(current.edits.layers.title, {x: 42, y: 64, text: '수동 위치와 문구 유지'});
  await assert.rejects(controller.tool('studio_update_edits', {
    projectId: project.id, expectedRevision: current.revision, requestId: randomUUID(), layerEdits: {title: {rotation: 5}},
  }, 'layer-integration'), {code: 'INVALID_LAYERS'});
  await assert.rejects(controller.tool('studio_update_edits', {
    projectId: project.id, expectedRevision: current.revision, requestId: randomUUID(), layerEdits: {title: {unknown: null}},
  }, 'layer-integration'), {code: 'INVALID_LAYERS'});
  assert.deepEqual(await store.readProject(project.id), current);
});

test('saving a layer position while Codex validates source prevents that older source from replacing the manual edit', async (t) => {
  let release;
  const gate = new Promise((resolve) => {release = resolve;});
  let entered;
  const started = new Promise((resolve) => {entered = resolve;});
  const {store, controller, renders, project} = await fixture(t, () => false, async (doc) => {
    if (doc.source.files['src/Root.tsx'].includes('// pending-animation')) {entered(); await gate;}
  });
  t.after(() => release());
  const pending = controller.tool('studio_apply_source', sourceArgs(project, {
    'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// pending-animation`,
  }), 'layer-integration');
  await started;
  const manual = {title: {x: 58, y: 79, text: '검증 중 이동'}};
  const saved = await controller.save(project.id, {expectedRevision: project.revision, project: {...project, edits: {...project.edits, layers: manual}}});
  release();
  await assert.rejects(pending, {code: 'REVISION_CONFLICT'});
  await settleSaved(controller, saved);
  const current = await store.readProject(project.id);
  assert.deepEqual(current.edits.layers, manual);
  assert.equal(current.source.files['src/Root.tsx'], project.source.files['src/Root.tsx']);
  const preview = await controller.tool('studio_preview', {projectId: project.id, frame: 16}, 'layer-integration');
  assert.equal(preview.metadata.revision, saved.revision);
  assert.deepEqual(renders.at(-1).project.edits.layers, manual);
});
