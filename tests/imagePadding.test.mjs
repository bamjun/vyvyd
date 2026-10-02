import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/lib/imagePadding.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const api = {};
runInNewContext(source, { exports: api });
const layout = (...args) => JSON.parse(JSON.stringify(api.getImagePaddingLayout(...args)));

test('default top placement keeps the complete source and adds a 9:16 canvas', () => {
  assert.deepEqual(layout(90, 90), { width: 90, height: 90, outputHeight: 160, x: 0, y: 0 });
});

test('center and bottom placements use the same output dimensions without scaling', () => {
  assert.deepEqual(layout(320, 180, 'center'), { width: 320, height: 180, outputHeight: 569, x: 0, y: 194 });
  assert.deepEqual(layout(320, 180, 'bottom'), { width: 320, height: 180, outputHeight: 569, x: 0, y: 389 });
});

test('odd extra height leaves the remaining one pixel below a centered source', () => {
  const centered = layout(9, 7, 'center');
  assert.equal(centered.y, 4);
  assert.equal(centered.outputHeight - centered.y - centered.height, 5);
});

test('images that already fill or exceed 9:16 retain their height for every alignment', () => {
  for (const alignment of ['top', 'center', 'bottom']) {
    assert.deepEqual(layout(90, 160, alignment), { width: 90, height: 160, outputHeight: 160, x: 0, y: 0 });
    assert.deepEqual(layout(90, 220, alignment), { width: 90, height: 220, outputHeight: 220, x: 0, y: 0 });
  }
});

test('tiny images are padded without dropping the source pixel or rounding outside the canvas', () => {
  for (const [alignment, y] of [['top', 0], ['center', 0], ['bottom', 1]]) {
    assert.deepEqual(layout(1, 1, alignment), { width: 1, height: 1, outputHeight: 2, x: 0, y });
  }
});
