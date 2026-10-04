import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {createExportManager} from '../packages/studio-companion/src/export-manager.mjs';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';

const compile = (filename) => ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
}).outputText;
const engineSource = compile('../src/lib/ffmpeg.ts');
const cancellationSource = compile('../src/lib/cancellation.ts');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {resolve = done;});
  return {promise, resolve};
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');

// Both production schedulers run together. Only WASM loading and the native
// renderer are replaced, so this tests cancellation ownership, not browser APIs.
function mediaQueue() {
  const engines = [];
  class FFmpeg {
    loaded = false;
    terminations = 0;
    constructor() {engines.push(this);}
    async load() {this.loaded = true;}
    terminate() {this.loaded = false; this.terminations += 1;}
  }
  const environment = {
    Error, DOMException, Blob, URL,
    fetch: async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(1)}),
  };
  const cancellation = {};
  runInNewContext(cancellationSource, {...environment, exports: cancellation});
  const api = {};
  runInNewContext(engineSource, {...environment, exports: api, require: (name) => {
    if (name === '@ffmpeg/ffmpeg') return {FFmpeg};
    if (name === '@/lib/cancellation') return cancellation;
    throw new Error(`Unexpected dependency: ${name}`);
  }});
  return {...api, engines};
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-media-isolation-'));
  const store = createProjectStore({dataDir: path.join(root, 'projects')});
  const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
  const started = deferred();
  const release = deferred();
  let renderCancels = 0;
  const runtime = {
    async prepare() {return {previewId: randomUUID()};},
    async getExportSnapshot() {return {composition, serveUrl: 'http://127.0.0.1:4180/previews/frozen/render/', inputProps: {}};},
  };
  const manager = createExportManager({store, runtime, dataDir: path.join(root, 'exports'), runRender: (args) => {
    let cancelled = false;
    const promise = (async () => {
      started.resolve();
      await release.promise;
      if (cancelled) throw new Error('Render cancelled');
      await writeFile(args.output, png);
    })();
    return {promise, cancel: () => {renderCancels += 1; cancelled = true; release.resolve();}};
  }});
  t.after(async () => {
    release.resolve();
    await manager.shutdown();
    // The only recursive cleanup target is this test's newly created temp root.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vyvyd-media-isolation-'));
    await rm(root, {recursive: true, force: true});
  });
  const project = await store.createProject({name: '독립 출력', composition});
  const start = () => manager.start(project.id, {requestId: randomUUID(), expectedRevision: project.revision,
    options: {format: 'png', width: composition.width, height: composition.height, frame: 0}});
  return {manager, project, start, started, release, renderCancels: () => renderCancels};
}

test('cancelling Remotion during an active media job leaves its WASM engine and result intact', {timeout: 15000}, async (t) => {
  const queue = mediaQueue();
  const mediaStarted = deferred();
  const releaseMedia = deferred();
  let mediaCompleted = false;
  t.after(() => releaseMedia.resolve());
  const media = queue.runFFmpegJob(async (engine) => {
    mediaStarted.resolve();
    await releaseMedia.promise;
    mediaCompleted = true;
    return engine;
  });
  await mediaStarted.promise;
  const output = await fixture(t);
  const job = await output.start();
  await output.started.promise;

  assert.equal((await output.manager.cancel(output.project.id, job.id)).state, 'cancelled');
  await output.manager.settled();
  assert.equal(output.renderCancels(), 1);
  assert.equal(mediaCompleted, false);
  assert.equal(queue.engines[0].loaded, true);
  assert.equal(queue.engines[0].terminations, 0);
  await assert.rejects(output.manager.readResult(output.project.id, job.id), {code: 'EXPORT_NOT_READY'});

  releaseMedia.resolve();
  const preservedEngine = await media;
  assert.equal(await queue.runFFmpegJob(async (engine) => engine), preservedEngine);
  assert.equal(preservedEngine.terminations, 0);
});

test('cancelling active media work leaves Remotion rendering and allows fresh media work immediately', {timeout: 15000}, async (t) => {
  const queue = mediaQueue();
  const mediaStarted = deferred();
  const releaseOldMedia = deferred();
  const controller = new AbortController();
  t.after(() => releaseOldMedia.resolve());
  const media = queue.runFFmpegJob(async () => {
    mediaStarted.resolve();
    await releaseOldMedia.promise;
    return 'late cancelled bytes';
  }, controller.signal);
  await mediaStarted.promise;
  const output = await fixture(t);
  const job = await output.start();
  await output.started.promise;

  const cancellation = assert.rejects(media, {name: 'AbortError'});
  controller.abort();
  await cancellation;
  assert.ok(queue.engines[0].terminations >= 1);
  assert.equal((await output.manager.get(output.project.id, job.id)).state, 'rendering');
  assert.equal(output.renderCancels(), 0);
  const replacement = await queue.runFFmpegJob(async (engine) => engine);
  assert.notEqual(replacement, queue.engines[0]);
  assert.equal(replacement.loaded, true);

  output.release.resolve();
  await output.manager.settled();
  assert.equal((await output.manager.get(output.project.id, job.id)).state, 'completed');
  assert.equal(output.renderCancels(), 0);
  assert.deepEqual(await readFile((await output.manager.readResult(output.project.id, job.id)).path), png);
  releaseOldMedia.resolve();
  assert.equal(replacement.terminations, 0);
});
