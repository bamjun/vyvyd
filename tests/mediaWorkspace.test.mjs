import assert from 'node:assert/strict';
import { Blob, File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import ts from 'typescript';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const source = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const coreSource = source('../src/lib/mediaWorkspace.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
const loadCore = ({ indexedDB = new IDBFactory(), fetchOverride = fetch, urlOverride = URL, window = new EventTarget() } = {}) => {
  const api = {};
  runInNewContext(coreSource, { exports: api, Blob, File, Error, DOMException, indexedDB, URL: urlOverride,
    fetch: fetchOverride, window, Event, setTimeout, clearTimeout });
  return api;
};
const memory = () => {
  const records = new Map();
  return { records, writes: [],
    async read(tool) { return records.get(tool); },
    async write(record) { this.writes.push(record); records.set(record.tool, record); },
    async remove(tool) { records.delete(tool); },
    async list() { return [...records.values()]; },
  };
};
const createFile = (name = '한글 이미지.png') => new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png', lastModified: 123456789 });
const saver = (api, storage, baseline = {}) => api.createMediaWorkspaceSaver('resize', { baseline, storage, delay: 60_000 });

test('codec keeps File bytes and names, regenerates URLs, and pauses only in-flight file states', async (t) => {
  const file = createFile();
  const inputUrl = URL.createObjectURL(file);
  const resultBlob = new Blob([new Uint8Array([8, 9, 10])], { type: 'image/gif' });
  const resultUrl = URL.createObjectURL(resultBlob);
  t.after(() => { URL.revokeObjectURL(inputUrl); URL.revokeObjectURL(resultUrl); });
  const fetched = [];
  const api = loadCore({ fetchOverride: async (url) => { fetched.push(url); return fetch(url); } });
  const snapshot = { imageItems: [{ id: 'one', file, src: inputUrl }], settings: { maxWidth: 1600 },
    results: [{ id: 'one', url: resultUrl, width: 2, height: 2 }],
    fileStates: { one: { status: 'processing' }, two: { status: 'waiting' }, three: { status: 'failed', message: '다시 시도' }, four: { status: 'succeeded' } },
    unrelated: { status: 'processing' } };
  const encoded = await api.encodeMediaWorkspace(snapshot);
  assert.deepEqual(fetched, [resultUrl], 'an input URL reuses its original File instead of fetching the bytes twice');
  assert.equal(encoded.sizeBytes, file.size + resultBlob.size);
  assert.ok(!JSON.stringify(encoded.snapshot).includes(inputUrl));
  assert.ok(!JSON.stringify(encoded.snapshot).includes(resultUrl));
  const restored = api.decodeMediaWorkspace(encoded.snapshot);
  t.after(() => api.releaseMediaWorkspaceUrls(restored.urls));
  assert.equal(restored.snapshot.imageItems[0].file.name, file.name);
  assert.equal(restored.snapshot.imageItems[0].file.lastModified, file.lastModified);
  assert.equal(restored.snapshot.imageItems[0].file.type, file.type);
  assert.deepEqual(new Uint8Array(await restored.snapshot.imageItems[0].file.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
  assert.notEqual(restored.snapshot.imageItems[0].src, inputUrl);
  assert.deepEqual(new Uint8Array(await (await fetch(restored.snapshot.results[0].url)).arrayBuffer()), new Uint8Array([8, 9, 10]));
  assert.deepEqual(plain(restored.snapshot.fileStates), { one: { status: 'cancelled' }, two: { status: 'cancelled' }, three: { status: 'failed', message: '다시 시도' }, four: { status: 'succeeded' } });
  assert.equal(restored.snapshot.unrelated.status, 'processing');
  assert.equal(snapshot.fileStates.one.status, 'processing', 'decoding never edits the live processing state');
});

test('real IndexedDB survives a fresh module, exposes recent summaries, and deletes only the requested tool', async (t) => {
  const indexedDB = new IDBFactory();
  const api = loadCore({ indexedDB });
  assert.equal(await api.loadMediaWorkspace('resize'), null);
  const resize = api.createMediaWorkspaceSaver('resize', { baseline: {}, delay: 60_000 });
  const padding = api.createMediaWorkspaceSaver('padding', { baseline: {}, delay: 60_000 });
  t.after(() => { resize.dispose(); padding.dispose(); });
  const file = createFile();
  const url = URL.createObjectURL(file);
  const output = new Blob([new Uint8Array([7, 8, 9])], { type: 'image/webp' });
  const outputUrl = URL.createObjectURL(output);
  t.after(() => { URL.revokeObjectURL(url); URL.revokeObjectURL(outputUrl); });
  resize.schedule({ inputs: [{ id: 'input-1', file, src: url, width: 100, height: 60 }],
    results: [{ id: 'input-1', url: outputUrl, downloadName: '축소.webp', size: output.size, width: 50, height: 30 }],
    settings: { format: 'webp', percentage: 50 }, fileStates: { 'input-1': { status: 'succeeded' } } });
  await resize.flush();
  padding.schedule({ inputs: [], results: [], background: 'white' });
  await padding.flush();
  const fresh = loadCore({ indexedDB });
  const restored = await fresh.loadMediaWorkspace('resize', undefined, { inputs: [], results: [], settings: { format: '', percentage: 0 }, fileStates: {} });
  t.after(() => fresh.releaseMediaWorkspaceUrls(restored.urls));
  assert.equal(restored.snapshot.inputs[0].file.name, file.name);
  assert.equal(restored.snapshot.inputs[0].file.lastModified, file.lastModified);
  assert.deepEqual(plain(restored.snapshot.settings), { format: 'webp', percentage: 50 });
  assert.equal(restored.snapshot.results[0].downloadName, '축소.webp');
  assert.deepEqual(new Uint8Array(await (await fetch(restored.snapshot.results[0].url)).arrayBuffer()), new Uint8Array([7, 8, 9]));
  const recent = await fresh.listMediaWorkspaces();
  assert.equal(recent.length, 2);
  assert.equal(recent.find((entry) => entry.tool === 'resize').inputCount, 1);
  assert.equal(recent.find((entry) => entry.tool === 'resize').sizeBytes, file.size + output.size);
  assert.equal(recent.find((entry) => entry.tool === 'resize').resultCount, 1);
  await fresh.deleteMediaWorkspace('padding');
  assert.equal(await fresh.loadMediaWorkspace('padding'), null);
  assert.equal((await fresh.listMediaWorkspaces()).length, 1);
});

test('file fingerprints distinguish replacement files with identical metadata and keep unchanged files stable', () => {
  const api = loadCore();
  const first = createFile();
  const second = createFile();
  const key = api.fingerprintMediaWorkspace({ file: first, width: 100 });
  assert.equal(api.fingerprintMediaWorkspace({ file: first, width: 100 }), key);
  assert.notEqual(api.fingerprintMediaWorkspace({ file: second, width: 100 }), key);
});

test('a newer edit supersedes an old byte capture before it reaches durable storage', async (t) => {
  const entered = deferred();
  const release = deferred();
  const api = loadCore({ fetchOverride: async () => { entered.resolve(); await release.promise; return { ok: true, blob: async () => new Blob(['old']) }; } });
  const storage = memory();
  const writer = saver(api, storage);
  t.after(() => writer.dispose());
  writer.schedule({ results: [{ url: 'blob:old-result' }], percentage: 50 });
  const flushing = writer.flush();
  await entered.promise;
  writer.schedule({ results: [], percentage: 25 });
  release.resolve();
  await flushing;
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.writes[0].snapshot.percentage, 25);
});

test('an already-started write finishes before the newest snapshot and never overwrites it afterward', async (t) => {
  const entered = deferred();
  const release = deferred();
  const api = loadCore();
  const storage = memory();
  const normalWrite = storage.write.bind(storage);
  storage.write = async (record) => { if (record.snapshot.percentage === 50) { entered.resolve(); await release.promise; } await normalWrite(record); };
  const writer = saver(api, storage);
  t.after(() => writer.dispose());
  writer.schedule({ percentage: 50 });
  const flushing = writer.flush();
  await entered.promise;
  writer.schedule({ percentage: 25 });
  release.resolve();
  await flushing;
  assert.deepEqual(storage.writes.map((record) => record.snapshot.percentage), [50, 25]);
  assert.equal(storage.records.get('resize').snapshot.percentage, 25);
});

test('quota failures retain the last good copy, report the error, and allow an explicit retry', async (t) => {
  const api = loadCore();
  const storage = memory();
  const errors = [];
  const writer = api.createMediaWorkspaceSaver('resize', { baseline: {}, storage, delay: 60_000, onError: (message) => errors.push(message) });
  t.after(() => writer.dispose());
  writer.schedule({ percentage: 50 });
  await writer.flush();
  const saved = storage.records.get('resize');
  const normalWrite = storage.write.bind(storage);
  storage.write = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
  writer.schedule({ percentage: 25 });
  await writer.flush();
  assert.equal(storage.records.get('resize'), saved);
  assert.match(errors[0], /저장 공간/);
  storage.write = normalWrite;
  writer.schedule({ percentage: 25 }, true);
  await writer.flush();
  assert.equal(storage.records.get('resize').snapshot.percentage, 25);
});

test('clearing waits out an earlier write, removes the saved copy, and does not resave an unchanged view', async (t) => {
  const api = loadCore();
  const entered = deferred();
  const release = deferred();
  const storage = memory();
  const normalWrite = storage.write.bind(storage);
  storage.write = async (record) => { entered.resolve(); await release.promise; await normalWrite(record); };
  const writer = saver(api, storage);
  t.after(() => writer.dispose());
  const snapshot = { percentage: 50 };
  writer.schedule(snapshot);
  const flushing = writer.flush();
  await entered.promise;
  const clearing = writer.clear();
  release.resolve();
  await Promise.all([flushing, clearing]);
  assert.equal(storage.records.has('resize'), false);
  const writes = storage.writes.length;
  writer.schedule({ percentage: 50 });
  await writer.flush();
  assert.equal(storage.writes.length, writes);
});

test('failed hydration releases only newly allocated URLs and incompatible records remain untouched', async () => {
  const released = [];
  let counter = 0;
  const api = loadCore({ urlOverride: { createObjectURL: () => `blob:restored-${++counter}`, revokeObjectURL: (url) => released.push(url) } });
  assert.throws(() => api.decodeMediaWorkspace({ results: [{ url: { __vyvydStoredMedia: 'url', blob: new Blob(['bytes']) } }, { url: { __vyvydStoredMedia: 'url', blob: null } }] }), /ファイル|파일/);
  assert.deepEqual(released, ['blob:restored-1']);
  const storage = memory();
  const incompatible = { version: 8, tool: 'resize', snapshot: { percentage: 12 } };
  storage.records.set('resize', incompatible);
  await assert.rejects(api.loadMediaWorkspace('resize', storage), /버전/);
  assert.equal(storage.records.get('resize'), incompatible);
});

test('cached result bytes survive URL revocation between setting edits and unused cached data is released', async (t) => {
  const api = loadCore();
  const cache = new Map();
  const url = URL.createObjectURL(new Blob(['result'], { type: 'image/png' }));
  t.after(() => URL.revokeObjectURL(url));
  await api.encodeMediaWorkspace({ results: [{ url }], percentage: 50 }, cache);
  assert.equal(cache.size, 1);
  URL.revokeObjectURL(url);
  const encoded = await api.encodeMediaWorkspace({ results: [{ url }], percentage: 25 }, cache);
  assert.equal(encoded.snapshot.percentage, 25);
  await api.encodeMediaWorkspace({ results: [], percentage: 25 }, cache);
  assert.equal(cache.size, 0);
});

test('a valid record version cannot restore missing settings, malformed media or invalid file states', async () => {
  const api = loadCore();
  const baseline = { imageItems: [], results: [], resizeMode: 'percentage', percentage: 50, fileStates: {} };
  for (const snapshot of [
    { bad: 1 },
    { ...baseline, percentage: '50' },
    { ...baseline, imageItems: [{ id: 'a', file: createFile(), src: 'https://external.invalid/file', width: 100, height: 100 }] },
    { ...baseline, results: [{ url: 'blob:unavailable', width: 0, height: 100 }] },
    { ...baseline, fileStates: { a: { status: 'failed' } } },
  ]) assert.throws(() => api.validateMediaWorkspaceSnapshot(snapshot, baseline), /형식/);
  const storage = memory();
  const bad = { version: 1, tool: 'resize', updatedAt: new Date().toISOString(), inputCount: 0, resultCount: 0, sizeBytes: 0, snapshot: { bad: 1 } };
  storage.records.set('resize', bad);
  await assert.rejects(api.loadMediaWorkspace('resize', storage, baseline), /형식/);
  assert.equal(storage.records.get('resize'), bad);
});

test('a database open which was blocked closes any connection delivered after rejection', async () => {
  const request = {};
  let closes = 0;
  const api = loadCore({ indexedDB: { open: () => request } });
  const pending = api.loadMediaWorkspace('resize');
  const rejected = assert.rejects(pending, /다른 탭/);
  request.onblocked();
  request.result = { close: () => { closes++; } };
  request.onsuccess();
  await rejected;
  assert.equal(closes, 1);
});

const hookSource = source('../src/hooks/useMediaWorkspace.ts');
const mountHook = (core, { initial = { imageItems: [], results: [], percentage: 50, fileStates: {} }, window = new EventTarget() } = {}) => {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let snapshot = initial;
  let state;
  let restores = 0;
  const react = {
    useState(initialValue) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useRef(initialValue) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initialValue };
      return slots[index];
    },
    useCallback(callback) { cursor++; return callback; },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
        slots[index] = { deps, effect };
      }
    },
  };
  const api = {};
  runInNewContext(hookSource, { exports: api, window, Error, require: (name) => {
    if (name === 'react') return react;
    if (name === '@/lib/mediaWorkspace') return core;
    throw new Error(`Unexpected hook dependency: ${name}`);
  } });
  const render = () => {
    cursor = 0;
    state = api.useMediaWorkspace({ tool: 'resize', snapshot, restore: (next) => { restores++; snapshot = next; } });
    effects.splice(0).forEach((effect) => effect());
    return state;
  };
  const unmount = () => slots.forEach((slot) => slot?.cleanup?.());
  render();
  return { render, unmount, get snapshot() { return snapshot; }, get restores() { return restores; },
    edit(next) { snapshot = next; return render(); },
    restartEffects() { unmount(); slots.forEach((slot) => { if (slot?.effect) slot.cleanup = slot.effect(); }); },
  };
};
const until = async (read, predicate) => {
  for (let count = 0; count < 100; count++) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise(setImmediate);
  }
  throw new Error('The hook did not settle');
};

test('hook hydrates before autosaving and a fresh mount restores a successful edited snapshot', async (t) => {
  const api = loadCore();
  const encoded = await api.encodeMediaWorkspace({ imageItems: [], results: [], percentage: 25, fileStates: {} });
  await api.mediaWorkspaceStorage.write({ version: 1, tool: 'resize', updatedAt: new Date().toISOString(), inputCount: 0, resultCount: 0, sizeBytes: 0, ...encoded });
  let writes = 0;
  const write = api.mediaWorkspaceStorage.write;
  api.mediaWorkspaceStorage.write = async (record) => { writes++; await write(record); };
  const first = mountHook(api);
  t.after(() => first.unmount());
  assert.equal(first.render().ready, false);
  await until(first.render, (state) => state.ready);
  assert.equal(first.snapshot.percentage, 25);
  assert.equal(first.restores, 1);
  assert.equal(writes, 0, 'the initial empty UI never replaces the durable snapshot');
  first.edit({ ...first.snapshot, percentage: 75 });
  first.render().retrySave();
  await until(first.render, (state) => !state.saving);
  first.unmount();
  const second = mountHook(api);
  t.after(() => second.unmount());
  await until(second.render, (state) => state.ready);
  assert.equal(second.snapshot.percentage, 75);
  assert.equal(second.render().restored, true);
});

test('StrictMode replay and unmount never apply late hydration or leak regenerated URLs', async () => {
  const pending = [deferred(), deferred()];
  const released = [];
  const api = loadCore();
  let calls = 0;
  const core = { ...api, loadMediaWorkspace: () => pending[calls++].promise,
    releaseMediaWorkspaceUrls: (urls) => released.push(...urls) };
  const host = mountHook(core);
  host.restartEffects();
  host.unmount();
  pending[0].resolve({ snapshot: { percentage: 25 }, urls: ['blob:old-mount'] });
  pending[1].resolve({ snapshot: { percentage: 75 }, urls: ['blob:replayed-mount'] });
  await new Promise(setImmediate);
  assert.equal(host.restores, 0);
  assert.deepEqual(released.sort(), ['blob:old-mount', 'blob:replayed-mount']);
});
