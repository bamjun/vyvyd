import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const load = (name, dependencies = {}) => {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const api = {};
  runInNewContext(outputText, { exports: api, Error, crypto: webcrypto,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return api;
};
const target = load('targetSize', { './cancellation': load('cancellation') });
const {
  settingsPresetStorageKey, readSettingsPresets, saveSettingsPreset, deleteSettingsPreset,
  validatePresetSettings, applyVideoPresetOutput,
} = load('settingsPresets', { './targetSize': target });
const geometry = load('videoGeometry');
const { createVideoSettings } = load('videoSettings', { './videoGeometry': geometry });
const plain = (value) => JSON.parse(JSON.stringify(value));
const storage = () => {
  const values = new Map();
  return { values, failRead: false, failWrite: false, writes: 0,
    getItem(key) { if (this.failRead) throw new Error('SecurityError'); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw new Error('QuotaExceededError'); this.writes++; values.set(key, value); },
  };
};
const imageSettings = () => ({ resizeMode: 'bounds', percentage: 50, maxWidth: 1600, maxHeight: 1600,
  outputFormat: 'webp', quality: 85, targetSizeEnabled: true, targetSizeValue: '500', targetSizeUnit: 'KB' });
const videoSettings = () => ({ fps: 12, dither: 'bayer', targetSizeEnabled: false, targetSizeValue: '1', targetSizeUnit: 'MB',
  output: { width: '720', height: '405', aspectLocked: true, fitMode: 'contain' } });

test('named presets survive fresh reads, overwrite by identity, rename and delete', () => {
  const disk = storage();
  assert.equal(readSettingsPresets('image-resize', disk).length, 0);
  const [saved] = saveSettingsPreset('image-resize', '  웹 이미지  ', imageSettings(), disk);
  assert.equal(saved.name, '웹 이미지');
  assert.ok(saved.id);
  assert.deepEqual(plain(readSettingsPresets('image-resize', disk)), [plain(saved)]);
  const [updated] = saveSettingsPreset('image-resize', '썸네일', { ...imageSettings(), maxWidth: 800 }, disk, saved.id);
  assert.equal(updated.id, saved.id);
  assert.equal(updated.name, '썸네일');
  assert.equal(updated.settings.maxWidth, 800);
  assert.equal(readSettingsPresets('image-resize', disk).length, 1);
  assert.equal(deleteSettingsPreset('image-resize', saved.id, disk).length, 0);
  assert.equal(readSettingsPresets('image-resize', disk).length, 0);
});

test('tool collections stay isolated even when names match', () => {
  const disk = storage();
  saveSettingsPreset('image-resize', '기본', imageSettings(), disk);
  const [video] = saveSettingsPreset('video-gif', '기본', videoSettings(), disk);
  assert.equal(readSettingsPresets('image-resize', disk)[0].settings.outputFormat, 'webp');
  assert.equal(readSettingsPresets('video-gif', disk)[0].settings.fps, 12);
  deleteSettingsPreset('video-gif', video.id, disk);
  assert.equal(readSettingsPresets('image-resize', disk).length, 1);
});

test('accidental duplicate names and stale overwrite requests never mutate storage', () => {
  const disk = storage();
  saveSettingsPreset('image-resize', 'WebP', imageSettings(), disk);
  const before = [...disk.values];
  assert.throws(() => saveSettingsPreset('image-resize', ' webp ', imageSettings(), disk), /같은 이름/);
  assert.throws(() => saveSettingsPreset('image-resize', '다른 설정', imageSettings(), disk, 'deleted-id'), /삭제/);
  assert.throws(() => deleteSettingsPreset('image-resize', 'deleted-id', disk), /삭제/);
  assert.deepEqual([...disk.values], before);
});

test('mutations reread the latest collection so changes in another tab are retained', () => {
  const disk = storage();
  const [first] = saveSettingsPreset('image-resize', 'A', imageSettings(), disk);
  saveSettingsPreset('image-resize', 'B', imageSettings(), disk);
  const next = saveSettingsPreset('image-resize', 'A', { ...imageSettings(), quality: 90 }, disk, first.id);
  assert.deepEqual(plain(next.map((preset) => preset.name)), ['A', 'B']);
  assert.equal(next[0].settings.quality, 90);
});

test('quota and blocked storage errors are surfaced and retain the last successful contents', () => {
  const disk = storage();
  const [saved] = saveSettingsPreset('image-resize', '기본', imageSettings(), disk);
  const before = [...disk.values];
  disk.failWrite = true;
  assert.throws(() => saveSettingsPreset('image-resize', '변경', imageSettings(), disk, saved.id), /저장하지 못/);
  assert.throws(() => deleteSettingsPreset('image-resize', saved.id, disk), /저장하지 못/);
  assert.deepEqual([...disk.values], before);
  disk.failRead = true;
  assert.throws(() => readSettingsPresets('image-resize', disk), /읽을 수 없/);
});

test('corrupt, incompatible and cross-tool storage is rejected without overwriting it', () => {
  const disk = storage();
  const key = settingsPresetStorageKey('image-resize');
  const good = { id: '1', name: 'A', updatedAt: '2026-10-28T00:00:00.000Z', settings: imageSettings() };
  for (const raw of ['{broken', JSON.stringify({ version: 2, tool: 'image-resize', presets: [] }),
    JSON.stringify({ version: 1, tool: 'video-gif', presets: [] }),
    JSON.stringify({ version: 1, tool: 'image-resize', presets: [good, good] }),
    JSON.stringify({ version: 1, tool: 'image-resize', presets: [{ ...good, settings: { ...imageSettings(), quality: -1 } }] }),
  ]) {
    disk.values.set(key, raw);
    assert.throws(() => readSettingsPresets('image-resize', disk), /형식이나 버전/);
    assert.throws(() => saveSettingsPreset('image-resize', '새 설정', imageSettings(), disk), /형식이나 버전/);
    assert.equal(disk.values.get(key), raw);
  }
});

test('only whitelisted editing settings persist; files, URLs, crop and trim are excluded', () => {
  const disk = storage();
  saveSettingsPreset('image-resize', '이미지', { ...imageSettings(), file: 'secret file', discordWebhookUrl: 'secret webhook', resultUrl: 'blob:secret' }, disk);
  saveSettingsPreset('video-gif', '영상', { ...videoSettings(), crop: { x: 40 }, startTime: 2, endTime: 6,
    output: { ...videoSettings().output, src: 'blob:secret' } }, disk);
  for (const raw of disk.values.values()) {
    assert.doesNotMatch(raw, /secret|Webhook|startTime|endTime|crop/);
  }
});

test('invalid numeric, format and target size settings are rejected rather than clamped', () => {
  for (const patch of [{ percentage: 0 }, { percentage: 101 }, { percentage: 50.5 }, { quality: 39 }, { quality: 101 },
    { maxWidth: 0 }, { maxHeight: Infinity }, { maxWidth: 800.5 }, { resizeMode: 'crop' }, { outputFormat: 'gif' },
    { outputFormat: { toString: () => 'webp' } }, { targetSizeValue: '0.5' }, { targetSizeValue: '102401' }, { targetSizeUnit: 'GB' },
  ]) assert.throws(() => validatePresetSettings('image-resize', { ...imageSettings(), ...patch }));
  for (const patch of [{ fps: 0 }, { fps: 31 }, { fps: 12.5 }, { dither: 'unknown' }, { output: {} },
    { output: { ...videoSettings().output, width: '0' } }, { output: { ...videoSettings().output, height: '2.5' } },
    { output: { ...videoSettings().output, fitMode: 'stretch' } },
  ]) assert.throws(() => validatePresetSettings('video-gif', { ...videoSettings(), ...patch }));
  assert.throws(() => saveSettingsPreset('image-resize', ' ', imageSettings(), storage()), /이름/);
  assert.throws(() => saveSettingsPreset('image-resize', 'x'.repeat(61), imageSettings(), storage()), /이름/);
  assert.equal(validatePresetSettings('image-resize', { ...imageSettings(), targetSizeEnabled: false, targetSizeValue: '' }).targetSizeEnabled, false);
  assert.equal(validatePresetSettings('video-gif', { ...videoSettings(), output: null }).output, null);
});

test('locked output presets preserve source crop and trim and adapt the saved width to its ratio', () => {
  const current = { ...createVideoSettings({ width: 1080, height: 1920, duration: 8 }),
    crop: { x: 10, y: 20, width: 600, height: 1000 }, startTime: 2, endTime: 5, cropPreset: 'free' };
  const frozen = plain(current);
  const next = applyVideoPresetOutput(current, videoSettings().output);
  assert.equal(next.outputWidth, '720');
  assert.equal(next.outputHeight, '1200');
  assert.equal(next.scale, 1.2);
  assert.equal(next.aspectLocked, true);
  assert.equal(next.crop, current.crop);
  assert.equal(next.startTime, 2);
  assert.equal(next.endTime, 5);
  assert.deepEqual(plain(current), frozen);
  const exact = applyVideoPresetOutput(current, { ...videoSettings().output, aspectLocked: false, fitMode: 'cover' });
  assert.deepEqual([exact.outputWidth, exact.outputHeight, exact.fitMode], ['720', '405', 'cover']);
  assert.equal(applyVideoPresetOutput(current, null), current);
});
