import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createProjectStore, StudioStoreError} from '../packages/studio-companion/src/project-store.mjs';
import {createStudioController} from '../packages/studio-companion/src/studio-controller.mjs';

const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
const argsFor = (project, files) => ({projectId: project.id, expectedRevision: project.revision, requestId: randomUUID(), files, deleteFiles: []});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {resolve = done;});
  return {promise, resolve};
};
const fixture = async (t, onPrepare) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-codex-review-'));
  const store = createProjectStore({dataDir});
  let prepareCount = 0;
  const runtime = {
    async prepare(project) {
      prepareCount++;
      await onPrepare?.(project, prepareCount);
      const previewId = randomUUID();
      return {previewId, previewUrl: `http://127.0.0.1:4180/previews/${previewId}/index.html`, composition: project.composition};
    },
  };
  const controller = createStudioController({store, runtime});
  t.after(async () => {await controller.settled(); await rm(dataDir, {recursive: true, force: true});});
  const project = await store.createProject({name: '리뷰 검증 프로젝트', composition});
  return {store, controller, project, prepareCount: () => prepareCount};
};

test('same in-flight request validates once and a concurrent different source cannot replace it', async (t) => {
  const entered = deferred();
  const release = deferred();
  const {store, controller, project, prepareCount} = await fixture(t, async () => {entered.resolve(); await release.promise;});
  const files = {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// first`};
  const args = argsFor(project, files);
  const first = controller.tool('studio_apply_source', args, 'review-client');
  await entered.promise;
  const duplicate = controller.tool('studio_apply_source', {...args, projectId: project.id.toUpperCase(), requestId: args.requestId.toUpperCase()}, 'review-client');
  await assert.rejects(controller.tool('studio_apply_source', {...args, files: {'src/Root.tsx': `${files['src/Root.tsx']}\n// different`}}, 'review-client'), {code: 'REQUEST_ID_REUSED'});
  release.resolve();
  const [applied, repeated] = await Promise.all([first, duplicate]);
  assert.deepEqual(applied, repeated);
  assert.equal(prepareCount(), 1);
  assert.equal((await store.readProject(project.id)).revision, 2);
  assert.equal((await store.getRequest(project.id, args.requestId)).revision, 2);
});

test('two independent validated mutations at one revision commit only one source snapshot', async (t) => {
  const bothEntered = deferred();
  const release = deferred();
  let entered = 0;
  const {store, controller, project} = await fixture(t, async () => {if (++entered === 2) bothEntered.resolve(); await release.promise;});
  const firstArgs = argsFor(project, {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// first source`});
  const secondArgs = argsFor(project, {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// second source`});
  const first = controller.tool('studio_apply_source', firstArgs, 'review-client');
  const second = controller.tool('studio_apply_source', secondArgs, 'review-client');
  await bothEntered.promise;
  release.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const winner = results[0].status === 'fulfilled' ? firstArgs : secondArgs;
  const loser = winner === firstArgs ? secondArgs : firstArgs;
  const saved = await store.readProject(project.id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.source.files['src/Root.tsx'], winner.files['src/Root.tsx']);
  assert.equal((await store.getRequest(project.id, winner.requestId)).revision, 2);
  assert.equal(await store.getRequest(project.id, loser.requestId), null);
  const status = await controller.status(project.id);
  assert.equal(status.compile.state, 'ready');
  assert.equal(status.compile.revision, 2);
});

test('commit failure after successful compilation keeps the previous preview and no receipt', async (t) => {
  const {store, controller, project} = await fixture(t);
  const first = await controller.tool('studio_apply_source', argsFor(project, {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// valid`}), 'review-client');
  const before = await store.readProject(project.id);
  const args = argsFor(before, {'src/Root.tsx': `${before.source.files['src/Root.tsx']}\n// cannot commit`});
  const originalUpdate = store.updateProject;
  store.updateProject = async () => {throw new StudioStoreError('DISK_WRITE_FAILED', '테스트 저장 실패', 500);};
  t.after(() => {store.updateProject = originalUpdate;});
  await assert.rejects(controller.tool('studio_apply_source', args, 'review-client'), {code: 'DISK_WRITE_FAILED'});
  assert.deepEqual(await store.readProject(project.id), before);
  assert.equal(await store.getRequest(project.id, args.requestId), null);
  const status = await controller.status(project.id);
  assert.equal(status.compile.state, 'failed');
  assert.equal(status.compile.previewUrl, first.compile.previewUrl);
  assert.equal(status.compile.revision, before.revision);
});

test('browser saves enforce the same registered layer capabilities as Codex edits', async (t) => {
  const {store, controller, project} = await fixture(t);
  await controller.tool('studio_apply_source', argsFor(project, {
    'src/layers.json': JSON.stringify([{id: 'title', type: 'text', label: '제목', editable: ['text'], defaults: {text: '기본 문구'}}]),
  }), 'review-client');
  const current = await store.readProject(project.id);
  const invalid = {...current, edits: {...current.edits, layers: {title: {rotation: 10}}}};
  await assert.rejects(controller.save(project.id, {expectedRevision: current.revision, project: invalid}), {code: 'INVALID_LAYERS'});
  assert.deepEqual(await store.readProject(project.id), current);
});
