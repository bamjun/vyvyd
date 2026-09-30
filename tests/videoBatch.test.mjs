import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const loadModule = (path, dependencies = {}) => {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const api = {};
  runInNewContext(outputText, {
    exports: api,
    Error,
    DOMException,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return api;
};

const cancellation = loadModule('../src/lib/cancellation.ts');
const { runVideoBatch } = loadModule('../src/lib/videoBatch.ts', {
  './cancellation': cancellation,
  '@/lib/cancellation': cancellation,
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const files = Object.freeze([
  Object.freeze({ id: 'a' }), Object.freeze({ id: 'b' }), Object.freeze({ id: 'c' }),
]);

test('a failed middle file reports its error and later files still succeed in order', async () => {
  const events = [];
  const outcomes = [];
  await runVideoBatch({
    items: files,
    signal: new AbortController().signal,
    onStart: (item, index) => events.push(`start:${item.id}:${index}`),
    convert: async (item, index) => {
      events.push(`convert:${item.id}:${index}`);
      if (item.id === 'b') throw new Error('지원하지 않는 영상입니다.');
      return { id: item.id, url: `blob:${item.id}` };
    },
    onOutcome: (item, outcome) => {
      events.push(`outcome:${item.id}:${outcome.status}`);
      outcomes.push({ id: item.id, ...plain(outcome) });
    },
  });

  assert.deepEqual(events, [
    'start:a:0', 'convert:a:0', 'outcome:a:succeeded',
    'start:b:1', 'convert:b:1', 'outcome:b:failed',
    'start:c:2', 'convert:c:2', 'outcome:c:succeeded',
  ]);
  assert.deepEqual(outcomes, [
    { id: 'a', status: 'succeeded', result: { id: 'a', url: 'blob:a' } },
    { id: 'b', status: 'failed', message: '지원하지 않는 영상입니다.' },
    { id: 'c', status: 'succeeded', result: { id: 'c', url: 'blob:c' } },
  ]);
});

test('first, last and all-file failures complete the batch with one outcome per item', async (t) => {
  for (const failedIds of [['a'], ['c'], ['a', 'b', 'c']]) {
    await t.test(`failed: ${failedIds.join(', ')}`, async () => {
      const outcomes = [];
      await runVideoBatch({
        items: files,
        signal: new AbortController().signal,
        convert: async (item) => {
          if (failedIds.includes(item.id)) throw new Error(`실패 ${item.id}`);
          return item.id;
        },
        onOutcome: (item, outcome) => outcomes.push([item.id, outcome.status]),
      });
      assert.deepEqual(outcomes, files.map(({ id }) => [id, failedIds.includes(id) ? 'failed' : 'succeeded']));
    });
  }
});

test('non-Error failures receive a nonempty Korean fallback without stopping later files', async () => {
  for (const thrown of ['ffmpeg failed', undefined, null, { message: 'not an Error' }]) {
    const outcomes = [];
    await runVideoBatch({
      items: files.slice(0, 2),
      signal: new AbortController().signal,
      convert: async (item) => {
        if (item.id === 'a') throw thrown;
        return item.id;
      },
      onOutcome: (_item, outcome) => outcomes.push(outcome),
    });
    assert.equal(outcomes[0].status, 'failed');
    assert.match(outcomes[0].message, /[가-힣]/);
    assert.deepEqual(plain(outcomes[1]), { status: 'succeeded', result: 'b' });
  }
});

const retryModel = async () => {
  const state = new Map();
  const calls = [];
  const attempts = new Map();
  const run = (items) => runVideoBatch({
    items,
    signal: new AbortController().signal,
    convert: async (item) => {
      calls.push(item.id);
      const attempt = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, attempt);
      if (item.id !== 'b' && attempt === 1) throw new Error('다시 시도해 주세요.');
      return { id: item.id, url: `blob:${item.id}-${attempt}` };
    },
    onOutcome: (item, outcome) => state.set(item.id, outcome),
  });
  await run(files);
  return { state, calls, run };
};

test('retrying all failed items leaves existing successful results intact', async () => {
  const model = await retryModel();
  const saved = model.state.get('b');
  const failed = files.filter((item) => model.state.get(item.id).status === 'failed');
  await model.run(failed);

  assert.deepEqual(model.calls, ['a', 'b', 'c', 'a', 'c']);
  assert.equal(model.state.get('b'), saved);
  assert.equal(model.state.get('b').result.url, 'blob:b-1');
  assert.deepEqual(files.map((item) => model.state.get(item.id).status), ['succeeded', 'succeeded', 'succeeded']);
});

test('an individual retry does not reconvert successes or consume another failed item', async () => {
  const model = await retryModel();
  const saved = model.state.get('b');
  const untouchedFailure = model.state.get('c');
  await model.run([files[0]]);

  assert.deepEqual(model.calls, ['a', 'b', 'c', 'a']);
  assert.equal(model.state.get('a').status, 'succeeded');
  assert.equal(model.state.get('b'), saved);
  assert.equal(model.state.get('c'), untouchedFailure);
  assert.equal(model.state.get('c').status, 'failed');
});

test('a signal aborted before the batch starts invokes no callbacks', async () => {
  const controller = new AbortController();
  controller.abort();
  const events = [];
  await assert.rejects(runVideoBatch({
    items: files,
    signal: controller.signal,
    onStart: () => events.push('start'),
    convert: async () => { events.push('convert'); },
    onOutcome: () => events.push('outcome'),
  }), { name: 'AbortError' });
  assert.deepEqual(events, []);
});

test('an AbortError cancels the current item without classifying it as failed or visiting later items', async () => {
  const started = [];
  const outcomes = [];
  await assert.rejects(runVideoBatch({
    items: files,
    signal: new AbortController().signal,
    onStart: (item) => started.push(item.id),
    convert: async () => { throw new DOMException('작업을 취소했습니다.', 'AbortError'); },
    onOutcome: (item, outcome) => outcomes.push({ id: item.id, ...plain(outcome) }),
  }), { name: 'AbortError' });
  assert.deepEqual(started, ['a']);
  assert.deepEqual(outcomes, [{ id: 'a', status: 'cancelled' }]);
});

test('a worker error caused by an aborted signal is cancellation rather than a file failure', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const started = [];
  const outcomes = [];
  const pending = runVideoBatch({
    items: files,
    signal: controller.signal,
    onStart: (item) => started.push(item.id),
    convert: async () => {
      entered.resolve();
      await release.promise;
      throw new Error('worker terminated');
    },
    onOutcome: (item, outcome) => outcomes.push({ id: item.id, ...plain(outcome) }),
  });
  const rejected = assert.rejects(pending);
  await entered.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.deepEqual(started, ['a']);
  assert.deepEqual(outcomes, [{ id: 'a', status: 'cancelled' }]);
});

test('a conversion that resolves after cancellation never publishes a stale success', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const outcomes = [];
  const converted = [];
  const pending = runVideoBatch({
    items: files,
    signal: controller.signal,
    convert: async (item) => {
      converted.push(item.id);
      entered.resolve();
      await release.promise;
      return { url: 'blob:stale-result' };
    },
    onOutcome: (item, outcome) => outcomes.push({ id: item.id, ...plain(outcome) }),
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.deepEqual(converted, ['a']);
  assert.deepEqual(outcomes, [{ id: 'a', status: 'cancelled' }]);
});

test('cancelling between items keeps the completed outcome and never starts the next item', async () => {
  const controller = new AbortController();
  const started = [];
  const outcomes = [];
  await assert.rejects(runVideoBatch({
    items: files,
    signal: controller.signal,
    onStart: (item) => started.push(item.id),
    convert: async (item) => item.id,
    onOutcome: (item, outcome) => {
      outcomes.push({ id: item.id, ...plain(outcome) });
      controller.abort();
    },
  }), { name: 'AbortError' });
  assert.deepEqual(started, ['a']);
  assert.deepEqual(outcomes, [{ id: 'a', status: 'succeeded', result: 'a' }]);
});
