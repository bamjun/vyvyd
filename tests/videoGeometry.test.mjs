import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/lib/videoGeometry.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const api = {};
runInNewContext(source, { exports: api });
const { getVideoOutputGeometry, clampVideoCrop, buildVideoFilter } = api;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('contain preserves the whole portrait in a landscape canvas with centered margins', () => {
  assert.deepEqual(plain(getVideoOutputGeometry({ width: 1080, height: 1920 }, { width: 640, height: 360 }, 'contain')), {
    width: 640, height: 360, scaledWidth: 203, scaledHeight: 360, offsetX: 218, offsetY: 0,
  });
});

test('cover scales proportionally and crops only the centered overflow', () => {
  assert.deepEqual(plain(getVideoOutputGeometry({ width: 1080, height: 1920 }, { width: 640, height: 360 }, 'cover')), {
    width: 640, height: 360, scaledWidth: 640, scaledHeight: 1138, offsetX: 0, offsetY: -389,
  });
});

test('landscape, portrait and tiny odd canvases respect fit bounds and integer centering', () => {
  for (const crop of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 301, height: 301 }]) {
    for (const output of [{ width: 321, height: 181 }, { width: 17, height: 101 }, { width: 1, height: 1 }]) {
      for (const mode of ['contain', 'cover']) {
        const g = getVideoOutputGeometry(crop, output, mode);
        assert.ok(Number.isInteger(g.offsetX) && Number.isInteger(g.offsetY));
        assert.ok(g.scaledWidth >= 1 && g.scaledHeight >= 1);
        if (mode === 'contain') {
          assert.ok(g.scaledWidth <= output.width && g.scaledHeight <= output.height);
          assert.ok(Math.abs(output.width - g.scaledWidth - 2 * g.offsetX) <= 1);
          assert.ok(Math.abs(output.height - g.scaledHeight - 2 * g.offsetY) <= 1);
        } else {
          assert.ok(g.scaledWidth >= output.width && g.scaledHeight >= output.height);
          assert.ok(Math.abs(g.scaledWidth - output.width + 2 * g.offsetX) <= 1);
          assert.ok(Math.abs(g.scaledHeight - output.height + 2 * g.offsetY) <= 1);
        }
      }
    }
  }
});

test('crop is clamped to each source with exact integer offsets and at least one pixel', () => {
  assert.deepEqual(plain(clampVideoCrop({ x: 800, y: -2, width: 999, height: 90.5 }, { width: 180, height: 320 })), {
    x: 0, y: 0, width: 180, height: 91,
  });
  assert.deepEqual(plain(clampVideoCrop({ x: 999, y: 999, width: 0, height: -1 }, { width: 180, height: 320 })), {
    x: 179, y: 319, width: 1, height: 1,
  });
});

test('FFmpeg filter uses the same placement, transparent padding and exact odd crop as preview', () => {
  const crop = { x: 3, y: 5, width: 101, height: 181 };
  const output = { width: 320, height: 180 };
  const contain = buildVideoFilter(crop, output, 'contain', 12);
  assert.equal(contain, 'crop=101:181:3:5:exact=1,scale=100:180:flags=lanczos,setsar=1,format=rgba,pad=320:180:110:0:color=0x00000000,fps=12');
  const cover = buildVideoFilter(crop, output, 'cover', 24);
  assert.equal(cover, 'crop=101:181:3:5:exact=1,scale=320:573:flags=lanczos,setsar=1,format=rgba,crop=320:180:0:196:exact=1,fps=24');
});

test('invalid dimensions, fit modes, offsets and frame rates are rejected before FFmpeg', () => {
  const crop = { x: 0, y: 0, width: 320, height: 180 };
  for (const width of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => getVideoOutputGeometry(crop, { width, height: 180 }, 'contain'));
  }
  assert.throws(() => getVideoOutputGeometry(crop, crop, 'stretch'));
  assert.throws(() => buildVideoFilter({ ...crop, x: -1 }, crop, 'contain', 12));
  assert.throws(() => buildVideoFilter(crop, crop, 'contain', 1.5));
});
