import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const engineSource = compile('../src/lib/ffmpeg.ts');
const cancellationSource = compile('../src/lib/cancellation.ts');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Exercise the real scheduler and loader without downloading WASM or starting workers.
const harness = (fetchOverride) => {
  const instances = [];
  const createdUrls = [];
  const revokedUrls = [];
  class FFmpeg {
    loaded = false;
    terminations = 0;
    constructor() { instances.push(this); }
    async load() { this.loaded = true; }
    terminate() { this.loaded = false; this.terminations += 1; }
  }
  const environment = {
    DOMException, Blob,
    URL: {
      createObjectURL: () => {
        const url = `blob:test-${createdUrls.length}`;
        createdUrls.push(url);
        return url;
      },
      revokeObjectURL: (url) => revokedUrls.push(url),
    },
    fetch: fetchOverride ?? (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })),
  };
  const cancellation = {};
  runInNewContext(cancellationSource, { ...environment, exports: cancellation });
  const api = {};
  runInNewContext(engineSource, {
    ...environment,
    exports: api,
    require: (name) => {
      if (name === '@ffmpeg/ffmpeg') return { FFmpeg };
      if (name === '@/lib/cancellation') return cancellation;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { ...api, instances, createdUrls, revokedUrls };
};

test('jobs from different tools run in FIFO order and reuse the loaded engine', async () => {
  const queue = harness();
  const started = deferred();
  const release = deferred();
  const events = [];
  const first = queue.runFFmpegJob(async () => {
    events.push('video start');
    started.resolve();
    await release.promise;
    events.push('video end');
  });
  await started.promise;
  const second = queue.runFFmpegJob(async () => { events.push('image start'); });
  await Promise.resolve();
  assert.deepEqual(events, ['video start']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['video start', 'video end', 'image start']);
  assert.equal(queue.instances.length, 1);
  assert.deepEqual(queue.revokedUrls, queue.createdUrls);
});

test('cancelling a queued job returns immediately without stopping the active job', async () => {
  const queue = harness();
  const started = deferred();
  const release = deferred();
  const first = queue.runFFmpegJob(async () => { started.resolve(); await release.promise; return 'first'; });
  await started.promise;
  const controller = new AbortController();
  let ran = false;
  const second = queue.runFFmpegJob(async () => { ran = true; }, controller.signal);
  const cancelled = assert.rejects(second, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  assert.equal(queue.instances[0].terminations, 0);
  release.resolve();
  assert.equal(await first, 'first');
  assert.equal(await queue.runFFmpegJob(async () => 'third'), 'third');
  assert.equal(ran, false);
});

test('active cancellation releases the queue with a new engine while old file I/O settles', async () => {
  const queue = harness();
  const started = deferred();
  const releaseOld = deferred();
  const oldFinished = deferred();
  const controller = new AbortController();
  let oldEngine;
  const first = queue.runFFmpegJob(async (ffmpeg) => {
    oldEngine = ffmpeg;
    started.resolve();
    await releaseOld.promise;
    oldFinished.resolve();
    return 'stale result';
  }, controller.signal);
  await started.promise;
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  const newEngine = await queue.runFFmpegJob(async (ffmpeg) => ffmpeg);
  assert.notEqual(newEngine, oldEngine);
  assert.equal(oldEngine.loaded, false);
  assert.equal(newEngine.loaded, true);
  releaseOld.resolve();
  await oldFinished.promise;
  assert.equal(await queue.runFFmpegJob(async (ffmpeg) => ffmpeg), newEngine);
  assert.equal(newEngine.terminations, 0);
});

test('cancellation during WASM download aborts loading and the next job can retry', async () => {
  const downloading = deferred();
  let calls = 0;
  const queue = harness(async (_url, { signal }) => {
    calls += 1;
    if (calls === 2) {
      downloading.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  });
  const controller = new AbortController();
  let ran = false;
  const pending = queue.runFFmpegJob(async () => { ran = true; }, controller.signal);
  await downloading.promise;
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  assert.equal(await queue.runFFmpegJob(async () => 'retried'), 'retried');
  assert.equal(ran, false);
  assert.deepEqual(queue.revokedUrls, queue.createdUrls);
});

test('a failed job does not block subsequent jobs', async () => {
  const queue = harness();
  await assert.rejects(queue.runFFmpegJob(async () => { throw new Error('bad file'); }), /bad file/);
  assert.equal(await queue.runFFmpegJob(async () => 'next file'), 'next file');
});

test('a failed video job discards its engine before the next file and never terminates its successor', async () => {
  const queue = harness();
  const controller = new AbortController();
  await assert.rejects(queue.runFFmpegJob(async () => { throw new Error('WASM encode failed'); }, controller.signal, undefined, true), /WASM encode failed/);
  const brokenEngine = queue.instances[0];
  assert.equal(brokenEngine.terminations, 1);
  assert.equal(brokenEngine.loaded, false);
  const nextEngine = await queue.runFFmpegJob(async (ffmpeg) => ffmpeg);
  assert.notEqual(nextEngine, brokenEngine);
  assert.equal(nextEngine.loaded, true);
  controller.abort();
  assert.equal(nextEngine.terminations, 0);
});

test('aborting a completed job cannot terminate an engine reused by a later job', async () => {
  const queue = harness();
  const controller = new AbortController();
  await queue.runFFmpegJob(async () => 'done', controller.signal);
  const started = deferred();
  const release = deferred();
  const next = queue.runFFmpegJob(async () => { started.resolve(); await release.promise; });
  await started.promise;
  controller.abort();
  assert.equal(queue.instances[0].terminations, 0);
  release.resolve();
  await next;
});
