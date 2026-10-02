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
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return api;
};

const geometry = loadModule('../src/lib/videoGeometry.ts');
const {
  applyVideoOutputSettings, changeOutputDimension, changeVideoCrop, createVideoSettings,
  hasValidVideoOutputSize, hasValidVideoSettings, resizeVideoSettings, setVideoAspectLocked,
} = loadModule('../src/lib/videoSettings.ts', { './videoGeometry': geometry });

// Compare values across the VM boundary without comparing realm-specific prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const freezeSettings = (settings) => {
  Object.freeze(settings.crop);
  return Object.freeze(settings);
};
const landscape = { width: 1920, height: 1080, duration: 10 };
const portrait = { width: 1080, height: 1920, duration: 2.5 };

test('mixed landscape and portrait files start with independent full-frame settings', () => {
  const wide = freezeSettings(createVideoSettings(landscape));
  const tall = freezeSettings(createVideoSettings(portrait));

  assert.deepEqual([wide.outputWidth, wide.outputHeight], ['1440', '810']);
  assert.deepEqual([tall.outputWidth, tall.outputHeight], ['810', '1440']);
  assert.deepEqual(plain(wide.crop), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(plain(tall.crop), { x: 0, y: 0, width: 1080, height: 1920 });
  assert.equal(wide.endTime, 4);
  assert.equal(tall.endTime, 2.5);
  assert.notEqual(wide.crop, tall.crop);
  assert.equal(wide.aspectLocked, true);
  assert.equal(wide.cropPreset, 'free');
  assert.equal(tall.fitMode, 'contain');

  const editedWide = changeOutputDimension(wide, 'width', '640');
  assert.deepEqual([editedWide.outputWidth, editedWide.outputHeight], ['640', '360']);
  assert.deepEqual([tall.outputWidth, tall.outputHeight], ['810', '1440']);
  assert.equal(wide.outputWidth, '1440');
});

test('locked width and height edits preserve the selected crop ratio', () => {
  const cropped = freezeSettings(changeVideoCrop(
    createVideoSettings(landscape), { x: 100, y: 60, width: 800, height: 600 }, landscape,
  ));
  const fromWidth = changeOutputDimension(cropped, 'width', '400');
  assert.deepEqual([fromWidth.outputWidth, fromWidth.outputHeight], ['400', '300']);
  assert.equal(fromWidth.scale, 0.5);

  const fromHeight = changeOutputDimension(cropped, 'height', '150');
  assert.deepEqual([fromHeight.outputWidth, fromHeight.outputHeight], ['200', '150']);
  assert.equal(fromHeight.scale, 0.25);
  assert.deepEqual(plain(fromHeight.crop), plain(cropped.crop));
  assert.deepEqual([cropped.outputWidth, cropped.outputHeight], ['600', '450']);
});

test('unlocked dimensions and subsequent crop changes preserve the chosen output canvas', () => {
  const initial = freezeSettings(createVideoSettings(portrait));
  const unlocked = setVideoAspectLocked(initial, false);
  const wider = changeOutputDimension(unlocked, 'width', '640');
  assert.equal(wider.outputHeight, initial.outputHeight);
  const square = freezeSettings(changeOutputDimension(wider, 'height', '640'));
  const recropped = changeVideoCrop(square, { x: 100, y: 200, width: 600, height: 1000 }, portrait);

  assert.deepEqual([recropped.outputWidth, recropped.outputHeight], ['640', '640']);
  assert.equal(recropped.aspectLocked, false);
  assert.deepEqual(plain(recropped.crop), { x: 100, y: 200, width: 600, height: 1000 });
  assert.deepEqual(plain(square.crop), { x: 0, y: 0, width: 1080, height: 1920 });
  assert.equal(initial.aspectLocked, true);
});

test('changing a locked crop retains the manually chosen scale and clamps to that source', () => {
  const custom = freezeSettings(changeOutputDimension(createVideoSettings(landscape), 'width', '480'));
  const recropped = changeVideoCrop(custom, { x: 1800, y: 1000, width: 800, height: 600 }, landscape);

  assert.deepEqual(plain(recropped.crop), { x: 1120, y: 480, width: 800, height: 600 });
  assert.deepEqual([recropped.outputWidth, recropped.outputHeight], ['200', '150']);
  assert.equal(recropped.scale, 0.25);
  assert.deepEqual(plain(custom.crop), { x: 0, y: 0, width: 1920, height: 1080 });
});

test('sharing output settings preserves every destination crop and time range without mutation', () => {
  const source = freezeSettings({
    ...createVideoSettings(landscape), outputWidth: '640', outputHeight: '360', fitMode: 'cover',
    crop: { x: 10, y: 20, width: 1600, height: 900 }, cropPreset: '9:16', startTime: 2, endTime: 5,
  });
  const destination = freezeSettings({
    ...createVideoSettings(portrait), crop: { x: 30, y: 40, width: 900, height: 1200 },
    startTime: 0.5, endTime: 2, scale: 0.5, cropPreset: '4:5',
  });
  const sourceBefore = plain(source);
  const destinationBefore = plain(destination);
  const copied = applyVideoOutputSettings(destination, source);

  assert.deepEqual([copied.outputWidth, copied.outputHeight, copied.fitMode], ['640', '360', 'cover']);
  assert.equal(copied.aspectLocked, false);
  assert.deepEqual(plain(copied.crop), destinationBefore.crop);
  assert.deepEqual([copied.startTime, copied.endTime], [0.5, 2]);
  assert.equal(copied.scale, 0.5);
  assert.equal(copied.cropPreset, '4:5');
  assert.notEqual(copied, destination);
  assert.deepEqual(plain(source), sourceBefore);
  assert.deepEqual(plain(destination), destinationBefore);

  const changedAgain = changeVideoCrop(copied, { x: 50, y: 70, width: 600, height: 1000 }, portrait);
  assert.deepEqual([changedAgain.outputWidth, changedAgain.outputHeight], ['640', '360']);
  assert.deepEqual(plain(copied.crop), destinationBefore.crop);
  assert.deepEqual(plain(source), sourceBefore);
});

test('relocking a shared canvas derives height from its own crop and keeps its width', () => {
  const tall = createVideoSettings(portrait);
  const shared = freezeSettings(applyVideoOutputSettings(tall, {
    ...createVideoSettings(landscape), outputWidth: '360', outputHeight: '360',
  }));
  const locked = setVideoAspectLocked(shared, true);

  assert.deepEqual([locked.outputWidth, locked.outputHeight], ['360', '640']);
  assert.equal(locked.aspectLocked, true);
  assert.equal(locked.scale, 1 / 3);
  assert.deepEqual([shared.outputWidth, shared.outputHeight, shared.aspectLocked], ['360', '360', false]);
});

test('an explicit scale preset derives both dimensions from the current crop', () => {
  const settings = freezeSettings({
    ...createVideoSettings(landscape), aspectLocked: false,
    crop: { x: 100, y: 200, width: 600, height: 800 }, outputWidth: '320', outputHeight: '320',
  });
  const resized = resizeVideoSettings(settings, 0.5);

  assert.deepEqual([resized.outputWidth, resized.outputHeight], ['300', '400']);
  assert.equal(resized.scale, 0.5);
  assert.deepEqual(plain(resized.crop), plain(settings.crop));
  assert.deepEqual([settings.outputWidth, settings.outputHeight], ['320', '320']);
});

test('invalid locked input remains invalid without corrupting the paired dimension or scale', () => {
  const settings = freezeSettings(createVideoSettings(landscape));
  for (const value of ['', '0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992']) {
    const edited = changeOutputDimension(settings, 'width', value);
    assert.equal(edited.outputWidth, value);
    assert.equal(edited.outputHeight, settings.outputHeight);
    assert.equal(edited.scale, settings.scale);
    assert.equal(hasValidVideoSettings(edited), false, `invalid width ${JSON.stringify(value)}`);
  }
});

test('export validation rejects invalid dimensions and trim ranges for each file', () => {
  const settings = freezeSettings(createVideoSettings(landscape));
  assert.equal(hasValidVideoSettings(settings), true);
  assert.equal(hasValidVideoSettings({ ...settings, outputWidth: '1', outputHeight: '1', startTime: 0, endTime: 0.1 }), true);

  const invalidEdits = [
    { outputWidth: '' }, { outputWidth: '0' }, { outputHeight: '-1' },
    { outputHeight: '1.5' }, { outputHeight: 'Infinity' }, { outputHeight: '9007199254740992' },
    { startTime: -0.1 }, { startTime: NaN }, { startTime: Infinity },
    { endTime: NaN }, { endTime: Infinity }, { endTime: 0 }, { startTime: 3, endTime: 2 },
  ];
  for (const edit of invalidEdits) {
    assert.equal(hasValidVideoSettings({ ...settings, ...edit }), false, `invalid settings ${JSON.stringify(edit)}`);
  }
});

test('output-only sharing remains available while a trim range is incomplete', () => {
  const settings = { ...createVideoSettings(portrait), startTime: 1, endTime: 1 };
  assert.equal(hasValidVideoSettings(settings), false);
  assert.equal(hasValidVideoOutputSize(settings), true);
  assert.equal(hasValidVideoOutputSize({ ...settings, outputWidth: '' }), false);
});
