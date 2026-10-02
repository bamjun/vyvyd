import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/lib/cropPresets.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const api = {};
runInNewContext(source, { exports: api });
const { centerCrop, constrainCrop, getDraggedCrop, getPresetAspectRatio, getPresetCrop } = api;
const plain = (crop) => ({ ...crop });
const bounded = (crop, bounds, ratio) => {
  for (const value of Object.values(crop)) assert.equal(Number.isInteger(value), true);
  assert.ok(crop.x >= 0 && crop.y >= 0);
  assert.ok(crop.width >= 1 && crop.height >= 1);
  assert.ok(crop.x + crop.width <= bounds.width);
  assert.ok(crop.y + crop.height <= bounds.height);
  if (ratio) assert.ok(Math.abs(crop.width - crop.height * ratio) <= 1, `ratio drift: ${JSON.stringify(crop)}`);
};

test('presets choose the largest centered crop with exact ratio units', () => {
  const bounds = { width: 1920, height: 1080 };
  assert.equal(getPresetAspectRatio('free'), undefined);
  assert.deepEqual(plain(getPresetCrop(bounds, 'free')), { x: 0, y: 0, ...bounds });
  assert.deepEqual(plain(getPresetCrop(bounds, '1:1')), { x: 420, y: 0, width: 1080, height: 1080 });
  assert.deepEqual(plain(getPresetCrop(bounds, '4:5')), { x: 528, y: 0, width: 864, height: 1080 });
  assert.deepEqual(plain(getPresetCrop(bounds, '9:16')), { x: 658, y: 4, width: 603, height: 1072 });
});

test('portrait and odd-sized sources remain centered and inside bounds', () => {
  for (const bounds of [{ width: 1080, height: 1920 }, { width: 321, height: 181 }, { width: 13, height: 19 }]) {
    for (const preset of ['1:1', '4:5', '9:16']) {
      const crop = getPresetCrop(bounds, preset);
      bounded(crop, bounds, getPresetAspectRatio(preset));
      assert.ok(Math.abs(crop.x - (bounds.width - crop.width) / 2) <= 0.5);
      assert.ok(Math.abs(crop.y - (bounds.height - crop.height) / 2) <= 0.5);
    }
  }
});

test('center placement keeps existing dimensions and clamps oversized crops', () => {
  assert.deepEqual(plain(centerCrop({ x: 2, y: 3, width: 91, height: 160 }, { width: 321, height: 181 })), {
    x: 115, y: 10, width: 91, height: 160,
  });
  assert.deepEqual(plain(centerCrop({ x: -3, y: 900, width: 400, height: 300 }, { width: 320, height: 180 })), {
    x: 0, y: 0, width: 320, height: 180,
  });
});

test('moving numeric X and Y clamps the position without changing dimensions', () => {
  const start = { x: 1000, y: -50, width: 90, height: 160 };
  assert.deepEqual(plain(constrainCrop(start, { width: 320, height: 180 }, 9 / 16)), {
    x: 230, y: 0, width: 90, height: 160,
  });
});

test('numeric width and height changes keep the ratio and fixed top-left position', () => {
  const bounds = { width: 320, height: 180 };
  const width = constrainCrop({ x: 50, y: 10, width: 80, height: 100 }, bounds, 4 / 5, 'width');
  assert.deepEqual(plain(width), { x: 50, y: 10, width: 80, height: 100 });
  const height = constrainCrop({ ...width, height: 200 }, bounds, 4 / 5, 'height');
  assert.deepEqual(plain(height), { x: 50, y: 10, width: 136, height: 170 });
  const nearEdge = constrainCrop({ x: 310, y: 170, width: 100, height: 100 }, bounds, 4 / 5, 'width');
  assert.deepEqual(plain(nearEdge), { x: 310, y: 170, width: 8, height: 10 });
});

test('dragging each corner keeps its opposite corner anchored', () => {
  const bounds = { width: 400, height: 400 };
  const start = { x: 100, y: 100, width: 100, height: 125 };
  for (const [mode, delta] of [
    ['tl', { x: -40, y: -50 }], ['tr', { x: 40, y: -50 }],
    ['bl', { x: -40, y: 50 }], ['br', { x: 40, y: 50 }],
  ]) {
    const next = getDraggedCrop(start, bounds, mode, delta, 4 / 5);
    bounded(next, bounds, 4 / 5);
    assert.equal(mode.includes('l') ? next.x + next.width : next.x, mode.includes('l') ? start.x + start.width : start.x);
    assert.equal(mode.includes('t') ? next.y + next.height : next.y, mode.includes('t') ? start.y + start.height : start.y);
  }
});

test('dragging edge handles preserves the opposite edge and other-axis center', () => {
  const bounds = { width: 400, height: 400 };
  const start = { x: 100, y: 100, width: 100, height: 125 };
  for (const mode of ['l', 'r', 't', 'b']) {
    const next = getDraggedCrop(start, bounds, mode, { x: mode === 'l' ? -80 : 80, y: mode === 't' ? -100 : 100 }, 4 / 5);
    bounded(next, bounds, 4 / 5);
    if (mode === 'l' || mode === 'r') {
      assert.equal(mode === 'l' ? next.x + next.width : next.x, mode === 'l' ? start.x + start.width : start.x);
      assert.ok(Math.abs(next.y + next.height / 2 - (start.y + start.height / 2)) <= 0.5);
    } else {
      assert.equal(mode === 't' ? next.y + next.height : next.y, mode === 't' ? start.y + start.height : start.y);
      assert.ok(Math.abs(next.x + next.width / 2 - (start.x + start.width / 2)) <= 0.5);
    }
  }
});

test('move drags keep dimensions even when dragged far beyond every boundary', () => {
  const bounds = { width: 320, height: 180 };
  const start = { x: 10, y: 10, width: 90, height: 160 };
  for (const delta of [{ x: 5000, y: 5000 }, { x: -5000, y: -5000 }]) {
    const crop = getDraggedCrop(start, bounds, 'move', delta, 9 / 16);
    bounded(crop, bounds, 9 / 16);
    assert.equal(crop.width, start.width);
    assert.equal(crop.height, start.height);
  }
});

test('new selection drags preserve their starting corner in each quadrant', () => {
  const bounds = { width: 320, height: 240 };
  const start = { x: 160, y: 120, width: 0, height: 0 };
  for (const delta of [{ x: 80, y: 100 }, { x: -80, y: 100 }, { x: 80, y: -100 }, { x: -80, y: -100 }]) {
    const crop = getDraggedCrop(start, bounds, 'create', delta, 4 / 5);
    bounded(crop, bounds, 4 / 5);
    assert.equal(delta.x < 0 ? crop.x + crop.width : crop.x, start.x);
    assert.equal(delta.y < 0 ? crop.y + crop.height : crop.y, start.y);
  }
});

test('all preset drag modes stay bounded for tiny sources and extreme deltas', () => {
  for (const bounds of [{ width: 1, height: 1 }, { width: 2, height: 7 }, { width: 321, height: 181 }]) {
    for (const preset of ['1:1', '4:5', '9:16']) {
      const ratio = getPresetAspectRatio(preset);
      const start = getPresetCrop(bounds, preset);
      bounded(start, bounds, ratio);
      for (const mode of ['create', 'move', 'tl', 'tr', 'bl', 'br', 'l', 'r', 't', 'b']) {
        for (const delta of [{ x: 1e6, y: -1e6 }, { x: -1e6, y: 1e6 }, { x: 0, y: 0 }]) {
          bounded(getDraggedCrop(start, bounds, mode, delta, ratio), bounds, ratio);
        }
      }
    }
  }
});

test('free resize keeps independent dimensions and opposite corner anchoring', () => {
  const next = getDraggedCrop({ x: 50, y: 60, width: 100, height: 100 }, { width: 320, height: 180 }, 'tl', { x: -30, y: 20 });
  assert.deepEqual(plain(next), { x: 20, y: 80, width: 130, height: 80 });
});

test('selection can start at the source boundary and extend inward', () => {
  assert.deepEqual(plain(getDraggedCrop({ x: 320, y: 180, width: 0, height: 0 }, { width: 320, height: 180 }, 'create', { x: -80, y: -100 }, 4 / 5)), {
    x: 240, y: 80, width: 80, height: 100,
  });
});

test('rounding a tiny fixed-ratio selection is stable when reapplied by the UI', () => {
  const bounds = { width: 320, height: 180 };
  for (const preset of ['1:1', '4:5', '9:16']) {
    const ratio = getPresetAspectRatio(preset);
    const crop = getDraggedCrop({ x: 319, y: 179, width: 0, height: 0 }, bounds, 'create', { x: 5, y: 5 }, ratio);
    const reapplied = constrainCrop(crop, bounds, ratio);
    assert.deepEqual(plain(reapplied), plain(crop));
  }
  const crop = getDraggedCrop({ x: 0, y: 165, width: 0, height: 0 }, bounds, 'create', { x: 20, y: 20 }, 9 / 16);
  assert.deepEqual(plain(crop), { x: 0, y: 165, width: 8, height: 15 });
  assert.deepEqual(plain(constrainCrop(crop, bounds, 9 / 16)), plain(crop));
});

test('empty or invalid sources do not produce an out-of-bounds crop', () => {
  assert.deepEqual(plain(getPresetCrop({ width: 0, height: 0 }, '9:16')), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(plain(getPresetCrop({ width: NaN, height: Infinity }, '1:1')), { x: 0, y: 0, width: 0, height: 0 });
});
