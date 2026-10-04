import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  getEffectiveLayerValues, getLayerReorderPatch, inverseTransformDelta,
  parseLayerNumber, readStudioLayerRegistry, rebaseStudioLayerDraft,
} from '../packages/studio-runtime/src/layer-editor.mjs';

const layer = (id, overrides = {}) => ({id, type: 'text', label: id, editable: ['x', 'y', 'zIndex', 'text', 'hidden', 'locked'], defaults: {text: id}, ...overrides});
const geometry = (id, overrides = {}) => ({id, x: 0, y: 0, width: 100, height: 100, groupId: '__root__', movable: true, parentBasis: {a: 1, b: 0, c: 0, d: 1}, ...overrides});
const document = (layers, assets = []) => ({source: {files: {'src/layers.json': JSON.stringify(layers)}}, assets});
const apply = (edits, patch) => Object.fromEntries(Object.keys({...edits, ...patch}).map((id) => [id, {...edits[id], ...patch[id]}]));
const orderedIds = (registry, edits, measured) => measured.map((item, index) => ({id: item.id, index, zIndex: getEffectiveLayerValues(registry.find((definition) => definition.id === item.id), edits).zIndex}))
  .sort((left, right) => left.zIndex - right.zIndex || left.index - right.index).map((item) => item.id);

test('registry parsing rejects invalid contracts and gives a detached browser-safe definition', () => {
  const original = layer('title');
  const parsed = readStudioLayerRegistry(document([original]));
  assert.deepEqual(parsed, [original]);
  parsed[0].defaults.text = 'changed';
  assert.equal(original.defaults.text, 'title');
  assert.deepEqual(readStudioLayerRegistry({source: {files: {}}, assets: []}), []);
  assert.throws(() => readStudioLayerRegistry(document([original, original])), /중복/);
  assert.throws(() => readStudioLayerRegistry(document([layer('constructor')])), /ID/);
  assert.throws(() => readStudioLayerRegistry(document([layer('title', {editable: ['x', 'anything']})])), /속성/);
  assert.throws(() => readStudioLayerRegistry(document([layer('title', {defaults: {width: 0}})])), /기본값/);
  assert.throws(() => readStudioLayerRegistry(document([layer('image', {type: 'image', defaults: {assetId: 'missing'}})])), /기본값/);
  assert.throws(() => readStudioLayerRegistry({source: {files: {'src/layers.json': '{'}}, assets: []}), /읽을/);
});

test('effective values honor zero, false and empty string while ignoring undeclared overrides', () => {
  const definition = layer('title', {defaults: {x: 20, text: 'default', hidden: true, width: 400}});
  const edits = {title: {x: 0, text: '', hidden: false, width: 999}};
  const effective = getEffectiveLayerValues(definition, edits);
  assert.equal(effective.x, 0);
  assert.equal(effective.text, '');
  assert.equal(effective.hidden, false);
  assert.equal(effective.width, 400);
  assert.equal(effective.opacity, 1);
  assert.equal(getEffectiveLayerValues(definition, {title: {x: null}}).x, 20);
  assert.deepEqual(edits, {title: {x: 0, text: '', hidden: false, width: 999}});
});

test('numeric input rejects unfinished or out of range values without turning an empty field into zero', () => {
  for (const text of ['', ' ', '-', '.', 'Infinity', 'NaN', '100001']) assert.equal(parseLayerNumber('x', text), null);
  assert.equal(parseLayerNumber('x', '-12.5'), -12.5);
  assert.equal(parseLayerNumber('x', '0'), 0);
  assert.equal(parseLayerNumber('width', '0'), null);
  assert.equal(parseLayerNumber('scale', '-1'), null);
  assert.equal(parseLayerNumber('opacity', '1.01'), null);
  assert.equal(parseLayerNumber('opacity', '0'), 0);
  assert.equal(parseLayerNumber('zIndex', '1.5'), null);
  assert.equal(parseLayerNumber('text', '1'), null);
});

test('drag deltas are converted through rotation and unequal parent scale', () => {
  assert.deepEqual(inverseTransformDelta({a: 0, b: 2, c: -3, d: 0}, {x: -15, y: 8}), {x: 4, y: 5});
  assert.deepEqual(inverseTransformDelta({a: 2, b: 0, c: 0, d: 4}, {x: 10, y: -12}), {x: 5, y: -3});
  assert.equal(inverseTransformDelta({a: 1, b: 2, c: 2, d: 4}, {x: 10, y: 10}), null);
  assert.equal(inverseTransformDelta({a: NaN, b: 0, c: 0, d: 1}, {x: 0, y: 0}), null);
});

test('reordering handles tied zIndex values and only moves one place in actual sibling order', () => {
  const registry = ['a', 'b', 'c', 'd'].map((id) => layer(id));
  const measured = registry.map(({id}) => geometry(id));
  const first = getLayerReorderPatch(registry, {}, measured, 'a', 'up');
  assert.ok(first);
  assert.deepEqual(orderedIds(registry, apply({}, first), measured), ['b', 'a', 'c', 'd']);
  const second = getLayerReorderPatch(registry, apply({}, first), measured, 'a', 'down');
  assert.ok(second);
  assert.deepEqual(orderedIds(registry, apply(apply({}, first), second), measured), ['a', 'b', 'c', 'd']);
  assert.equal(getLayerReorderPatch(registry, {}, measured, 'a', 'down'), null);
  assert.equal(getLayerReorderPatch(registry, {}, measured, 'd', 'up'), null);
});

test('reordering uses actual sibling groups and preserves locked and unrelated layer properties', () => {
  const registry = ['a', 'b', 'c'].map((id) => layer(id));
  const measured = [geometry('a', {siblingGroupId: 'wrapper-1'}), geometry('b', {siblingGroupId: 'wrapper-1', locked: true}), geometry('c', {siblingGroupId: 'wrapper-2'})];
  const edits = {a: {zIndex: 10, x: 40}, b: {zIndex: 20, locked: true}, c: {zIndex: 50}};
  const patch = getLayerReorderPatch(registry, edits, measured, 'a', 'up');
  assert.deepEqual(patch, {a: {zIndex: 21}});
  assert.equal(patch.b, undefined);
  assert.equal(patch.c, undefined);
  assert.deepEqual(apply(edits, patch).a, {zIndex: 21, x: 40});
  assert.equal(getLayerReorderPatch(registry, edits, measured, 'b', 'down'), null);
  assert.equal(getLayerReorderPatch(registry, edits, measured, 'c', 'down'), null);
  assert.equal(getLayerReorderPatch([registry[0], layer('b', {editable: ['x']})], {}, measured, 'a', 'up'), null);
  assert.equal(getLayerReorderPatch(registry, {}, [geometry('a', {locked: true}), geometry('b')], 'a', 'up'), null);
});

test('reordering refuses tie renumbering that would alter a locked layer', () => {
  const registry = ['a', 'b', 'c'].map((id) => layer(id));
  assert.equal(getLayerReorderPatch(registry, {}, [geometry('a'), geometry('b'), geometry('c', {locked: true})], 'a', 'up'), null);
});

test('draft rebase preserves untouched external changes and applies only user changes and removals', () => {
  const registry = [layer('title'), layer('logo')];
  const base = {title: {x: 10, y: 20, text: 'old'}, logo: {x: 40}};
  const draft = {title: {x: 50, text: 'old'}, logo: {x: 40}};
  const latest = {title: {x: 11, y: 99, text: 'external', hidden: true}, logo: {x: 70}};
  const result = rebaseStudioLayerDraft(base, draft, latest, registry, []);
  assert.deepEqual(result, {layers: {title: {x: 50, text: 'external', hidden: true}, logo: {x: 70}}, discarded: []});
  assert.deepEqual(latest.title, {x: 11, y: 99, text: 'external', hidden: true});
});

test('draft rebase reports removed capabilities, missing layers and unavailable images explicitly', () => {
  const registry = [layer('title', {label: '제목', editable: ['text']}), layer('logo', {label: '로고', type: 'image', editable: ['assetId']})];
  const base = {title: {x: 10}, removed: {text: 'old'}};
  const draft = {title: {x: 30, text: 'new'}, removed: {text: 'updated'}, logo: {assetId: 'lost-image'}};
  assert.deepEqual(rebaseStudioLayerDraft(base, draft, {title: {text: 'external'}}, registry, []), {
    layers: {title: {text: 'new'}}, discarded: ['제목 (x)', 'removed (text)', '로고 (assetId)'],
  });
});

test('removing a local layer override does not erase a new external property on that layer', () => {
  assert.deepEqual(rebaseStudioLayerDraft({title: {x: 10}}, {}, {title: {x: 11, text: 'external'}}, [layer('title')], []), {
    layers: {title: {text: 'external'}}, discarded: [],
  });
});
