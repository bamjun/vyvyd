import assert from 'node:assert/strict';
import test from 'node:test';
import {orderLayerGeometryForHitTest} from '../packages/studio-runtime/src/layer-editor.mjs';

const definition = (id, zIndex = 0) => ({id, type: 'shape', label: id, editable: ['zIndex'], defaults: {zIndex}});
const geometry = (id, groupId = '__root__', siblingGroupId = 'root') => ({id, groupId, siblingGroupId,
  x: 0, y: 0, width: 100, height: 100, movable: true, parentBasis: {a: 1, b: 0, c: 0, d: 1}});
const ids = (layers) => layers.map((layer) => layer.id);

test('overlapping sibling hit targets follow edited zIndex and DOM ties', () => {
  const registry = [definition('first'), definition('second'), definition('third', -1)];
  const measured = registry.map((layer) => geometry(layer.id));
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {}, measured)), ['third', 'first', 'second']);
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {first: {zIndex: 2}}, measured)), ['third', 'second', 'first']);
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {first: {zIndex: 2}, second: {zIndex: 2}}, measured)), ['third', 'first', 'second']);
});

test('parent reorder carries its subtree without promoting a child over another group', () => {
  const registry = [definition('back', 0), definition('backChild', 100000),
    definition('front', 2), definition('frontChild', -100000)];
  const measured = [geometry('back'), geometry('backChild', 'back', 'back-children'),
    geometry('front'), geometry('frontChild', 'front', 'front-children')];
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {}, measured)), ['back', 'backChild', 'front', 'frontChild']);
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {back: {zIndex: 3}}, measured)), ['front', 'frontChild', 'back', 'backChild']);
});

test('unmarked parent groups preserve their DOM slots and require exact sibling evidence', () => {
  const registry = [definition('first', 8), definition('unmarkedChild', 100000), definition('last', 0)];
  const measured = [geometry('first'), geometry('unmarkedChild', '__root__', 'unmarked-wrapper'), geometry('last')];
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {}, measured)), ['last', 'unmarkedChild', 'first']);
  const unknownParents = measured.map(({siblingGroupId: ignored, ...layer}) => {void ignored; return layer;});
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {}, unknownParents)), ['first', 'unmarkedChild', 'last']);
});

test('bad cyclic ancestry cannot hang canvas hit ordering', () => {
  const registry = [definition('a'), definition('b')];
  const measured = [geometry('a', 'b', 'a-parent'), geometry('b', 'a', 'b-parent')];
  assert.deepEqual(ids(orderLayerGeometryForHitTest(registry, {}, measured)), ['a', 'b']);
});
