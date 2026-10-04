import assert from 'node:assert/strict';
import {test} from 'node:test';
import {exportFilename, exportFpsChoices, validateExportOptions} from '../packages/studio-runtime/src/export-model.mjs';

const composition = {id: 'Poster', width: 600, height: 800, fps: 24, durationInFrames: 72};

test('output sizing keeps the original layout and H264 dimensions exact', () => {
  assert.deepEqual(validateExportOptions({format: 'png', width: 300, height: 400, frame: 47, transparent: true}, composition),
    {format: 'png', width: 300, height: 400, frame: 47, transparent: true});
  assert.throws(() => validateExportOptions({format: 'png', width: 301, height: 401}, composition), /비율/);
  assert.throws(() => validateExportOptions({format: 'mp4', width: 303, height: 404}, composition), /짝수/);
  assert.throws(() => validateExportOptions({format: 'png', frame: 72}, composition), /프레임/);
  assert.throws(() => validateExportOptions({format: 'mp4', transparent: true}, composition), /PNG/);
});

test('GIF sampling preserves full duration and loop options distinguish infinite from one play', () => {
  assert.deepEqual(exportFpsChoices(composition), [1, 2, 3, 4, 6, 8, 12, 24]);
  assert.deepEqual(exportFpsChoices({...composition, durationInFrames: 71}), [24]);
  assert.equal(validateExportOptions({format: 'gif', gifFps: 12}, composition).gifLoops, null);
  assert.equal(validateExportOptions({format: 'gif', gifFps: 12, gifLoops: 0}, composition).gifLoops, 0);
  assert.equal(validateExportOptions({format: 'gif', gifFps: 12, gifLoops: 1}, composition).gifLoops, 1);
  assert.throws(() => validateExportOptions({format: 'gif', gifFps: 10}, composition), /FPS/);
  assert.throws(() => validateExportOptions({format: 'gif', gifFps: 12}, {...composition, durationInFrames: 71}), /FPS/);
});

test('output workload bounds and safe download filenames reject oversized or unexpected settings', () => {
  assert.throws(() => validateExportOptions({format: 'png', width: 6000, height: 8000}, composition), /픽셀/);
  assert.throws(() => validateExportOptions({format: 'gif'}, {...composition, durationInFrames: 18000}), /너무 큽니다/);
  assert.throws(() => validateExportOptions({format: 'png', output: 'C:/elsewhere'}, composition), /지원하지/);
  assert.equal(exportFilename('제목:/test', 3, {format: 'png', frame: 9}), '제목__test-v3-f9.png');
});
