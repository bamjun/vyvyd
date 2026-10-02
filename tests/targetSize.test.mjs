import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = (name) => ts.transpileModule(
  readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

const loadModule = (source, dependencies = {}) => {
  const api = {};
  runInNewContext(source, {
    exports: api, Blob, DOMException, Error,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return api;
};

const cancellation = loadModule(compile('cancellation'));
const api = loadModule(compile('targetSize'), {
  './cancellation': cancellation, '@/lib/cancellation': cancellation,
});
const { parseTargetSize, optimizeToTargetSize, MAX_OPTIMIZATION_ATTEMPTS } = api;
const plain = (value) => JSON.parse(JSON.stringify(value));
const sizedBlob = (size, marker = 1) => new Blob([new Uint8Array(size).fill(marker)], { type: 'image/gif' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const initial = () => ({ width: 640, height: 360, quality: 0.85, colors: 256, fps: 12 });

test('target size parsing converts decimal KB and MB into bytes within the supported limits', () => {
  assert.equal(parseTargetSize('1', 'KB'), 1024);
  assert.equal(parseTargetSize(' 1.5 ', 'KB'), 1536);
  assert.equal(parseTargetSize('0.5', 'MB'), 524288);
  assert.equal(parseTargetSize('2', 'MB'), 2097152);
  assert.equal(parseTargetSize('100', 'MB'), 104857600);
});

test('empty, malformed, nonfinite and out-of-range target sizes are rejected', () => {
  for (const value of ['', ' ', 'abc', '12KB', '1,024', 'NaN', 'Infinity', '-1', '0', '0.5']) {
    assert.equal(parseTargetSize(value, 'KB'), null, value);
  }
  assert.equal(parseTargetSize('100.01', 'MB'), null);
  assert.equal(parseTargetSize('102401', 'KB'), null);
});

test('a result that already meets the target stops after its first actual encode', async () => {
  const settings = initial();
  const original = { ...settings };
  const expected = sizedBlob(1024);
  const calls = [];
  const result = await optimizeToTargetSize({
    targetBytes: 2048, initial: settings,
    encode: async (next, attempt) => { calls.push([plain(next), attempt]); return expected; },
  });

  assert.equal(result.blob, expected);
  assert.equal(result.metTarget, true);
  assert.equal(result.targetBytes, 2048);
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(result.settings), original);
  assert.deepEqual(settings, original);
});

test('the exact target boundary is a successful result and performs no further encode', async () => {
  let calls = 0;
  const result = await optimizeToTargetSize({
    targetBytes: 4096, initial: { width: 100, height: 50 },
    encode: async () => { calls += 1; return sizedBlob(4096); },
  });
  assert.equal(result.metTarget, true);
  assert.equal(result.blob.size, 4096);
  assert.equal(calls, 1);
});

test('the first measured candidate that fits is returned with the settings that created it', async () => {
  const calls = [];
  const candidates = [sizedBlob(20000, 1), sizedBlob(10000, 2), sizedBlob(4000, 3)];
  const result = await optimizeToTargetSize({
    targetBytes: 4096, initial: initial(),
    encode: async (settings) => {
      calls.push(plain(settings));
      return candidates[calls.length - 1];
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.blob, candidates[2]);
  assert.equal(result.metTarget, true);
  assert.deepEqual(plain(result.settings), calls[2]);
});

test('a nonmonotonic size curve returns the smallest measured Blob and its matching settings', async () => {
  const calls = [];
  const candidates = [];
  const result = await optimizeToTargetSize({
    targetBytes: 1024, initial: initial(),
    encode: async (settings) => {
      calls.push(plain(settings));
      const candidate = sizedBlob(calls.length === 3 ? 2500 : 6000 + calls.length, calls.length);
      candidates.push(candidate);
      return candidate;
    },
  });
  assert.ok(calls.length >= 3);
  assert.ok(calls.length <= MAX_OPTIMIZATION_ATTEMPTS);
  assert.equal(result.metTarget, false);
  assert.equal(result.attempts, calls.length);
  assert.equal(result.blob, candidates[2]);
  assert.deepEqual(plain(result.settings), calls[2]);
});

test('every oversized attempt stays within bounds, keeps aspect ratio and never enlarges the input', async () => {
  const original = initial();
  const immutable = Object.freeze({ ...original });
  const calls = [];
  const result = await optimizeToTargetSize({
    targetBytes: 1024, initial: immutable,
    encode: async (settings) => { calls.push(plain(settings)); return sizedBlob(1000000); },
  });
  assert.equal(MAX_OPTIMIZATION_ATTEMPTS, 12);
  assert.ok(calls.length > 1 && calls.length <= MAX_OPTIMIZATION_ATTEMPTS);
  assert.equal(result.attempts, calls.length);
  assert.equal(result.metTarget, false);
  assert.deepEqual(immutable, original);
  for (const [index, settings] of calls.entries()) {
    assert.ok(Number.isInteger(settings.width) && settings.width >= 1 && settings.width <= original.width);
    assert.ok(Number.isInteger(settings.height) && settings.height >= 1 && settings.height <= original.height);
    assert.ok(settings.quality >= 0.45 && settings.quality <= original.quality);
    assert.ok(Number.isInteger(settings.colors) && settings.colors >= 32 && settings.colors <= original.colors);
    assert.ok(settings.fps >= 6 && settings.fps <= original.fps);
    // Rounding either axis by at most one pixel preserves the original aspect ratio.
    assert.ok(Math.abs(settings.height - settings.width * original.height / original.width) <= 1);
    if (index > 0) {
      for (const key of ['width', 'height', 'quality', 'colors', 'fps']) {
        assert.ok(settings[key] <= calls[index - 1][key], `${key} should never increase`);
      }
    }
  }
  assert.ok(calls.some((settings) => settings.width < original.width));
});

test('quality and FPS below normal floors and a minimum palette are never increased', async () => {
  const calls = [];
  const original = { width: 100, height: 50, quality: 0.3, colors: 32, fps: 3 };
  await optimizeToTargetSize({
    targetBytes: 1024, initial: original,
    encode: async (settings) => { calls.push(plain(settings)); return sizedBlob(20000); },
  });
  for (const settings of calls) {
    assert.ok(settings.quality <= original.quality);
    assert.ok(settings.colors <= original.colors);
    assert.ok(settings.fps <= original.fps);
  }
});

test('dimensions can shrink when the encoder has no quality, palette or FPS control', async () => {
  const calls = [];
  const result = await optimizeToTargetSize({
    targetBytes: 1024, initial: { width: 320, height: 180 },
    encode: async (settings) => {
      calls.push(plain(settings));
      return sizedBlob(settings.width * settings.height);
    },
  });
  assert.ok(calls.length > 1);
  assert.ok(calls[1].width < calls[0].width);
  assert.ok(result.blob.size <= 1024 || result.attempts === MAX_OPTIMIZATION_ATTEMPTS);
  assert.equal('quality' in result.settings, false);
  assert.equal('colors' in result.settings, false);
  assert.equal('fps' in result.settings, false);
});

test('an irreducible one-pixel result stops rather than re-encoding duplicate settings', async () => {
  let calls = 0;
  const blob = sizedBlob(4096);
  const result = await optimizeToTargetSize({
    targetBytes: 1024, initial: { width: 1, height: 1, quality: 0.45, colors: 32, fps: 1 },
    encode: async () => { calls += 1; return blob; },
  });
  assert.equal(result.metTarget, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.blob, blob);
  assert.equal(calls, 1);
});

test('malformed targets and settings cannot reach the encoder', async () => {
  let calls = 0;
  const encode = async () => { calls += 1; return sizedBlob(1024); };
  for (const targetBytes of [0, -1, NaN, Infinity, 512, 1024.5, 104857601]) {
    await assert.rejects(optimizeToTargetSize({ targetBytes, initial: initial(), encode }));
  }
  for (const settings of [
    { width: 0, height: 10 }, { width: 10, height: -1 },
    { width: NaN, height: 10 }, { width: 10, height: Infinity },
    { width: 1.5, height: 10 }, { width: 10, height: 10, quality: NaN },
    { width: 10, height: 10, quality: 1.1 }, { width: 10, height: 10, colors: 0 },
    { width: 10, height: 10, colors: 16 }, { width: 10, height: 10, colors: 257 },
    { width: 10, height: 10, fps: 0 }, { width: 10, height: 10, fps: 31 },
    { width: 10, height: 10, fps: Infinity },
  ]) {
    await assert.rejects(optimizeToTargetSize({ targetBytes: 1024, initial: settings, encode }));
  }
  assert.equal(calls, 0);
});

test('a signal aborted before optimization prevents progress and encoding', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  let progress = 0;
  await assert.rejects(optimizeToTargetSize({
    targetBytes: 1024, initial: initial(), signal: controller.signal,
    onProgress: () => { progress += 1; },
    encode: async () => { calls += 1; return sizedBlob(500); },
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(progress, 0);
});

test('cancellation while encoding rejects after encode settles even if the candidate meets the target', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const finish = deferred();
  let calls = 0;
  const pending = optimizeToTargetSize({
    targetBytes: 1024, initial: initial(), signal: controller.signal,
    encode: async () => { calls += 1; entered.resolve(); return finish.promise; },
  });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  finish.resolve(sizedBlob(500));
  await rejection;
  assert.equal(calls, 1);
});

test('cancellation from progress is checked before invoking the next encoder', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(optimizeToTargetSize({
    targetBytes: 1024, initial: initial(), signal: controller.signal,
    onProgress: () => { controller.abort(); },
    encode: async () => { calls += 1; return sizedBlob(10000); },
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('encoding failures propagate intact without retries or a synthetic successful result', async () => {
  const failure = new Error('Encoder ran out of memory');
  let calls = 0;
  await assert.rejects(optimizeToTargetSize({
    targetBytes: 1024, initial: initial(),
    encode: async () => { calls += 1; throw failure; },
  }), (error) => error === failure);
  assert.equal(calls, 1);
});

test('empty output is rejected rather than accepted as an under-target result', async () => {
  let calls = 0;
  await assert.rejects(optimizeToTargetSize({
    targetBytes: 1024, initial: initial(),
    encode: async () => { calls += 1; return new Blob(); },
  }));
  assert.equal(calls, 1);
});
