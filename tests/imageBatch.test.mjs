import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const load = (path, dependencies = {}) => {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const api = {};
  runInNewContext(outputText, { exports: api, Error, DOMException, require: (name) => {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  return api;
};
const cancellation = load('../src/lib/cancellation.ts');
const { runImageBatch, selectImageBatchItems, collectImageBatchParts } = load('../src/lib/imageBatch.ts', { './cancellation': cancellation });
const plain = (value) => JSON.parse(JSON.stringify(value));
const files = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('a failed image is reported while later images continue in order', async () => {
  const outcomes = [];
  await runImageBatch({
    items: files, signal: new AbortController().signal,
    convert: async (file) => {
      if (file.id === 'b') throw new Error('이미지 인코딩 실패');
      return `result:${file.id}`;
    },
    onOutcome: (file, outcome) => outcomes.push({ id: file.id, ...plain(outcome) }),
  });
  assert.deepEqual(outcomes, [
    { id: 'a', status: 'succeeded', result: 'result:a' },
    { id: 'b', status: 'failed', message: '이미지 인코딩 실패' },
    { id: 'c', status: 'succeeded', result: 'result:c' },
  ]);
});

test('non-Error failures use a useful image-specific message and do not reject the batch', async () => {
  const outcomes = [];
  await runImageBatch({ items: files, signal: new AbortController().signal,
    convert: async () => { throw null; }, onOutcome: (_file, outcome) => outcomes.push(outcome),
  });
  assert.equal(outcomes.length, files.length);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.message, /이미지/);
  }
});

test('failed-only and individual retries retain previous successes and untouched failures', async () => {
  const states = {};
  const results = new Map();
  const calls = [];
  let firstRun = true;
  const run = (targets) => runImageBatch({ items: targets, signal: new AbortController().signal,
    convert: async (file) => {
      calls.push(file.id);
      if (firstRun && file.id !== 'b') throw new Error('다시 시도');
      return { url: `blob:${file.id}:${calls.length}` };
    },
    onOutcome: (file, outcome) => {
      states[file.id] = outcome;
      if (outcome.status === 'succeeded') results.set(file.id, outcome.result);
    },
  });
  await run(files);
  firstRun = false;
  const savedSuccess = results.get('b');
  const untouchedFailure = states.c;
  await run(selectImageBatchItems(files, states, 'failed', 'a'));
  assert.equal(results.get('b'), savedSuccess);
  assert.equal(states.c, untouchedFailure);
  assert.deepEqual(calls, ['a', 'b', 'c', 'a']);
  await run(selectImageBatchItems(files, states, 'failed'));
  assert.equal(results.get('b'), savedSuccess);
  assert.deepEqual(calls, ['a', 'b', 'c', 'a', 'c']);
  assert.deepEqual([...results.keys()].sort(), ['a', 'b', 'c']);
});

test('resume includes cancelled, waiting and newly transferred files without retrying failures or successes', () => {
  const items = [...files, { id: 'd' }, { id: 'new-transfer' }];
  const states = Object.freeze({ a: { status: 'succeeded' }, b: { status: 'failed', message: '오류' }, c: { status: 'cancelled' }, d: { status: 'waiting' } });
  assert.deepEqual(plain(selectImageBatchItems(items, states, 'remaining')).map((file) => file.id), ['c', 'd', 'new-transfer']);
  assert.deepEqual(plain(selectImageBatchItems(items, states, 'failed')).map((file) => file.id), ['b']);
  assert.deepEqual(plain(selectImageBatchItems(items, states, 'all')).map((file) => file.id), items.map((file) => file.id));
  assert.deepEqual(plain(selectImageBatchItems(items, states, 'failed', 'a')), []);
});

test('cancelling during conversion discards a late result and never starts subsequent files', async () => {
  const controller = new AbortController();
  const started = [];
  const outcomes = [];
  const discarded = [];
  await assert.rejects(runImageBatch({ items: files, signal: controller.signal,
    onStart: (file) => started.push(file.id),
    convert: async () => { controller.abort(); return 'unpublished-result'; },
    onDiscardResult: (result) => discarded.push(result),
    onOutcome: (file, outcome) => outcomes.push({ id: file.id, ...plain(outcome) }),
  }), { name: 'AbortError' });
  assert.deepEqual(started, ['a']);
  assert.deepEqual(discarded, ['unpublished-result']);
  assert.deepEqual(outcomes, [{ id: 'a', status: 'cancelled' }]);
});

test('an already cancelled batch invokes no conversion or status callbacks', async () => {
  const controller = new AbortController();
  controller.abort();
  const events = [];
  await assert.rejects(runImageBatch({ items: files, signal: controller.signal,
    convert: async () => { events.push('convert'); }, onStart: () => events.push('start'), onOutcome: () => events.push('outcome'),
  }), { name: 'AbortError' });
  assert.deepEqual(events, []);
});

test('split parts publish atomically: a failed middle part leaves no partial output and retry publishes each part once', async () => {
  const states = {};
  const published = [];
  const createdUrls = [];
  const attempts = new Map();
  const run = (targets) => runImageBatch({ items: targets, signal: new AbortController().signal,
    convert: async (file) => {
      const attempt = (attempts.get(file.id) ?? 0) + 1;
      attempts.set(file.id, attempt);
      return collectImageBatchParts([0, 1, 2], new AbortController().signal, async (part) => {
        if (file.id === 'b' && attempt === 1 && part === 1) throw new Error('두 번째 조각 실패');
        return `${file.id}:${part}`;
      });
    },
    onOutcome: (file, outcome) => {
      states[file.id] = outcome;
      if (outcome.status === 'succeeded') {
        outcome.result.forEach((part) => { createdUrls.push(`blob:${part}`); published.push(part); });
      }
    },
  });
  await run(files);
  assert.deepEqual(published, ['a:0', 'a:1', 'a:2', 'c:0', 'c:1', 'c:2']);
  assert.equal(createdUrls.some((url) => url.startsWith('blob:b:')), false);
  await run(selectImageBatchItems(files, states, 'failed'));
  assert.deepEqual(published.slice(6), ['b:0', 'b:1', 'b:2']);
  assert.equal(new Set(published).size, published.length);
});

test('cancelling part encoding publishes neither the current source nor later files', async () => {
  const controller = new AbortController();
  const outcomes = [];
  const encoded = [];
  await assert.rejects(runImageBatch({ items: files, signal: controller.signal,
    convert: (file) => collectImageBatchParts([0, 1, 2], controller.signal, async (part) => {
      encoded.push(`${file.id}:${part}`);
      if (part === 1) controller.abort();
      return part;
    }),
    onOutcome: (file, outcome) => outcomes.push({ id: file.id, ...plain(outcome) }),
  }), { name: 'AbortError' });
  assert.deepEqual(encoded, ['a:0', 'a:1']);
  assert.deepEqual(outcomes, [{ id: 'a', status: 'cancelled' }]);
});
