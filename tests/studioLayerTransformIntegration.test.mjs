import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as editor from '../packages/studio-runtime/src/layer-editor.mjs';
import * as transform from '../packages/studio-runtime/src/layer-transform.mjs';
import {beginEditHistory, createEditHistory, endEditHistory, recordEditHistory, redoEditHistory, undoEditHistory} from '../packages/studio-runtime/src/edit-history.mjs';

const identity = {a: 1, b: 0, c: 0, d: 1};
const label = '제목';
const definition = (changes = {}) => ({id: 'title', label, type: 'shape',
  editable: ['x', 'y', 'width', 'height', 'rotation', 'hidden', 'locked'],
  defaults: {x: 100, y: 150, width: 100, height: 80, rotation: 0, scale: 1, hidden: false, locked: false}, ...changes});
const measured = (changes = {}) => ({id: 'title', x: 100, y: 150, width: 100, height: 80,
  groupId: '__root__', siblingGroupId: 'root', movable: true, locked: false, parentBasis: identity,
  transform: {basis: identity, width: 100, height: 80, originRatio: {x: 0.5, y: 0.5}, originOffset: {x: 0, y: 0}, resizable: true, rotatable: true}, ...changes});
const clone = (value) => structuredClone(value);
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected, tolerance = 0.02) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const source = () => ts.transpileModule(readFileSync(new URL('../src/features/studio/StudioLayerOverlay.tsx', import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX},
}).outputText;

// Use the production event handlers and edit-history module. Only the DOM host
// and React scheduling are supplied, so transaction/patch bugs remain observable.
const mountOverlay = ({registry = [definition()], geometry = [measured()], edits = {}, history: suppliedHistory,
  disabled = false, geometryReady = true, bounds = {left: 0, top: 0, width: 1000, height: 800}} = {}) => {
  const slots = [];
  const effects = [];
  const listeners = new Map();
  const targets = new Map();
  const events = [];
  const patches = [];
  let cursor = 0;
  let tree;
  let selectedId = registry[0]?.id ?? null;
  let cancel;
  let history = suppliedHistory ?? createEditHistory({fields: {}, layers: clone(edits)});
  const memo = (create, deps) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !deps || deps.some((value, position) => !Object.is(value, previous.deps[position]))) slots[index] = {value: create(), deps};
    return slots[index].value;
  };
  const element = (type, props) => {
    if (props?.['data-testid'] === 'studio-layer-overlay' && props.ref) props.ref.current = {getBoundingClientRect: () => bounds};
    return {type, props: props ?? {}};
  };
  const react = {
    useRef(initial) {const index = cursor++; if (!slots[index]) slots[index] = {current: initial}; return slots[index];},
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, (next) => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];
    },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !deps || deps.some((value, position) => !Object.is(value, slots[index].deps[position]))) {
        effects.push({index, effect, previous: slots[index]?.cleanup});
        slots[index] = {deps};
      }
    },
  };
  const window = {
    addEventListener(type, handler) {if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler);},
    removeEventListener(type, handler) {listeners.get(type)?.delete(handler);},
  };
  const api = {};
  runInNewContext(source(), {exports: api, console, window, Error,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return {jsx: element, jsxs: element, Fragment: 'Fragment'};
      if (name.endsWith('/layer-editor.mjs')) return editor;
      if (name.endsWith('/layer-transform.mjs')) return transform;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const onChange = (id, patch) => {
    patches.push({id, patch: plain(patch)});
    const next = {...history.present.layers};
    const values = {...next[id]};
    const editable = registry.find((layer) => layer.id === id)?.editable ?? [];
    for (const [key, value] of Object.entries(patch)) {
      if (!editable.includes(key)) continue;
      if (value === null) delete values[key]; else values[key] = value;
    }
    if (Object.keys(values).length) next[id] = values; else delete next[id];
    history = recordEditHistory(history, {...history.present, layers: next});
  };
  const onSelect = (id) => {selectedId = id;};
  const onBeginInteraction = () => {events.push('begin'); history = beginEditHistory(history);};
  const onEndInteraction = () => {events.push('end'); history = endEditHistory(history);};
  const onRegisterCancelInteraction = (callback) => {cancel = callback;};
  const render = () => {
    cursor = 0;
    tree = api.default({registry, geometry, edits: history.present.layers, composition: {width: 1000, height: 800},
      selectedId, disabled, geometryReady, onSelect, onChange, onBeginInteraction, onEndInteraction, onRegisterCancelInteraction});
    effects.splice(0).forEach(({index, effect, previous}) => {previous?.(); slots[index].cleanup = effect();});
    return tree;
  };
  const nodes = (predicate) => {
    const found = [];
    const visit = (node) => {
      if (Array.isArray(node)) {node.forEach(visit); return;}
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) found.push(node);
      visit(node.props?.children);
    };
    visit(tree);
    return found;
  };
  const button = (name) => {
    const node = nodes((entry) => entry.type === 'button' && entry.props['aria-label'] === name)[0];
    assert.ok(node, `Missing button ${name}`);
    return node;
  };
  const targetFor = (name) => {
    if (!targets.has(name)) {
      const captures = new Set();
      targets.set(name, {focus() {}, setPointerCapture: (id) => captures.add(id), hasPointerCapture: (id) => captures.has(id), releasePointerCapture: (id) => captures.delete(id)});
    }
    return targets.get(name);
  };
  const pointer = (name, handler, x, y, overrides = {}) => {
    const node = button(name);
    assert.equal(typeof node.props[handler], 'function', `${name} must expose ${handler}`);
    const event = {button: 0, pointerId: 7, clientX: x, clientY: y, isPrimary: true, shiftKey: false, altKey: false,
      preventDefault() {}, stopPropagation() {}, currentTarget: targetFor(name), ...overrides};
    node.props[handler](event);
    render();
  };
  const dispatch = (type, values = {}) => {
    for (const callback of listeners.get(type) ?? []) callback({preventDefault() {}, stopPropagation() {}, ...values});
    render();
  };
  render();
  return {
    nodes, button, pointer, dispatch, patches, events,
    render(next = {}) {if ('disabled' in next) disabled = next.disabled; if ('geometryReady' in next) geometryReady = next.geometryReady;
      if ('selectedId' in next) selectedId = next.selectedId; if ('geometry' in next) geometry = next.geometry; return render();},
    history: () => history,
    values: () => editor.getEffectiveLayerValues(registry[0], history.present.layers),
    undo() {history = undoEditHistory(history); render();},
    redo() {history = redoEditHistory(history); render();},
    cancel() {cancel?.(); render();},
    unmount() {for (const slot of slots) slot?.cleanup?.();},
  };
};

const southeast = `${label} 크기 조절: 오른쪽 아래`;
const rotation = `${label} 회전 조절`;
const main = `캔버스 레이어: ${label}`;

test('selected layers expose eight distinct resize controls and a rotation control without nested buttons', () => {
  const host = mountOverlay();
  const handles = host.nodes((node) => node.type === 'button' && String(node.props['aria-label']).startsWith(`${label} 크기 조절:`));
  assert.equal(handles.length, 8);
  assert.equal(new Set(handles.map((node) => node.props['aria-label'])).size, 8);
  assert.ok(host.button(rotation));
  const hasButton = (node) => Array.isArray(node) ? node.some(hasButton)
    : Boolean(node && typeof node === 'object' && (node.type === 'button' || hasButton(node.props?.children)));
  for (const node of host.nodes((entry) => entry.type === 'button')) assert.equal(hasButton(node.props.children), false);
  host.unmount();
});

test('resize drags publish live dimensions and make exactly one undo/redo step', () => {
  const host = mountOverlay();
  host.pointer(southeast, 'onPointerDown', 200, 230);
  host.pointer(southeast, 'onPointerMove', 225, 250);
  host.render({geometryReady: false});
  host.pointer(southeast, 'onPointerMove', 250, 270);
  near(host.values().width, 150); near(host.values().height, 120);
  near(host.values().x, 100); near(host.values().y, 150);
  assert.equal(host.history().past.length, 0, 'a live geometry refresh must not finish the active gesture');
  host.pointer(southeast, 'onPointerUp', 250, 270);
  assert.deepEqual(host.events, ['begin', 'end']);
  assert.equal(host.history().past.length, 1);
  assert.equal(host.history().transaction, null);
  host.undo(); near(host.values().width, 100); near(host.values().height, 80);
  host.redo(); near(host.values().width, 150); near(host.values().height, 120);
  host.unmount();
});

test('rotation drags commit one history entry and Shift uses 15-degree increments', () => {
  const host = mountOverlay();
  host.pointer(rotation, 'onPointerDown', 150, 130);
  host.pointer(rotation, 'onPointerMove', 150 + 60 * Math.sin(Math.PI / 4), 190 - 60 * Math.cos(Math.PI / 4));
  host.pointer(rotation, 'onPointerMove', 210, 190);
  near(host.values().rotation, 90);
  host.pointer(rotation, 'onPointerUp', 210, 190);
  assert.equal(host.history().past.length, 1);
  host.undo(); near(host.values().rotation, 0);
  host.redo(); near(host.values().rotation, 90);
  host.unmount();
  const snapped = mountOverlay();
  snapped.pointer(rotation, 'onPointerDown', 150, 130);
  snapped.pointer(rotation, 'onPointerMove', 150 + 60 * Math.sin(17 * Math.PI / 180), 190 - 60 * Math.cos(17 * Math.PI / 180), {shiftKey: true});
  near(snapped.values().rotation, 15);
  snapped.pointer(rotation, 'onPointerUp', 170, 130);
  snapped.unmount();
});

test('Shift resize preserves aspect ratio and scaled player coordinates remain composition pixels', () => {
  const host = mountOverlay();
  host.pointer(southeast, 'onPointerDown', 200, 230);
  host.pointer(southeast, 'onPointerMove', 250, 250, {shiftKey: true});
  near(host.values().width / host.values().height, 100 / 80);
  assert.ok(host.values().width > 100);
  host.pointer(southeast, 'onPointerUp', 250, 250);
  host.unmount();
  const scaled = mountOverlay({bounds: {left: 20, top: 30, width: 500, height: 400}});
  scaled.pointer(southeast, 'onPointerDown', 120, 145);
  scaled.pointer(southeast, 'onPointerMove', 145, 165);
  near(scaled.values().width, 150); near(scaled.values().height, 120);
  scaled.pointer(southeast, 'onPointerUp', 145, 165);
  scaled.unmount();
});

test('Escape, pointer cancellation and capture loss restore absent overrides without consuming redo', async (t) => {
  for (const [handle, start, end] of [[southeast, [200, 230], [250, 270]], [rotation, [150, 130], [210, 190]]]) {
    for (const cancel of ['escape', 'pointer', 'capture']) {
      await t.test(`${handle}: ${cancel}`, () => {
        const changed = recordEditHistory(createEditHistory({fields: {}, layers: {}}), {fields: {}, layers: {title: {width: 120}}});
        const history = undoEditHistory(changed);
        const host = mountOverlay({history});
        host.pointer(handle, 'onPointerDown', ...start);
        host.pointer(handle, 'onPointerMove', ...end);
        if (cancel === 'escape') host.dispatch('keydown', {key: 'Escape'});
        else host.pointer(handle, cancel === 'pointer' ? 'onPointerCancel' : 'onLostPointerCapture', ...end);
        assert.deepEqual(host.history().present.layers, {});
        assert.equal(host.history().past.length, 0);
        assert.equal(host.history().future.length, 1);
        assert.equal(host.history().transaction, null);
        assert.ok(host.patches.some(({patch}) => handle === rotation ? patch.rotation === null : patch.width === null && patch.height === null));
        host.redo(); near(host.values().width, 120);
        host.unmount();
      });
    }
  }
});

test('pointer round trips restore original override presence and preserve an existing redo branch', async (t) => {
  for (const explicit of [false, true]) {
    for (const [handle, start, end, restoredKeys] of [
      [southeast, [200, 230], [250, 270], ['x', 'y', 'width', 'height']],
      [rotation, [150, 130], [210, 190], ['rotation']],
      [main, [100, 150], [300, 350], ['x', 'y']],
    ]) {
      await t.test(`${explicit ? 'explicit defaults' : 'absent defaults'}: ${handle}`, () => {
        const overrides = explicit ? {locked: false, x: 100, y: 150, width: 100, height: 80, rotation: 0} : {locked: false};
        const initial = {fields: {name: '기존 작업'}, layers: {title: overrides}};
        const committed = recordEditHistory(createEditHistory(initial), {...initial, layers: {title: {...overrides, width: 120}}});
        const history = undoEditHistory(committed);
        const redo = history.future;
        const host = mountOverlay({history});
        const originalValues = clone(host.values());
        host.pointer(handle, 'onPointerDown', ...start, {altKey: true});
        host.pointer(handle, 'onPointerMove', ...end, {altKey: true});
        assert.notDeepEqual(host.values(), originalValues, 'the outward motion must produce an actual edit');
        host.pointer(handle, 'onPointerMove', ...start, {altKey: true});
        host.pointer(handle, 'onPointerUp', ...start, {altKey: true});
        assert.deepEqual(host.history().present, initial);
        assert.deepEqual(host.values(), originalValues);
        assert.equal(host.history().transaction, null);
        assert.equal(host.history().past.length, 0);
        assert.equal(host.history().future, redo);
        const finalPatch = host.patches.at(-1).patch;
        for (const key of restoredKeys) assert.equal(finalPatch[key], explicit ? overrides[key] : null);
        host.redo(); near(host.values().width, 120);
        host.unmount();
      });
    }
  }
});

test('replacing the source overlay cancels an active gesture and unrelated pointers cannot finish it', () => {
  const host = mountOverlay();
  host.pointer(southeast, 'onPointerDown', 200, 230, {button: 2});
  assert.deepEqual(host.events, []);
  host.pointer(southeast, 'onPointerDown', 200, 230);
  host.pointer(southeast, 'onPointerMove', 300, 330, {pointerId: 8});
  near(host.values().width, 100);
  host.pointer(southeast, 'onPointerMove', 250, 270);
  host.pointer(southeast, 'onPointerUp', 250, 270, {pointerId: 8});
  assert.ok(host.history().transaction);
  host.unmount();
  assert.deepEqual(host.history().present.layers, {});
  assert.equal(host.history().transaction, null);
  assert.equal(host.history().past.length, 0);
});

test('disabled, stale and changed selection reject or cancel gestures; locked layers expose no transform controls', async (t) => {
  for (const options of [{disabled: true}, {geometryReady: false}]) {
    const host = mountOverlay(options);
    const controls = host.nodes((node) => node.type === 'button' && node.props['aria-label'] === southeast);
    if (controls.length) host.pointer(southeast, 'onPointerDown', 200, 230);
    assert.equal(host.events.length, 0);
    assert.deepEqual(host.history().present.layers, {});
    host.unmount();
  }
  for (const options of [{edits: {title: {locked: true}}}, {geometry: [measured({locked: true})]},
    {registry: [definition({editable: ['x', 'y']})]}, {geometry: [measured({transform: undefined})]}]) {
    const host = mountOverlay(options);
    assert.equal(host.nodes((node) => node.type === 'button' && (node.props['aria-label'] === southeast || node.props['aria-label'] === rotation)).length, 0);
    host.unmount();
  }
  for (const change of [{disabled: true}, {selectedId: null}]) {
    const host = mountOverlay();
    host.pointer(southeast, 'onPointerDown', 200, 230);
    host.pointer(southeast, 'onPointerMove', 250, 270);
    host.render(change);
    assert.deepEqual(host.history().present.layers, {});
    assert.equal(host.history().past.length, 0);
    assert.equal(host.history().transaction, null);
    host.unmount();
  }
  await t.test('hidden layers have neither hit targets nor handles', () => {
    const host = mountOverlay({edits: {title: {hidden: true}}});
    assert.equal(host.nodes((node) => node.type === 'button').length, 0);
    host.unmount();
  });
});

test('move snapping shows a canvas guide while Alt keeps the exact drag position', () => {
  const host = mountOverlay();
  host.pointer(main, 'onPointerDown', 100, 150);
  host.pointer(main, 'onPointerMove', 449, 150);
  near(host.values().x, 450);
  assert.ok(host.nodes((node) => node.props['data-testid'] === 'studio-snap-guide').length > 0);
  host.pointer(main, 'onPointerMove', 449, 150, {altKey: true});
  near(host.values().x, 449);
  assert.equal(host.nodes((node) => node.props['data-testid'] === 'studio-snap-guide').length, 0);
  host.pointer(main, 'onPointerUp', 449, 150, {altKey: true});
  assert.equal(host.history().past.length, 1);
  host.unmount();
});

test('keyboard movement preserves 1px/Shift10px behavior through the captured parent basis', () => {
  const host = mountOverlay({geometry: [measured({parentBasis: {a: 0, b: 2, c: -3, d: 0}})]});
  const key = (key, shiftKey = false) => {
    host.button(main).props.onKeyDown({key, shiftKey, preventDefault() {}, stopPropagation() {}});
    host.render();
  };
  key('ArrowRight'); key('ArrowDown', true);
  near(host.values().x, 105); near(host.values().y, 150 - 1 / 3);
  assert.equal(host.history().past.length, 0);
  host.dispatch('keyup', {key: 'ArrowRight'});
  assert.equal(host.history().past.length, 0);
  host.dispatch('keyup', {key: 'ArrowDown'});
  assert.equal(host.history().past.length, 1);
  host.undo(); near(host.values().x, 100); near(host.values().y, 150);
  host.unmount();
});

test('resize and rotation handles support keyboard editing with individual undo steps', () => {
  const host = mountOverlay();
  const press = (handle, key, shiftKey = false) => {
    host.button(handle).props.onKeyDown({key, shiftKey, preventDefault() {}, stopPropagation() {}});
    host.render();
  };
  press(southeast, 'ArrowRight');
  near(host.values().width, 101); near(host.values().height, 80);
  assert.equal(host.history().past.length, 1);
  host.render({geometry: [measured({width: 101, transform: {...measured().transform, width: 101}})]});
  press(southeast, 'ArrowDown', true);
  near(host.values().width, 101); near(host.values().height, 90);
  assert.equal(host.history().past.length, 2);
  host.render({geometry: [measured({width: 101, height: 90, transform: {...measured().transform, width: 101, height: 90}})]});
  press(rotation, 'ArrowRight', true);
  near(host.values().rotation, 15);
  assert.equal(host.history().past.length, 3);
  host.undo(); near(host.values().rotation, 0);
  host.undo(); near(host.values().height, 80);
  host.undo(); near(host.values().width, 100);
  host.unmount();
});

const mountPreview = () => {
  const slots = [];
  const effects = [];
  const listeners = new Set();
  const posted = [];
  const measurements = [];
  const errors = [];
  const frameWindow = {postMessage: (packet) => posted.push(packet)};
  let cursor = 0;
  let sequence = 0;
  let tree;
  const memo = (create, deps) => {
    const index = cursor++;
    if (!slots[index] || deps.some((value, offset) => !Object.is(value, slots[index].deps[offset]))) slots[index] = {value: create(), deps};
    return slots[index].value;
  };
  const react = {
    useRef(initial) {const index = cursor++; if (!slots[index]) slots[index] = {current: initial}; return slots[index];},
    useState(initial) {const index = cursor++; if (!slots[index]) slots[index] = {value: initial};
      return [slots[index].value, (next) => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];},
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((value, offset) => !Object.is(value, slots[index].deps[offset]))) {
        effects.push({index, effect, cleanup: slots[index]?.cleanup}); slots[index] = {deps};
      }
    },
  };
  const element = (type, props) => {
    if (type === 'iframe' && props?.ref) props.ref.current = {contentWindow: frameWindow};
    return {type, props: props ?? {}};
  };
  const api = {};
  const compiled = ts.transpileModule(readFileSync(new URL('../src/features/studio/StudioSourcePreview.tsx', import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX},
  }).outputText;
  runInNewContext(compiled, {exports: api, Error, URL, crypto: {randomUUID: () => `sync-${++sequence}`},
    window: {setTimeout: () => 1, clearTimeout() {}, addEventListener(type, receive) {if (type === 'message') listeners.add(receive);},
      removeEventListener(type, receive) {if (type === 'message') listeners.delete(receive);}},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return {jsx: element, jsxs: element};
      if (name === './studioApi') return {STUDIO_SERVICE_URL: 'http://127.0.0.1:4180'};
      if (name === './StudioLayerOverlay') return {default: 'StudioLayerOverlay'};
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const props = {projectId: 'project', revision: 4, previewUrl: 'http://127.0.0.1:4180/previews/test/player.html',
    composition: {width: 1000, height: 800}, edits: {backgroundColor: '#000000', layers: {}}, frame: 0,
    isActive: true, registry: [definition()], selectedLayerId: 'title', editMode: true, editingDisabled: false,
    onFrame() {}, onError: (message) => errors.push(message), onMeasured: (layers) => measurements.push(layers), onSelectLayer() {}, onChangeLayer() {}};
  const render = () => {
    cursor = 0; tree = api.default(props);
    effects.splice(0).forEach(({index, effect, cleanup}) => {cleanup?.(); slots[index].cleanup = effect();});
  };
  const send = (changes = {}, sender = {}) => {
    const packet = {type: 'vyvyd-studio:preview-event', projectId: props.projectId, revision: props.revision,
      event: 'layers', syncToken: posted.at(-1)?.syncToken, frame: 0, composition: props.composition,
      layers: [measured()], ...changes};
    for (const receive of listeners) receive({origin: 'null', source: frameWindow, data: packet, ...sender});
    render();
  };
  const overlay = () => {
    const search = (node) => {
      if (Array.isArray(node)) return node.map(search).find(Boolean);
      if (!node || typeof node !== 'object') return undefined;
      return node.type === 'StudioLayerOverlay' ? node : search(node.props.children);
    };
    return search(tree);
  };
  render();
  return {send, overlay, posted, measurements, errors, unmount() {slots.forEach((slot) => slot?.cleanup?.());}};
};

test('source preview forwards valid transform metadata and rejects stale or foreign measurements', () => {
  const preview = mountPreview();
  preview.send();
  assert.deepEqual(plain(preview.overlay().props.geometry[0].transform), plain(measured().transform));
  assert.equal(preview.overlay().props.geometryReady, true);
  assert.equal(preview.measurements.at(-1)[0].transform.rotatable, true);
  const last = preview.measurements.at(-1);
  for (const stale of [{syncToken: 'stale'}, {frame: 1}, {composition: {width: 999, height: 800}}, {revision: 3}]) {
    preview.send({...stale, layers: [measured({x: 900})]});
    assert.equal(preview.measurements.at(-1), last);
    assert.equal(preview.overlay().props.geometry[0].x, 100);
  }
  preview.send({layers: [measured({x: 900})]}, {origin: 'https://foreign.example'});
  assert.equal(preview.measurements.at(-1), last);
  preview.send({layers: [measured({x: 900})]}, {source: {}});
  assert.equal(preview.measurements.at(-1), last);
  assert.deepEqual(preview.errors, []);
  preview.unmount();
});

test('bad transform metadata is dropped while safe measured movement remains available', () => {
  const preview = mountPreview();
  for (const invalid of [
    {...measured().transform, width: 0},
    {...measured().transform, basis: {...identity, a: NaN}},
    {...measured().transform, originRatio: {x: Infinity, y: 0.5}},
    {...measured().transform, originOffset: {x: 'bad', y: 0}},
  ]) {
    preview.send({layers: [measured({transform: invalid})]});
    const safe = preview.overlay().props.geometry[0];
    assert.equal(safe.transform, undefined);
    assert.equal(safe.movable, true);
    assert.deepEqual(plain(safe.parentBasis), identity);
  }
  preview.unmount();
});
