import assert from 'node:assert/strict';
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
    exports: api,
    Blob,
    DOMException,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return api;
};

const cancellation = loadModule(compile('cancellation'));
const geometry = loadModule(compile('videoGeometry'));
const settings = loadModule(compile('videoSettings'), { './videoGeometry': geometry });
const conversionSource = compile('convertVideo');
const gifBytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
const stages = ['fetch', 'write', 'palette', 'render', 'result'];

// Exercise the real conversion and validation with mocked file I/O and engine calls.
// Queue scheduling and filter geometry have their own tests.
const harness = ({ rejectAt, nonzeroAt, cancelAt, result = gifBytes, deleteFails = false } = {}) => {
  const controller = new AbortController();
  const calls = [];
  const commands = [];
  const deleted = [];
  const queueRequests = [];
  const progress = [];
  const file = { name: 'portrait.mp4' };
  const input = {
    file, width: 1080, height: 1920, duration: 4,
    settings: settings.createVideoSettings({ width: 1080, height: 1920, duration: 4 }),
  };
  const step = (stage) => {
    calls.push(stage);
    if (cancelAt === stage) controller.abort();
    if (rejectAt === stage) throw new Error(`Mock ${stage} failure`);
  };
  const engine = {
    loaded: true,
    writeFile: async () => { step('write'); },
    exec: async (args) => {
      commands.push(args);
      const stage = args.includes('-vf') ? 'palette' : 'render';
      step(stage);
      return nonzeroAt === stage ? 1 : 0;
    },
    readFile: async () => { step('result'); return result; },
    deleteFile: async (name) => {
      deleted.push(name);
      if (deleteFails) throw new Error('File was never created');
    },
  };
  const api = loadModule(conversionSource, {
    './cancellation': cancellation,
    './videoGeometry': geometry,
    './videoSettings': settings,
    '@ffmpeg/util': {
      fetchFile: async (receivedFile) => {
        assert.equal(receivedFile, file);
        step('fetch');
        return new Uint8Array([1, 2, 3]);
      },
    },
    './ffmpeg': {
      runFFmpegJob: async (job, signal, onProgress, resetOnError) => {
        queueRequests.push({ signal, onProgress, resetOnError });
        return job(engine);
      },
    },
  });
  const onProgress = (message) => progress.push(message);
  const options = { fps: 12, dither: 'bayer', signal: controller.signal, onProgress };

  return {
    controller, calls, commands, deleted, queueRequests, progress, input, options,
    convert: () => api.convertVideoToGif(input, options),
  };
};

const assertCleaned = (subject) => {
  assert.equal(subject.deleted.length, 3);
  assert.equal(new Set(subject.deleted).size, 3);
  assert.deepEqual(subject.deleted.map((name) => name.split('.').at(-1)).sort(), ['gif', 'mp4', 'png']);
};

test('successful conversion returns GIF bytes, reports stages, and requests queue error recovery', async () => {
  const subject = harness();
  const result = await subject.convert();

  assert.ok(result instanceof Blob);
  assert.equal(result.type, 'image/gif');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), gifBytes);
  assert.deepEqual(subject.calls, stages);
  assert.equal(subject.queueRequests.length, 1);
  assert.equal(subject.queueRequests[0].signal, subject.options.signal);
  assert.equal(subject.queueRequests[0].onProgress, subject.options.onProgress);
  assert.equal(subject.queueRequests[0].resetOnError, true);
  assert.match(subject.progress[0], /파일 읽는 중/);
  assert.match(subject.progress[1], /팔레트 생성 중/);
  assert.match(subject.progress[2], /GIF 렌더링 중/);
  assert.match(subject.progress[3], /결과 읽는 중/);
  assertCleaned(subject);
});

for (const [stage, message] of [
  ['fetch', /영상 파일을 읽지 못했습니다/],
  ['write', /영상 파일을 읽지 못했습니다/],
  ['palette', /색상 팔레트를 만들지 못했습니다/],
  ['render', /GIF 렌더링에 실패했습니다/],
  ['result', /변환 결과를 읽지 못했습니다/],
]) {
  test(`${stage} rejection reports its stage, stops conversion, and cleans temporary files`, async () => {
    const subject = harness({ rejectAt: stage });
    await assert.rejects(subject.convert(), message);
    assert.deepEqual(subject.calls, stages.slice(0, stages.indexOf(stage) + 1));
    assertCleaned(subject);
  });
}

for (const [stage, message] of [
  ['palette', /색상 팔레트를 만들지 못했습니다/],
  ['render', /GIF 렌더링에 실패했습니다/],
]) {
  test(`a nonzero ${stage} exit code is a failure even when exec resolves`, async () => {
    const subject = harness({ nonzeroAt: stage });
    await assert.rejects(subject.convert(), message);
    assert.deepEqual(subject.calls, stages.slice(0, stages.indexOf(stage) + 1));
    assertCleaned(subject);
  });
}

for (const [label, result] of [['empty bytes', new Uint8Array()], ['text', 'GIF89a']]) {
  test(`readFile returning ${label} cannot produce a successful GIF`, async () => {
    const subject = harness({ result });
    await assert.rejects(subject.convert(), /변환 결과를 읽지 못했습니다/);
    assertCleaned(subject);
  });
}

test('a signal aborted before conversion prevents queue and file I/O access', async () => {
  const subject = harness();
  subject.controller.abort();
  await assert.rejects(subject.convert(), { name: 'AbortError' });
  assert.equal(subject.queueRequests.length, 0);
  assert.deepEqual(subject.calls, []);
  assert.deepEqual(subject.deleted, []);
});

for (const stage of stages) {
  test(`cancellation during ${stage} propagates AbortError without further engine calls`, async () => {
    const subject = harness({ cancelAt: stage });
    await assert.rejects(subject.convert(), { name: 'AbortError' });
    assert.deepEqual(subject.calls, stages.slice(0, stages.indexOf(stage) + 1));
    assert.deepEqual(subject.deleted, []);
  });
}

test('cleanup failures do not hide the original conversion error', async () => {
  const subject = harness({ rejectAt: 'palette', deleteFails: true });
  await assert.rejects(subject.convert(), /색상 팔레트를 만들지 못했습니다/);
  assertCleaned(subject);
});

test('cleanup failures do not discard a successfully converted Blob', async () => {
  const subject = harness({ deleteFails: true });
  assert.equal((await subject.convert()).size, gifBytes.byteLength);
  assertCleaned(subject);
});

test('manual palette remains unchanged and automatic color limits reach the encoder', async () => {
  const manual = harness();
  await manual.convert();
  assert.match(manual.commands[0].join(' '), /palettegen=stats_mode=diff:reserve_transparent=1/);
  assert.doesNotMatch(manual.commands[0].join(' '), /max_colors/);
  const automatic = harness();
  automatic.options.colors = 64;
  await automatic.convert();
  assert.match(automatic.commands[0].join(' '), /max_colors=64/);
  assertCleaned(automatic);
});

for (const colors of [0, 31, 257, 32.5, NaN, Infinity]) {
  test(`invalid palette color count ${colors} prevents queue and encoder access`, async () => {
    const subject = harness();
    subject.options.colors = colors;
    await assert.rejects(subject.convert(), /색상/);
    assert.equal(subject.queueRequests.length, 0);
    assert.deepEqual(subject.calls, []);
  });
}
