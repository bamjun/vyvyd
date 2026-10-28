import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const load = (name, dependencies = {}) => {
  const source = ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const api = {};
  runInNewContext(source, { exports: api, Error, DOMException, Blob, Uint8Array, fetch,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return api;
};
const { createResultsZip, zipEntryNames } = load('downloadZip', {
  fflate: require('fflate'), './cancellation': load('cancellation'),
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) => new Uint8Array(Buffer.from(value));

// Read the standard ZIP central directory independently of the ZIP writer.
// Each extracted file is also checked against its central directory CRC32.
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const readZip = async (blob) => {
  const data = Buffer.from(await blob.arrayBuffer());
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50);
    const flags = data.readUInt16LE(offset + 8);
    assert.equal(data.readUInt16LE(offset + 10), 0, 'Media should be stored without recompression');
    const expectedCrc = data.readUInt32LE(offset + 16);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (/[가-힣]/.test(name)) assert.equal(flags & 0x0800, 0x0800, 'Korean names require the UTF-8 flag');
    assert.equal(data.readUInt32LE(localOffset), 0x04034b50);
    const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    const content = data.subarray(start, start + size);
    assert.equal(crc32(content), expectedCrc);
    entries.push({ name, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};
const assetsFor = (t, fixtures) => fixtures.map(({ name, content, type = 'image/png' }) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  t.after(() => URL.revokeObjectURL(url));
  return { url, name };
});

test('ZIP round trip preserves Unicode names and every byte of GIF and image results', async (t) => {
  const fixtures = [
    { name: '움직이는 결과.gif', type: 'image/gif', content: bytes('GIF89a-frame-one-frame-two') },
    { name: '이미지.png', content: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]) },
    { name: 'photo.webp', type: 'image/webp', content: bytes('RIFF0012WEBP') },
  ];
  const progress = [];
  const archive = await createResultsZip(assetsFor(t, fixtures), { onProgress: (value) => progress.push(plain(value)) });
  assert.equal(archive.type, 'application/zip');
  const extracted = await readZip(archive);
  assert.deepEqual(extracted.map((entry) => entry.name), fixtures.map((entry) => entry.name));
  extracted.forEach((entry, index) => assert.deepEqual([...entry.content], [...fixtures[index].content]));
  assert.equal(progress[0].completed, 0);
  assert.equal(progress.at(-1).completed, fixtures.length);
});

test('duplicate and path-like names extract as distinct safe flat filenames', async (t) => {
  const fixtures = ['../../사진.png', 'folder\\사진.png', '사진 (2).png', 'PHOTO.JPG', 'photo.jpg', 'CON.png', '../..', 'bad:name?.gif']
    .map((name, index) => ({ name, content: bytes(`content-${index}`) }));
  const entries = await readZip(await createResultsZip(assetsFor(t, fixtures)));
  assert.deepEqual(entries.map((entry) => entry.name), ['사진.png', '사진 (2).png', '사진 (2) (2).png', 'PHOTO.JPG', 'photo (2).jpg', '_CON.png', 'result-7', 'bad_name_.gif']);
  entries.forEach((entry, index) => assert.deepEqual([...entry.content], [...fixtures[index].content]));
  assert.ok(entries.every((entry) => !/[\\/:]/.test(entry.name)));
  assert.equal(new Set(entries.map((entry) => entry.name.toLowerCase())).size, fixtures.length);
});

test('names are normalized before duplicate detection and extensions survive suffixes', () => {
  assert.deepEqual(plain(zipEntryNames(['가.png', '\u1100\u1161.png', '.hidden', '.hidden', 'nul', 'dir/'])),
    ['가.png', '가 (2).png', '.hidden', '.hidden (2)', '_nul', 'result-6']);
});

test('results are read sequentially and the input list is snapshotted before async reads', async () => {
  const controller = new AbortController();
  const assets = [{ url: 'blob:a', name: 'a.png' }, { url: 'blob:b', name: 'b.png' }];
  const events = [];
  const archive = await createResultsZip(assets, {
    signal: controller.signal,
    fetcher: async (url) => {
      events.push(`fetch:${url}`);
      assets[1].url = 'blob:changed'; assets[1].name = 'changed.png'; assets.push({ url: 'blob:c', name: 'c.png' });
      return { ok: true, arrayBuffer: async () => { events.push(`read:${url}`); return bytes(url).buffer; } };
    },
  });
  assert.deepEqual(events, ['fetch:blob:a', 'read:blob:a', 'fetch:blob:b', 'read:blob:b']);
  assert.deepEqual((await readZip(archive)).map((entry) => entry.name), ['a.png', 'b.png']);
});

test('unavailable and empty outputs reject the whole archive before download', async () => {
  for (const response of [{ ok: false }, { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }]) {
    await assert.rejects(createResultsZip([{ url: 'blob:missing', name: '실패.png' }], { fetcher: async () => response }), /실패\.png/);
  }
  await assert.rejects(createResultsZip([{ url: 'blob:ok', name: 'a.png' }, { url: 'blob:bad', name: 'b.png' }], {
    fetcher: async (url) => {
      if (url === 'blob:bad') throw new Error('read failed');
      return { ok: true, arrayBuffer: async () => bytes('valid').buffer };
    },
  }), /read failed/);
});

test('empty input, remote URLs and over-limit file counts fail before fetching', async () => {
  let calls = 0;
  const options = { fetcher: async () => { calls++; throw new Error('Should not fetch'); } };
  await assert.rejects(createResultsZip([], options), /완료 결과/);
  await assert.rejects(createResultsZip([{ url: 'https://example.com/image.png', name: 'image.png' }], options), /브라우저/);
  await assert.rejects(createResultsZip(Array.from({ length: 65536 }, () => ({ url: 'blob:x', name: 'x.png' })), options), /개수/);
  assert.equal(calls, 0);
});

test('cancellation before work prevents reads; cancellation between files does not fetch the next', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(createResultsZip([{ url: 'blob:a', name: 'a.png' }], { signal: controller.signal, fetcher: async () => { calls++; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const active = new AbortController();
  await assert.rejects(createResultsZip([{ url: 'blob:a', name: 'a.png' }, { url: 'blob:b', name: 'b.png' }], {
    signal: active.signal,
    fetcher: async () => { calls++; return { ok: true, arrayBuffer: async () => bytes('valid').buffer }; },
    onProgress: ({ completed }) => { if (completed === 1) active.abort(); },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('cancel wakes a pending stream read and discards its incomplete archive', async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let streamCancelled = false;
  const stream = new ReadableStream({
    cancel() { streamCancelled = true; },
  });
  const body = { getReader() {
    const reader = stream.getReader();
    return { read() { entered(); return reader.read(); }, cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock() };
  } };
  const pending = createResultsZip([{ url: 'blob:slow', name: 'slow.gif' }], {
    signal: controller.signal,
    fetcher: async () => ({ ok: true, body }),
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  assert.equal(streamCancelled, true);
});
