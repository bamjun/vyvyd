import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = (name) => ts.transpileModule(
  readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;
const load = (name, dependencies = {}, globals = {}) => {
  const exports = {};
  runInNewContext(compile(name), {
    exports, Blob, DOMException,
    require: (dependency) => {
      if (dependency in dependencies) return dependencies[dependency];
      throw new Error(`Unexpected dependency: ${dependency}`);
    },
    ...globals,
  });
  return exports;
};
const cancellation = load('cancellation');
const mediaDependencies = { '@/lib/gifProcessing': {}, '@/lib/cancellation': cancellation };
const { getMergeLayout } = load('mediaMerger', mediaDependencies);
const plain = (value) => JSON.parse(JSON.stringify(value));
const mixed = [{ width: 320, height: 180 }, { width: 180, height: 320 }];

test('original layout remains the default and matches original top/left placement', () => {
  assert.deepEqual(plain(getMergeLayout(mixed, 'horizontal')), {
    width: 500, height: 320,
    items: [{ x: 0, y: 0, width: 320, height: 180 }, { x: 320, y: 0, width: 180, height: 320 }],
  });
  assert.deepEqual(plain(getMergeLayout([], 'vertical')), { width: 0, height: 0, items: [] });
});

test('horizontal height matching and vertical width matching preserve aspect and only shrink', () => {
  assert.deepEqual(plain(getMergeLayout(mixed, 'horizontal', { fit: 'match' })), {
    width: 421, height: 180,
    items: [{ x: 0, y: 0, width: 320, height: 180 }, { x: 320, y: 0, width: 101, height: 180 }],
  });
  assert.deepEqual(plain(getMergeLayout(mixed, 'vertical', { fit: 'match' })), {
    width: 180, height: 421,
    items: [{ x: 0, y: 0, width: 180, height: 101 }, { x: 0, y: 101, width: 180, height: 320 }],
  });
});

test('center rounds odd transparent margins down and end aligns the far edge', () => {
  const sizes = [{ width: 7, height: 2 }, { width: 2, height: 7 }];
  for (const direction of ['horizontal', 'vertical']) {
    const property = direction === 'horizontal' ? 'y' : 'x';
    const smallerIndex = direction === 'horizontal' ? 0 : 1;
    assert.equal(getMergeLayout(sizes, direction, { alignment: 'center' }).items[smallerIndex][property], 2);
    assert.equal(getMergeLayout(sizes, direction, { alignment: 'end' }).items[smallerIndex][property], 5);
  }
});

test('matched items share the exact integer cross dimension including tiny and odd sources', () => {
  const sizes = [{ width: 301, height: 19 }, { width: 1, height: 1 }, { width: 4, height: 99 }];
  for (const direction of ['horizontal', 'vertical']) {
    for (const alignment of ['start', 'center', 'end']) {
      const { items } = getMergeLayout(sizes, direction, { fit: 'match', alignment });
      items.forEach((item, index) => {
        assert.equal(direction === 'horizontal' ? item.height : item.width, 1);
        assert.ok(item.width >= 1 && item.height >= 1);
        assert.ok(item.width <= sizes[index].width && item.height <= sizes[index].height);
        assert.equal(direction === 'horizontal' ? item.y : item.x, 0);
        const nonCross = direction === 'horizontal' ? 'width' : 'height';
        const cross = direction === 'horizontal' ? 'height' : 'width';
        assert.ok(Math.abs(item[nonCross] - sizes[index][nonCross] / sizes[index][cross]) <= 1);
      });
    }
  }
});

test('limits apply to actual scaled output while original output keeps edge and pixel limits', () => {
  assert.throws(() => getMergeLayout([{ width: 9000, height: 100 }, { width: 9000, height: 100 }], 'horizontal'), /너무 큽니다/);
  assert.throws(() => getMergeLayout([{ width: 6000, height: 3000 }, { width: 6000, height: 3000 }], 'horizontal'), /너무 큽니다/);
  assert.deepEqual(plain(getMergeLayout([{ width: 10000, height: 10000 }, { width: 10, height: 10 }], 'horizontal', { fit: 'match' })), {
    width: 20, height: 10,
    items: [{ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }],
  });
});

test('invalid dimensions and options cannot silently select a direction, fit or alignment', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => getMergeLayout([{ width: value, height: 10 }], 'horizontal'), /이미지 크기/);
    assert.throws(() => getMergeLayout([{ width: 10, height: value }], 'horizontal'), /이미지 크기/);
  }
  assert.throws(() => getMergeLayout(mixed, 'diagonal'), /설정/);
  assert.throws(() => getMergeLayout(mixed, 'horizontal', { fit: 'stretch' }), /설정/);
  assert.throws(() => getMergeLayout(mixed, 'horizontal', { alignment: 'middle' }), /설정/);
});

const imageHarness = (decoded = mixed) => {
  const draws = [];
  const context = { drawImage: (_image, ...coordinates) => draws.push(coordinates) };
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    toBlob: (callback) => callback(new Blob(['png'], { type: 'image/png' })),
  };
  const dimensions = new Map(decoded.map((item, index) => [`blob:${index}`, item]));
  class Image {
    set src(value) {
      if (!value) return;
      this.naturalWidth = dimensions.get(value).width;
      this.naturalHeight = dimensions.get(value).height;
      this.onload();
    }
  }
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
  const sources = mixed.map((size, index) => ({ ...size, file: png, url: `blob:${index}` }));
  const { mergeMedia } = load('mediaMerger', mediaDependencies, { Image, document: { createElement: () => canvas } });
  return { merge: (options) => mergeMedia(sources, 'image', 'horizontal', undefined, undefined, options), draws, canvas, context };
};

test('PNG renderer uses the same scaled destination geometry and validates original decoded size', async () => {
  const subject = imageHarness();
  assert.equal((await subject.merge({ fit: 'match' })).type, 'image/png');
  assert.deepEqual(subject.draws, [[0, 0, 320, 180], [320, 0, 101, 180]]);
  assert.equal(subject.context.imageSmoothingEnabled, true);
  assert.equal(subject.context.imageSmoothingQuality, 'high');
  assert.equal(subject.canvas.width, 0);
  assert.equal(subject.canvas.height, 0);
  const changed = imageHarness([{ width: 319, height: 180 }, mixed[1]]);
  await assert.rejects(changed.merge({ fit: 'match' }), /크기가 변경/);
  assert.deepEqual(changed.draws, []);
  assert.equal(changed.canvas.width, 0);
});

test('PNG renderer centers real pixels using the same offset as preview layout', async () => {
  const subject = imageHarness();
  await subject.merge({ alignment: 'center' });
  assert.deepEqual(subject.draws, [[0, 70, 320, 180], [320, 0, 180, 320]]);
});

const gifHarness = () => {
  const commands = [];
  const deleted = [];
  const engine = {
    loaded: true,
    writeFile: async () => {},
    exec: async (args) => { commands.push(args); return 0; },
    readFile: async () => new Uint8Array([71, 73, 70, 56, 57, 97]),
    deleteFile: async (name) => deleted.push(name),
  };
  const gifs = mixed.map((size) => ({
    lsd: size,
    frames: [{ gce: { delay: 5 }, image: {} }, { gce: { delay: 15 }, image: {} }],
  }));
  const files = gifs.map((_, index) => ({ name: `${index}.gif`, arrayBuffer: async () => new Uint8Array([index]).buffer }));
  const { mergeGifFiles } = load('gifProcessing', {
    '@ffmpeg/util': {},
    'gifuct-js': { parseGIF: (buffer) => gifs[new Uint8Array(buffer)[0]] },
    '@/lib/ffmpeg': { runFFmpegJob: async (job) => job(engine) },
    '@/lib/cancellation': cancellation,
  });
  const merge = (options, sourceSizes = mixed) => mergeGifFiles(files,
    getMergeLayout(mixed, 'horizontal', options).items.map((item, index) => ({
      ...item, sourceWidth: sourceSizes[index].width, sourceHeight: sourceSizes[index].height,
    })),
  );
  return { merge, commands, deleted, gifs, mergeGifFiles, files };
};

test('GIF fitting checks original dimensions and scales only changed inputs before transparent stacking', async () => {
  const subject = gifHarness();
  assert.equal((await subject.merge({ fit: 'match' })).type, 'image/gif');
  const command = subject.commands[0];
  const filter = command[command.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[0:v\]setpts=PTS-STARTPTS,format=rgba\[input0\]/);
  assert.match(filter, /\[1:v\]setpts=PTS-STARTPTS,format=rgba,scale=101:180:flags=lanczos,setsar=1\[input1\]/);
  assert.match(filter, /xstack=inputs=2:layout=0_0\|320_0:fill=0x00000000:shortest=0/);
  assert.match(filter, /palettegen=reserve_transparent=1:stats_mode=single/);
  assert.equal(command[command.indexOf('-final_delay') + 1], '15');
  assert.equal(command[command.indexOf('-vsync') + 1], '0');
  assert.equal(subject.deleted.length, 3);
});

test('GIF original centered layout keeps scale absent and older position API remains valid', async () => {
  const subject = gifHarness();
  await subject.merge({ alignment: 'center' });
  const command = subject.commands[0];
  const filter = command[command.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(filter, /,scale=/);
  assert.match(filter, /layout=0_70\|320_0/);
  await subject.mergeGifFiles(subject.files, getMergeLayout(mixed, 'horizontal').items);
  assert.equal(subject.commands.length, 2);
});

test('changed original GIF size stops rendering and preserves engine cleanup', async () => {
  const subject = gifHarness();
  await assert.rejects(subject.merge({ fit: 'match' }, [{ width: 319, height: 180 }, mixed[1]]), /크기가 변경/);
  assert.deepEqual(subject.commands, []);
  assert.equal(subject.deleted.length, 3);
});
