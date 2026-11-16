import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as editor from '../packages/studio-runtime/src/layer-editor.mjs';

const source = ts.transpileModule(readFileSync(new URL('../src/features/studio/StudioHistoryPreview.tsx', import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX},
}).outputText;
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
class StudioApiError extends Error {
  constructor(message, code, status) {super(message); this.code = code; this.status = status;}
}
const version = (revision = 2) => ({id: 'project-1', revision, composition: {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48}, assets: [],
  source: {files: {'src/layers.json': JSON.stringify([
    {id: 'title', type: 'text', label: '제목', editable: ['text'], defaults: {text: '기본 제목'}},
    {id: 'subtitle', type: 'text', label: '부제', editable: ['text', 'hidden'], defaults: {text: '기본 부제'}},
  ])}}, edits: {backgroundColor: '#ffffff', layers: {title: {text: '저장된 제목'}, subtitle: {hidden: true}}}});

// Run the real component and its effects with a minimal host; network and the
// isolated player are substituted so selection and cleanup are deterministic.
function mount(document, request) {
  const slots = [], effects = []; let cursor = 0, tree;
  const memo = (create, deps) => {const index = cursor++, old = slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = {value: create(), deps};
    return slots[index].value;};
  const react = {
    useState(initial) {const index = cursor++; if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, (next) => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];},
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(effect, deps) {const index = cursor++, old = slots[index];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) {effects.push({index, effect, cleanup: old?.cleanup}); slots[index] = {deps};}},
  };
  const element = (type, props) => ({type, props: props ?? {}});
  const player = () => null;
  const api = {};
  runInNewContext(source, {exports: api, Error, console, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return {jsx: element, jsxs: element, Fragment: 'Fragment'};
    if (name.endsWith('/layer-editor.mjs')) return editor;
    if (name === './studioApi') return {studioApi: {historyPreview: request}, StudioApiError};
    if (name === './StudioSourcePreview') return {default: player};
    throw new Error(`Unexpected dependency: ${name}`);
  }});
  const render = (next = document) => {document = next; cursor = 0; tree = api.default({version: document});
    effects.splice(0).forEach(({index, effect, cleanup}) => {cleanup?.(); slots[index].cleanup = effect();}); return tree;};
  const nodes = (predicate) => {const found = []; const visit = (node) => {if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return; if (predicate(node)) found.push(node); visit(node.props?.children);}; visit(tree); return found;};
  render();
  return {render, nodes, player, unmount: () => slots.forEach((slot) => slot?.cleanup?.())};
}

test('historical preview displays saved and default text without changing the selected snapshot', async () => {
  const snapshot = version(), before = structuredClone(snapshot), pending = deferred(), requests = [];
  const host = mount(snapshot, (id, revision) => {requests.push({id, revision}); return pending.promise;});
  assert.deepEqual(requests, [{id: snapshot.id, revision: 2}]);
  assert.equal(host.nodes((n) => n.props.role === 'status').length, 1);
  const displayed = host.nodes((n) => n.type === 'dd').map((n) => n.props.children);
  assert.deepEqual(displayed, ['저장된 제목', '기본 부제']);
  assert.equal(host.nodes((n) => n.type === 'dt')[1].props.children[1], ' · 숨김');
  pending.resolve({projectId: snapshot.id, revision: 2, previewUrl: '/previews/old/player.html'});
  await pending.promise; await Promise.resolve(); host.render();
  const player = host.nodes((n) => n.type === host.player)[0];
  assert.ok(player); assert.equal(player.props.revision, 2); assert.equal(player.props.previewUrl, '/previews/old/player.html');
  assert.equal(player.props.editingDisabled, true); assert.equal(player.props.edits, snapshot.edits);
  assert.deepEqual(snapshot, before);
  host.unmount();
});

test('a late historical preview response cannot replace a newer selection', async () => {
  const old = deferred(), recent = deferred(), first = version(2), second = version(3);
  const host = mount(first, (_id, revision) => revision === 2 ? old.promise : recent.promise);
  host.render(second);
  recent.resolve({projectId: second.id, revision: 3, previewUrl: '/previews/new/player.html'});
  await recent.promise; await Promise.resolve(); host.render();
  old.resolve({projectId: first.id, revision: 2, previewUrl: '/previews/old/player.html'});
  await old.promise; await Promise.resolve(); host.render();
  const player = host.nodes((n) => n.type === host.player)[0];
  assert.equal(player.props.revision, 3); assert.equal(player.props.previewUrl, '/previews/new/player.html');
  host.unmount();
});

test('an unsupported preview endpoint prompts a service update, while a missing history remains a distinct error', async () => {
  for (const [code, message, expected] of [
    ['NOT_FOUND', '요청한 작업을 찾을 수 없습니다.', '로컬 Studio 서비스를 업데이트하고 다시 시작'],
    ['HISTORY_NOT_FOUND', '해당 수정 버전의 저장본을 찾을 수 없습니다.', '해당 수정 버전의 저장본을 찾을 수 없습니다.'],
  ]) {
    const pending = deferred();
    const host = mount(version(), () => pending.promise);
    pending.reject(new StudioApiError(message, code, 404));
    await pending.promise.catch(() => {}); await Promise.resolve(); host.render();
    const alert = host.nodes((node) => node.props.role === 'alert')[0];
    assert.ok(alert.props.children.join('').includes(expected));
    host.unmount();
  }
});
