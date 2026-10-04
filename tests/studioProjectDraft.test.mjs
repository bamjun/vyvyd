import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createProjectDocument, validateProjectDocument, MAX_SOURCE_BYTES} from '../packages/studio-runtime/src/project-model.mjs';
import {parseStoredStudioDraft, rebaseStudioDraft, studioDraftForProject} from '../packages/studio-runtime/src/project-draft.mjs';

function fixture() {
  const initial = createProjectDocument({name: '초안 검증', composition: {width: 600, height: 800, fps: 30, durationInFrames: 90}});
  const assetId = randomUUID();
  const registry = [
    {id: 'title', type: 'text', label: '제목', editable: ['x', 'y', 'text', 'hidden', 'locked'], defaults: {x: 0, y: 0, text: '기본'}},
    {id: 'logo', type: 'image', label: '로고', editable: ['assetId', 'width'], defaults: {assetId, width: 100}},
  ];
  const base = validateProjectDocument({...initial, revision: 7,
    source: {...initial.source, files: {...initial.source.files, 'src/layers.json': JSON.stringify(registry)}},
    assets: [{id: assetId, name: '이미지.png', mimeType: 'image/png', size: 1, relativePath: `assets/${assetId}.png`, createdAt: initial.createdAt}],
    edits: {...initial.edits, layers: {title: {x: 10, y: 20, text: '저장된 문구'}}},
  });
  const snapshot = studioDraftForProject(base);
  return {base, snapshot, registry, record: {version: 1, projectId: base.id, base, snapshot}};
}

function withLayers(base, layers, changes = {}) {
  return validateProjectDocument({...base, ...changes, edits: {...base.edits, layers}});
}

function savePending(base, submitted) {
  const project = validateProjectDocument({...base, name: submitted.fields.name,
    composition: {...base.composition, width: Number(submitted.fields.width), height: Number(submitted.fields.height), fps: Number(submitted.fields.fps), durationInFrames: Math.round(Number(submitted.fields.seconds) * Number(submitted.fields.fps))},
    edits: {backgroundColor: submitted.fields.backgroundColor, layers: submitted.layers},
  });
  return {kind: 'save', requestId: randomUUID(), expectedRevision: base.revision, project, submitted};
}

test('project snapshots use canonical settings and detached editable values', () => {
  const {base, snapshot} = fixture();
  assert.deepEqual(snapshot.fields, {name: '초안 검증', width: '600', height: '800', fps: '30', seconds: '3', backgroundColor: '#ffffff'});
  snapshot.layers.title.x = 999;
  assert.equal(base.edits.layers.title.x, 10);
});

test('three-way rebase carries only local changes including removals onto new settings and layers', () => {
  const {base, snapshot} = fixture();
  const draft = structuredClone(snapshot);
  draft.fields.name = '내 이름';
  draft.fields.width = '';
  draft.layers.title.x = 55;
  delete draft.layers.title.y;
  const latest = withLayers(base, {title: {x: 101, y: 200, text: 'Codex 문구', hidden: true}}, {
    name: '외부 이름', revision: 8, composition: {...base.composition, height: 900, fps: 24, durationInFrames: 120},
  });
  const result = rebaseStudioDraft(snapshot, draft, latest);
  assert.deepEqual(result.snapshot.fields, {name: '내 이름', width: '', height: '900', fps: '24', seconds: '5', backgroundColor: '#ffffff'});
  assert.deepEqual(result.snapshot.layers, {title: {x: 55, text: 'Codex 문구', hidden: true}});
  assert.deepEqual(result.discarded, []);
  assert.equal(latest.edits.layers.title.x, 101);
});

test('post-submission offline edits are rebased against the submitted snapshot rather than the older base', () => {
  const {base, snapshot} = fixture();
  const submitted = structuredClone(snapshot);
  submitted.fields.width = '700';
  submitted.layers.title.x = 25;
  const offline = structuredClone(submitted);
  offline.fields.name = '응답 이후 입력';
  offline.layers.title.y = 70;
  const latest = withLayers(base, {...submitted.layers, title: {...submitted.layers.title, text: '새 소스 문구'}}, {
    revision: 8, name: '저장 이름', composition: {...base.composition, width: 700},
  });
  const {snapshot: rebased} = rebaseStudioDraft(submitted, offline, latest);
  assert.equal(rebased.fields.width, '700');
  assert.equal(rebased.fields.name, '응답 이후 입력');
  assert.deepEqual(rebased.layers.title, {x: 25, y: 70, text: '새 소스 문구'});
});

test('rebase reports a removed capability while preserving other manual edits and source changes', () => {
  const {base, snapshot, registry} = fixture();
  const draft = structuredClone(snapshot);
  draft.layers.title.x = 88;
  draft.layers.title.text = '내 문구';
  const latest = withLayers(base, {title: {text: '외부 문구'}}, {
    revision: 8,
    source: {...base.source, files: {...base.source.files, 'src/layers.json': JSON.stringify(registry.map((layer) => layer.id === 'title' ? {...layer, editable: ['text']} : layer))}},
  });
  assert.deepEqual(rebaseStudioDraft(snapshot, draft, latest), {
    snapshot: {fields: snapshot.fields, layers: {title: {text: '내 문구'}}}, discarded: ['제목 (x)'],
  });
});

test('stored drafts retain unfinished settings but reject unregistered or invalid layer values', () => {
  const {record} = fixture();
  record.snapshot.fields.width = '-';
  record.snapshot.fields.name = '';
  assert.equal(parseStoredStudioDraft(record).snapshot.fields.width, '-');
  const variants = [
    {title: {x: Infinity}}, {title: {x: null}}, {title: {unsupported: 1}},
    {missing: {text: 'not registered'}}, {logo: {assetId: randomUUID()}}, {title: ['bad']},
  ];
  for (const layers of variants) assert.equal(parseStoredStudioDraft({...record, snapshot: {...record.snapshot, layers}}), null);
  assert.equal(parseStoredStudioDraft({...record, snapshot: {...record.snapshot, fields: {...record.snapshot.fields, fps: '1'.repeat(65)}}}), null);
});

test('stored draft isolation rejects foreign IDs, inherited data and injected keys without mutating the input', () => {
  const {base, record} = fixture();
  assert.equal(parseStoredStudioDraft({...record, projectId: randomUUID()}), null);
  assert.equal(parseStoredStudioDraft({...record, version: 2}), null);
  assert.equal(parseStoredStudioDraft({...record, unexpected: true}), null);
  assert.equal(parseStoredStudioDraft(Object.create(record)), null);
  assert.equal(parseStoredStudioDraft({...record, snapshot: {...record.snapshot, layers: JSON.parse('{"__proto__":{"text":"pollution"}}')}}), null);
  const parsed = parseStoredStudioDraft(record);
  parsed.base.name = 'changed';
  parsed.snapshot.layers.title.x = 444;
  assert.equal(record.base.name, base.name);
  assert.equal(record.snapshot.layers.title.x, 10);
  assert.equal(Object.prototype.pollution, undefined);
});

test('pending save validates its UUID, revision, project identity and submitted candidate', () => {
  const {base, snapshot, record} = fixture();
  const submitted = structuredClone(snapshot);
  submitted.layers.title.x = 45;
  const pending = savePending(base, submitted);
  const offline = structuredClone(submitted);
  offline.fields.height = '';
  const parsed = parseStoredStudioDraft({...record, snapshot: offline, pending: {...pending, requestId: pending.requestId.toUpperCase()}});
  assert.equal(parsed.pending.requestId, pending.requestId);
  assert.equal(parsed.snapshot.fields.height, '');
  assert.equal(parsed.pending.submitted.fields.height, '800');
  const wrong = [
    {...pending, requestId: 'not-a-uuid'}, {...pending, expectedRevision: base.revision + 1},
    {...pending, project: {...pending.project, id: randomUUID()}},
    {...pending, project: {...pending.project, revision: base.revision - 1}},
    {...pending, project: {...pending.project, name: 'submitted와 다름'}},
    {...pending, project: {...pending.project, source: {...pending.project.source, files: {...pending.project.source.files, 'src/Injected.tsx': 'export const injected = true;'}}}},
    {...pending, targetRevision: 2},
  ];
  for (const value of wrong) assert.equal(parseStoredStudioDraft({...record, pending: value}), null);
});

test('pending restore remains scoped to the current base and rejects cross-kind or future revision data', () => {
  const {base, snapshot, record} = fixture();
  const pending = {kind: 'restore', requestId: randomUUID(), expectedRevision: base.revision, targetRevision: 3, submitted: snapshot};
  assert.deepEqual(parseStoredStudioDraft({...record, pending}).pending, pending);
  assert.equal(parseStoredStudioDraft({...record, pending: {...pending, targetRevision: 0}}), null);
  assert.equal(parseStoredStudioDraft({...record, pending: {...pending, targetRevision: base.revision + 1}}), null);
  assert.equal(parseStoredStudioDraft({...record, pending: {...pending, project: base}}), null);
});

test('stored full source validation keeps the existing source size and path boundary', () => {
  const {base, record} = fixture();
  assert.equal(parseStoredStudioDraft({...record, base: {...base, source: {...base.source, files: {...base.source.files, 'src/Large.tsx': 'x'.repeat(MAX_SOURCE_BYTES)}}}}), null);
  assert.equal(parseStoredStudioDraft({...record, base: {...base, source: {...base.source, files: {...base.source.files, '../outside.tsx': 'export {};'}}}}), null);
});
