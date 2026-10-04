import assert from 'node:assert/strict';
import { Blob, File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/lib/mediaTransfer.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const loadTransfer = (fetchOverride = fetch) => {
  const api = {};
  runInNewContext(source, { exports: api, Error, DOMException, Blob, File, URL, fetch: fetchOverride });
  return api;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const gifBytes = Uint8Array.from([
  ...Buffer.from('GIF89a'), 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
  33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0,
  33, 249, 4, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 76, 1, 0, 59,
]);
const gifBlob = () => new Blob([gifBytes], { type: 'image/gif' });
const responseFor = (blob) => ({ ok: true, blob: async () => blob });
const assetFor = (t, blob, name = 'animation.gif') => {
  const url = URL.createObjectURL(blob);
  t.after(() => URL.revokeObjectURL(url));
  return { url, name };
};
const recorder = (api) => {
  const busy = [];
  const delivered = [];
  const controller = api.createMediaTransfer({
    onBusy: (value) => busy.push(value),
    onDelivered: (target, count) => delivered.push([target, count]),
  });
  return { controller, busy, delivered };
};

test('MP4 handoff copies exact bytes and survives revocation without permitting image targets', async (t) => {
  const bytes = Uint8Array.from(Buffer.from('mp4-result-with-all-frames'));
  const asset = assetFor(t, new Blob([bytes], {type: 'video/mp4'}), '포스터.mp4');
  const api = loadTransfer();
  await assert.rejects(api.materializeMediaResults([asset]), /JPG, PNG, WebP, GIF/);
  const {controller, delivered} = recorder(api);
  let received;
  controller.register('video', async ([file]) => {received = file; URL.revokeObjectURL(asset.url);});
  await controller.transfer('video', [asset]);
  assert.equal(received.type, 'video/mp4');
  assert.equal(received.name, '포스터.mp4');
  assert.deepEqual(new Uint8Array(await received.arrayBuffer()), bytes);
  assert.deepEqual(delivered, [['video', 1]]);
});

test('video handoff rejects images and a busy destination without navigating', async (t) => {
  const {controller, delivered, busy} = recorder(loadTransfer());
  const gif = assetFor(t, gifBlob());
  await assert.rejects(controller.transfer('video', [gif]), /MP4 결과만/);
  const mp4 = assetFor(t, new Blob(['video'], {type:'video/mp4'}), 'poster.mp4');
  controller.register('video', async () => {throw new Error('영상 도구가 처리 중입니다.');});
  await assert.rejects(controller.transfer('video', [mp4]), /처리 중/);
  assert.deepEqual(delivered, []);
  assert.deepEqual(busy, [true, false, true, false]);
});

test('materialized results preserve names, MIME types and exact bytes including every GIF frame', async (t) => {
  const api = loadTransfer();
  const fixtures = [
    { name: '움직이는 결과.gif', type: 'image/gif', bytes: gifBytes },
    { name: 'cropped.png', type: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    { name: 'photo.jpg', type: 'image/jpeg', bytes: Uint8Array.from([255, 216, 255, 224, 255, 217]) },
    { name: 'result.webp', type: 'image/webp', bytes: Uint8Array.from(Buffer.from('RIFF0000WEBP')) },
  ];
  const assets = fixtures.map(({ name, type, bytes }) => assetFor(t, new Blob([bytes], { type }), name));
  const files = await api.materializeMediaResults(assets);

  assert.equal(files.length, fixtures.length);
  for (const [index, file] of files.entries()) {
    const fixture = fixtures[index];
    assert.ok(file instanceof File);
    assert.equal(file.name, fixture.name);
    assert.equal(file.type, fixture.type);
    assert.equal(file.size, fixture.bytes.byteLength);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), fixture.bytes);
  }
});

test('a received GIF remains readable after the source revokes its result URL', async (t) => {
  const { controller, delivered } = recorder(loadTransfer());
  const asset = assetFor(t, gifBlob(), 'original.gif');
  let received;
  controller.register('resize', async (files) => {
    [received] = files;
    URL.revokeObjectURL(asset.url);
  });
  await controller.transfer('resize', [asset]);

  await assert.rejects(fetch(asset.url));
  assert.deepEqual(new Uint8Array(await received.arrayBuffer()), gifBytes);
  assert.equal(received.name, 'original.gif');
  assert.equal(received.type, 'image/gif');
  assert.deepEqual(delivered, [['resize', 1]]);
});

test('data image results are copied without changing their bytes or supplied output name', async () => {
  const api = loadTransfer();
  const url = `data:image/gif;base64,${Buffer.from(gifBytes).toString('base64')}`;
  const [file] = await api.materializeMediaResults([{ url, name: 'from-data.gif' }]);
  assert.equal(file.name, 'from-data.gif');
  assert.equal(file.type, 'image/gif');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), gifBytes);
});

test('delivery waits for every file and destination loading before navigating to the requested tool', async () => {
  const slowResponse = deferred();
  const fastRead = deferred();
  const receiverEntered = deferred();
  const finishReceiver = deferred();
  const api = loadTransfer(async (url) => {
    if (url === 'blob:slow') return slowResponse.promise;
    return {
      ok: true,
      blob: async () => {
        fastRead.resolve();
        return new Blob(['png bytes'], { type: 'image/png' });
      },
    };
  });
  const { controller, busy, delivered } = recorder(api);
  const received = [];
  controller.register('merge', async (files) => {
    received.push(files);
    receiverEntered.resolve();
    await finishReceiver.promise;
  });
  const pending = controller.transfer('merge', [
    { url: 'blob:slow', name: 'first.gif' }, { url: 'blob:fast', name: 'second.png' },
  ]);

  await fastRead.promise;
  assert.equal(received.length, 0);
  assert.deepEqual(delivered, []);
  assert.deepEqual(busy, [true]);
  slowResponse.resolve(responseFor(gifBlob()));
  await receiverEntered.promise;
  assert.equal(received.length, 1);
  assert.deepEqual(Array.from(received[0], (file) => file.name), ['first.gif', 'second.png']);
  assert.deepEqual(delivered, []);
  assert.deepEqual(busy, [true]);
  finishReceiver.resolve();
  await pending;
  assert.deepEqual(delivered, [['merge', 2]]);
  assert.deepEqual(busy, [true, false]);
});

test('one unreadable result prevents any partial delivery even if other reads finish later', async () => {
  const failedRead = deferred();
  const otherRead = deferred();
  const otherFinished = deferred();
  const api = loadTransfer((url) => url === 'blob:bad' ? failedRead.promise : otherRead.promise);
  const { controller, busy, delivered } = recorder(api);
  let received = 0;
  controller.register('split', async () => { received += 1; });
  const pending = controller.transfer('split', [
    { url: 'blob:bad', name: 'bad.gif' }, { url: 'blob:good', name: 'good.gif' },
  ]);
  const rejection = assert.rejects(pending, /결과 파일을 읽지 못했습니다/);
  failedRead.reject(new Error('Source URL expired'));
  await rejection;
  assert.equal(received, 0);
  assert.deepEqual(delivered, []);
  assert.deepEqual(busy, [true, false]);

  otherRead.resolve({ ok: true, blob: async () => { otherFinished.resolve(); return gifBlob(); } });
  await otherFinished.promise;
  await new Promise(setImmediate);
  assert.equal(received, 0);
  assert.deepEqual(delivered, []);
});

test('empty selections and external URLs are rejected before fetching', async () => {
  let fetches = 0;
  const api = loadTransfer(async () => { fetches += 1; return responseFor(gifBlob()); });
  await assert.rejects(api.materializeMediaResults([]), /전달할 결과가 없습니다/);
  for (const url of ['https://example.com/image.gif', 'http://localhost/image.gif', 'file:///image.gif', 'data:text/html,hello']) {
    await assert.rejects(api.materializeMediaResults([{ url, name: 'result.gif' }]), /브라우저에서 만든 이미지/);
  }
  assert.equal(fetches, 0);
});

test('unsupported types and empty image results are rejected without delivering or navigating', async (t) => {
  const { controller, busy, delivered } = recorder(loadTransfer());
  let received = 0;
  controller.register('resize', async () => { received += 1; });
  const invalidBlobs = [
    new Blob(['movie'], { type: 'video/mp4' }),
    new Blob(['<svg/>'], { type: 'image/svg+xml' }),
    new Blob(['unknown'], { type: 'application/octet-stream' }),
    new Blob([], { type: 'image/gif' }),
  ];
  for (const blob of invalidBlobs) {
    await assert.rejects(controller.transfer('resize', [assetFor(t, blob)]), /JPG, PNG, WebP, GIF/);
  }
  assert.equal(received, 0);
  assert.deepEqual(delivered, []);
  assert.deepEqual(busy, invalidBlobs.flatMap(() => [true, false]));
});

test('an unavailable URL or failed response produces a readable error and releases busy state', async (t) => {
  const asset = assetFor(t, gifBlob());
  URL.revokeObjectURL(asset.url);
  const native = recorder(loadTransfer());
  await assert.rejects(native.controller.transfer('resize', [asset]), /결과 파일을 읽지 못했습니다/);
  assert.deepEqual(native.busy, [true, false]);
  assert.deepEqual(native.delivered, []);

  const unavailable = recorder(loadTransfer(async () => ({ ok: false })));
  await assert.rejects(unavailable.controller.transfer('merge', [{ url: 'blob:missing', name: 'missing.gif' }]), /결과 파일을 읽지 못했습니다/);
  assert.deepEqual(unavailable.busy, [true, false]);
  assert.deepEqual(unavailable.delivered, []);
});

test('unregistering a receiver prevents navigation and a later registration can receive normally', async (t) => {
  const { controller, busy, delivered } = recorder(loadTransfer());
  const asset = assetFor(t, gifBlob());
  let calls = 0;
  const unregister = controller.register('split', async () => { calls += 1; });
  unregister();
  await assert.rejects(controller.transfer('split', [asset]), /편집 도구를 준비하지 못했습니다/);
  assert.equal(calls, 0);
  assert.deepEqual(delivered, []);
  assert.deepEqual(busy, [true, false]);

  controller.register('split', async () => { calls += 1; });
  await controller.transfer('split', [asset]);
  assert.equal(calls, 1);
  assert.deepEqual(delivered, [['split', 1]]);
  assert.deepEqual(busy, [true, false, true, false]);
});

test('cleanup from an older registration cannot remove its replacement', async (t) => {
  const { controller, delivered } = recorder(loadTransfer());
  const asset = assetFor(t, gifBlob());
  const calls = [];
  const removeOld = controller.register('merge', async () => { calls.push('old'); });
  const removeNew = controller.register('merge', async () => { calls.push('new'); });
  removeOld();
  await controller.transfer('merge', [asset]);
  assert.deepEqual(calls, ['new']);
  assert.deepEqual(delivered, [['merge', 1]]);

  removeNew();
  await assert.rejects(controller.transfer('merge', [asset]), /편집 도구를 준비하지 못했습니다/);
  assert.deepEqual(calls, ['new']);
  assert.deepEqual(delivered, [['merge', 1]]);
});

test('a rejected or busy destination does not navigate and transfers can retry afterward', async (t) => {
  const { controller, busy, delivered } = recorder(loadTransfer());
  const asset = assetFor(t, gifBlob());
  let attempt = 0;
  controller.register('resize', async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('현재 파일을 처리 중입니다.');
    if (attempt === 2) throw new Error('이미지를 읽을 수 없습니다.');
  });
  await assert.rejects(controller.transfer('resize', [asset]), /처리 중/);
  await assert.rejects(controller.transfer('resize', [asset]), /읽을 수 없습니다/);
  assert.deepEqual(delivered, []);
  assert.deepEqual(busy, [true, false, true, false]);
  await controller.transfer('resize', [asset]);
  assert.equal(attempt, 3);
  assert.deepEqual(delivered, [['resize', 1]]);
  assert.deepEqual(busy, [true, false, true, false, true, false]);
});

test('concurrent transfers are rejected while a destination is loading without resetting its busy state', async (t) => {
  const { controller, busy, delivered } = recorder(loadTransfer());
  const asset = assetFor(t, gifBlob());
  const entered = deferred();
  const finish = deferred();
  let received = 0;
  controller.register('merge', async () => {
    received += 1;
    entered.resolve();
    await finish.promise;
  });
  const first = controller.transfer('merge', [asset]);
  await entered.promise;
  await assert.rejects(controller.transfer('merge', [asset]), /전달하고 있습니다/);
  assert.equal(received, 1);
  assert.deepEqual(busy, [true]);
  assert.deepEqual(delivered, []);
  finish.resolve();
  await first;
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(delivered, [['merge', 1]]);
});
