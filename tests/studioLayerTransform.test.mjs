import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getEffectiveLayerValues} from '../packages/studio-runtime/src/layer-editor.mjs';
import {getLayerAlignmentPatch, getLayerTransformFrame, predictLayerGeometry, resizeLayerFromDelta,
  rotateLayerFromPointers, snapLayerTranslation} from '../packages/studio-runtime/src/layer-transform.mjs';
import {createDomLayerGeometrySource, readLayerOrigin} from '../packages/studio-runtime/src/dom-layer-geometry.mjs';

const identity = {a: 1, b: 0, c: 0, d: 1};
const apply = (basis, point) => ({x: basis.a * point.x + basis.c * point.y, y: basis.b * point.x + basis.d * point.y});
const add = (left, right) => ({x: left.x + right.x, y: left.y + right.y});
const rotation = (degrees, scale = 1) => {const angle = degrees * Math.PI / 180; return {a: Math.cos(angle) * scale, b: Math.sin(angle) * scale, c: -Math.sin(angle) * scale, d: Math.cos(angle) * scale};};
const close = (actual, expected, tolerance = 0.05) => {
  assert.ok(Math.abs(actual.x - expected.x) <= tolerance && Math.abs(actual.y - expected.y) <= tolerance,
    `expected ${JSON.stringify(actual)} near ${JSON.stringify(expected)}`);
};
const definition = (defaults = {}, editable = ['x', 'y', 'width', 'height', 'rotation', 'locked', 'hidden']) => ({
  id: 'box', type: 'shape', label: '도형', editable,
  defaults: {x: 100, y: 150, width: 120, height: 80, rotation: 0, ...defaults},
});
const measured = (layer = definition(), {basis = rotation(layer.defaults.rotation), parentBasis = identity,
  originRatio = {x: 0.5, y: 0.5}, originOffset = {x: 0, y: 0}, ...rest} = {}) => {
  const {x, y, width, height} = getEffectiveLayerValues(layer, {});
  const origin = {x: originRatio.x * width + originOffset.x, y: originRatio.y * height + originOffset.y};
  const points = [{x: 0, y: 0}, {x: width, y: 0}, {x: width, y: height}, {x: 0, y: height}].map((point) =>
    apply(parentBasis, add(add({x, y}, origin), apply(basis, {x: point.x - origin.x, y: point.y - origin.y}))));
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return {id: layer.id, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    movable: true, locked: false, groupId: '__root__', parentBasis,
    transform: {basis, width, height, originRatio, originOffset, resizable: true, rotatable: true}, ...rest};
};
const pointAt = (frame, horizontal, vertical) => ({
  x: frame.points[0].x + (frame.points[1].x - frame.points[0].x) * horizontal + (frame.points[3].x - frame.points[0].x) * vertical,
  y: frame.points[0].y + (frame.points[1].y - frame.points[0].y) * horizontal + (frame.points[3].y - frame.points[0].y) * vertical,
});

test('all eight resize handles keep the opposite anchor under rotation and unequal transformed parents', () => {
  const layer = definition({rotation: 35});
  const geometry = measured(layer, {parentBasis: {a: 0, b: 2, c: -3, d: 0}});
  const frame = getLayerTransformFrame(geometry);
  for (const [handle, sx, sy] of [['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1], ['e', 1, 0], ['se', 1, 1], ['s', 0, 1], ['sw', -1, 1], ['w', -1, 0]]) {
    const delta = apply(frame.basis, {x: 20, y: 10});
    const patch = resizeLayerFromDelta(layer, {}, geometry, handle, delta);
    assert.ok(patch, handle);
    assert.equal(patch.width, 120 + sx * 20);
    assert.equal(patch.height, 80 + sy * 10);
    const after = getLayerTransformFrame(predictLayerGeometry(geometry, getEffectiveLayerValues(layer, {}), patch));
    const anchorX = sx < 0 ? 1 : sx > 0 ? 0 : 0.5, anchorY = sy < 0 ? 1 : sy > 0 ? 0 : 0.5;
    close(pointAt(after, anchorX, anchorY), pointAt(frame, anchorX, anchorY));
  }
});

test('fixed pixel and percentage transform origins both preserve the stationary resize corner', () => {
  const layer = definition({rotation: 60});
  for (const origin of [{originRatio: {x: 0, y: 0}, originOffset: {x: 20, y: 30}},
    {originRatio: {x: 0.25, y: 0.75}, originOffset: {x: 5, y: -2}}]) {
    const geometry = measured(layer, origin), frame = getLayerTransformFrame(geometry);
    const patch = resizeLayerFromDelta(layer, {}, geometry, 'nw', apply(frame.basis, {x: -30, y: -20}));
    const after = getLayerTransformFrame(predictLayerGeometry(geometry, getEffectiveLayerValues(layer, {}), patch));
    close(after.points[2], frame.points[2]);
  }
});

test('proportional resize keeps aspect ratio for corners and edges and clamps positive schema limits', () => {
  const layer = definition(), geometry = measured(layer);
  for (const handle of ['se', 'n', 'w']) {
    const patch = resizeLayerFromDelta(layer, {}, geometry, handle, {x: 20, y: 10}, {proportional: true});
    assert.ok(Math.abs(patch.width / patch.height - 1.5) < 0.0002);
    assert.ok(patch.width >= 1 && patch.height >= 1);
  }
  assert.equal(resizeLayerFromDelta(layer, {}, geometry, 'se', {x: -500, y: -500}).width, 1);
  assert.equal(resizeLayerFromDelta(layer, {}, geometry, 'se', {x: 1000000, y: 1000000}).width, 100000);
  const maximum = resizeLayerFromDelta(layer, {}, geometry, 'se', {x: 1000000, y: 1000000}, {proportional: true});
  assert.ok(maximum.width <= 100000 && maximum.height <= 100000);
});

test('resize and rotation reject locks, unsupported transforms, missing properties and mismatched authored layout', () => {
  const layer = definition(), geometry = measured(layer);
  for (const denied of [{...geometry, locked: true}, {...geometry, movable: false}, {...geometry, transform: undefined},
    {...geometry, transform: {...geometry.transform, resizable: false}}]) {
    assert.equal(resizeLayerFromDelta(layer, {}, denied, 'se', {x: 10, y: 20}), null);
  }
  assert.equal(resizeLayerFromDelta(layer, {box: {locked: true}}, geometry, 'se', {x: 10, y: 20}), null);
  assert.equal(resizeLayerFromDelta(definition({}, ['width', 'height']), {}, geometry, 'se', {x: 10, y: 20}), null);
  assert.equal(resizeLayerFromDelta(layer, {}, {...geometry, transform: {...geometry.transform, width: 90}}, 'se', {x: 10, y: 20}), null);
  assert.equal(rotateLayerFromPointers(layer, {}, {...geometry, transform: {...geometry.transform, rotatable: false}}, {x: 10, y: 20}, {x: 20, y: 30}), null);
  assert.equal(getLayerTransformFrame({...geometry, parentBasis: {a: 1, b: 1, c: 1, d: 1}}), null);
});

test('rotation measures around the true origin through unequal parent scales and supports 15 degree snapping', () => {
  const layer = definition({rotation: 30}), geometry = measured(layer, {parentBasis: {a: 0, b: 2, c: -3, d: 0}});
  const frame = getLayerTransformFrame(geometry);
  const start = add(frame.origin, apply(geometry.parentBasis, {x: 100, y: 0}));
  const end = add(frame.origin, apply(geometry.parentBasis, {x: 0, y: 100}));
  assert.deepEqual(rotateLayerFromPointers(layer, {}, geometry, start, end), {rotation: 120});
  const angle = 37 * Math.PI / 180;
  const at37 = add(frame.origin, apply(geometry.parentBasis, {x: Math.cos(angle) * 100, y: Math.sin(angle) * 100}));
  assert.deepEqual(rotateLayerFromPointers(layer, {}, geometry, start, at37, {snap: true}), {rotation: 60});
  const predicted = predictLayerGeometry(geometry, getEffectiveLayerValues(layer, {}), {rotation: 120});
  close(getLayerTransformFrame(predicted).origin, frame.origin, 1e-8);
});

test('alignment moves actual visible bounds to canvas edges and center with parent inverse mapping', () => {
  const layer = definition({rotation: 35}), geometry = measured(layer, {parentBasis: {a: 0, b: 2, c: -3, d: 0}});
  const composition = {width: 1000, height: 800};
  for (const alignment of ['left', 'centerX', 'right', 'top', 'centerY', 'bottom', 'center']) {
    const patch = getLayerAlignmentPatch(layer, {}, geometry, composition, alignment);
    const move = apply(geometry.parentBasis, {x: patch.x - layer.defaults.x, y: patch.y - layer.defaults.y});
    const box = {...geometry, x: geometry.x + move.x, y: geometry.y + move.y};
    if (alignment === 'left') assert.ok(Math.abs(box.x) < 0.05);
    if (alignment === 'right') assert.ok(Math.abs(box.x + box.width - 1000) < 0.05);
    if (alignment === 'top') assert.ok(Math.abs(box.y) < 0.05);
    if (alignment === 'bottom') assert.ok(Math.abs(box.y + box.height - 800) < 0.05);
    if (alignment === 'centerX' || alignment === 'center') assert.ok(Math.abs(box.x + box.width / 2 - 500) < 0.05);
    if (alignment === 'centerY' || alignment === 'center') assert.ok(Math.abs(box.y + box.height / 2 - 400) < 0.05);
  }
  assert.equal(getLayerAlignmentPatch(layer, {}, {...geometry, locked: true}, composition, 'center'), null);
  assert.equal(getLayerAlignmentPatch(layer, {}, {...geometry, transform: undefined}, composition, 'center') !== null, true, 'older previews retain alignment');
});

test('translation guides select closest canvas or peer anchors, support Alt bypass and ignore moving descendants', () => {
  const geometry = {...measured(), x: 103, y: 107, width: 100, height: 80};
  const composition = {width: 600, height: 500};
  const peer = {...geometry, id: 'other', x: 250, y: 300};
  const snapped = snapLayerTranslation(geometry, {x: 145, y: 112}, composition, [peer], {thresholdX: 4, thresholdY: 4});
  assert.deepEqual(snapped.delta, {x: 147, y: 113});
  assert.deepEqual(snapped.guides, [{axis: 'x', value: 250}, {axis: 'y', value: 300}]);
  assert.deepEqual(snapLayerTranslation(geometry, {x: 145, y: 112}, composition, [peer], {bypass: true}), {delta: {x: 145, y: 112}, guides: []});
  const child = {...peer, id: 'child', groupId: 'box'};
  assert.equal(snapLayerTranslation(geometry, {x: 145, y: 112}, {width: 2000, height: 2000}, [child], {thresholdX: 4, thresholdY: 4}).guides.length, 0);
});

const domFixture = ({origin = '50% 50%', computedOrigin = '60px 40px', transform = 'matrix(1, 0, 0, 1, 0, 0)', inlineTransform = '', width = 120, height = 80,
  bounds = {left: 100, top: 150, width: 120, height: 80}} = {}) => {
  const style = {transform, transformOrigin: computedOrigin, width: `${width}px`, height: `${height}px`, boxSizing: 'border-box', zoom: '1'};
  const stage = {getBoundingClientRect: () => ({left: 0, top: 0, width: 1000, height: 1000}), querySelectorAll: () => [element]};
  const element = {parentElement: stage, offsetWidth: width, offsetHeight: height, style: {transformOrigin: origin, transform: inlineTransform},
    getAttribute: () => 'box', getClientRects: () => [bounds], getBoundingClientRect: () => bounds};
  return {style, stage, element};
};

test('DOM origin metadata distinguishes default center, authored pixels, keywords and mixed calc origins', () => {
  assert.deepEqual(readLayerOrigin({style: {}}, {transformOrigin: '60px 40px'}, 120, 80), {originRatio: {x: 0.5, y: 0.5}, originOffset: {x: 0, y: 0}, reliable: true});
  assert.deepEqual(readLayerOrigin({style: {transformOrigin: '20px 30px'}}, {transformOrigin: '20px 30px'}, 120, 80), {originRatio: {x: 0, y: 0}, originOffset: {x: 20, y: 30}, reliable: true});
  assert.equal(readLayerOrigin({style: {transformOrigin: 'top right'}}, {transformOrigin: '120px 0px'}, 120, 80).reliable, true);
  assert.deepEqual(readLayerOrigin({style: {transformOrigin: 'calc(50% + 10px) 25%'}}, {transformOrigin: '70px 20px'}, 120, 80), {originRatio: {x: 0.5, y: 0.25}, originOffset: {x: 10, y: 0}, reliable: true});
  assert.equal(readLayerOrigin({style: {}}, {transformOrigin: '20px 30px'}, 120, 80).reliable, false);
});

test('embedded DOM measurement emits reliable optional handle geometry and conservatively disables ambiguous resizing', () => {
  for (const {fixture, resizable, rotatable} of [
    {fixture: domFixture(), resizable: true, rotatable: true},
    {fixture: domFixture({origin: '20px 30px', computedOrigin: '20px 30px'}), resizable: true, rotatable: true},
    {fixture: domFixture({origin: '', computedOrigin: '20px 30px'}), resizable: false, rotatable: true},
    {fixture: domFixture({inlineTransform: 'translate(-50%, -50%)', transform: 'matrix(1, 0, 0, 1, -60, -40)'}), resizable: false, rotatable: false},
    {fixture: domFixture({inlineTransform: 'rotate(0deg) translateX(20px)', transform: 'matrix(1, 0, 0, 1, 20, 0)'}), resizable: true, rotatable: false},
  ]) {
    const measure = new Function('getComputedStyle', `${createDomLayerGeometrySource()}; return measureDomLayers;`)(() => fixture.style);
    const [geometry] = measure(fixture.stage, {width: 1000, height: 1000}, [definition()], {}, () => 'parent').layers;
    assert.ok(geometry.transform);
    assert.equal(geometry.transform.rotatable, rotatable);
    assert.equal(geometry.transform.resizable, resizable);
    if (fixture.element.style.transformOrigin === '20px 30px') assert.deepEqual(geometry.transform.originOffset, {x: 20, y: 30});
  }
});

test('DOM measurement can describe rotated boxes but rejects 3D and inconsistent measured extents', () => {
  for (const {fixture, expected} of [
    {fixture: domFixture({transform: 'matrix(0, 1, -1, 0, 0, 0)', bounds: {left: 100, top: 150, width: 80, height: 120}}), expected: true},
    {fixture: domFixture({transform: 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)'}), expected: false},
    {fixture: domFixture({bounds: {left: 100, top: 150, width: 160, height: 80}}), expected: false},
  ]) {
    const measure = new Function('getComputedStyle', `${createDomLayerGeometrySource()}; return measureDomLayers;`)(() => fixture.style);
    const [geometry] = measure(fixture.stage, {width: 1000, height: 1000}, [definition()], {}, () => 'parent').layers;
    assert.equal(Boolean(geometry.transform), expected);
    if (expected) assert.deepEqual(geometry.transform.basis, {a: 0, b: 1, c: -1, d: 0});
  }
});
