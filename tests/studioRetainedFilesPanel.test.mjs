import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/features/studio/StudioRetainedFilesPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX},
}).outputText;
const item = {kind: 'export', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  projectName: '보관 포스터', revision: 3, createdAt: null, sizeBytes: 4096, state: 'completed', format: 'png', filename: 'poster.png',
  previewUrl: '/retained-artifacts/export/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file?projectId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  downloadUrl: '/retained-artifacts/export/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file?projectId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};

function mount(items, {deleteRequest = async () => ({deleted: true})} = {}) {
  const slots = [], effects = []; let cursor = 0, tree; const calls = [];
  const memo = (create, deps) => {const index = cursor++, old = slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = {value: create(), deps}; return slots[index].value;};
  const react = {
    useState(initial) {const index = cursor++; if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, (next) => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];},
    useRef(value) {const index = cursor++; return (slots[index] ??= {current: value});},
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(effect, deps) {const index = cursor++, old = slots[index];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) {effects.push({index, effect, cleanup: old?.cleanup}); slots[index] = {deps};}},
    useId() {return `id-${cursor++}`;},
  };
  const element = (type, props) => ({type, props: props ?? {}}), api = {};
  runInNewContext(source, {exports: api, URL, Error, Set, console, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return {jsx: element, jsxs: element, Fragment: 'Fragment'};
    if (name === 'lucide-react') return {Download: 'Download', RefreshCw: 'RefreshCw', Trash2: 'Trash2'};
    if (name === './studioApi') return {STUDIO_SERVICE_URL: 'http://127.0.0.1:4180', studioFileUrl: (value) => `http://127.0.0.1:4180${value}${value.includes('?') ? '&' : '?'}storageId=scope`,
      studioApi: {retainedArtifacts: async () => ({items}), deleteRetainedArtifact: async (entry) => {calls.push(entry); return deleteRequest(entry);}}};
    throw new Error(`Unexpected dependency: ${name}`);
  }});
  const onBusyChange = () => {};
  const render = () => {cursor = 0; tree = api.default({connected: true, isActive: true, onBusyChange});
    effects.splice(0).forEach(({index, effect, cleanup}) => {cleanup?.(); slots[index].cleanup = effect();}); return tree;};
  const nodes = (predicate) => {const found = []; const visit = (node) => {if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return; if (predicate(node)) found.push(node); visit(node.props?.children);}; visit(tree); return found;};
  render(); return {render, nodes, calls};
}

test('retained output can be inspected and downloaded; selecting it only opens an explicit confirmation', async () => {
  const host = mount([item]);
  host.nodes((n) => n.type === 'button' && n.props['aria-expanded'] === false)[0].props.onClick();
  await new Promise((resolve) => setImmediate(resolve)); host.render();
  host.nodes((n) => n.type === 'button' && n.props.children === '확인')[0].props.onClick(); host.render();
  const img = host.nodes((n) => n.type === 'img')[0];
  assert.equal(img.props.src, `http://127.0.0.1:4180${item.previewUrl}&storageId=scope`);
  assert.equal(host.nodes((n) => n.type === 'a')[0].props.href, img.props.src);
  const checkbox = host.nodes((n) => n.type === 'input' && n.props['aria-label']?.includes('보관 포스터'))[0];
  checkbox.props.onChange({target: {checked: true}}); host.render();
  const deleteButton = host.nodes((n) => n.type === 'button' && Array.isArray(n.props.children) && n.props.children.includes('선택한 항목 삭제'))[0];
  deleteButton.props.onClick(); host.render();
  assert.equal(host.calls.length, 0);
  assert.equal(host.nodes((n) => typeof n.type === 'function' && n.type.name === 'ConfirmDeletion').length, 1);
});

test('an output URL pointing to another project is not offered for viewing', async () => {
  const host = mount([{...item, previewUrl: item.previewUrl.replace(item.projectId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')}]);
  host.nodes((n) => n.type === 'button' && n.props['aria-expanded'] === false)[0].props.onClick();
  await new Promise((resolve) => setImmediate(resolve)); host.render();
  assert.equal(host.nodes((n) => n.type === 'button' && n.props.children === '확인')[0].props.disabled, true);
});

test('retained files group by project ID, resolve names and delete only the confirmed group', async () => {
  const secondId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const thirdId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const older = {...item, projectName: '이전 이름', revision: 1};
  const latest = {...item, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', projectName: '같은 이름', revision: 5};
  const preview = {...item, kind: 'preview', id: '11111111-1111-4111-8111-111111111111', projectName: null, previewUrl: undefined, downloadUrl: undefined};
  const other = {...item, id: '22222222-2222-4222-8222-222222222222', projectId: secondId, projectName: '같은 이름'};
  const previewOnly = {...preview, id: '33333333-3333-4333-8333-333333333333', projectId: thirdId};
  const host = mount([older, preview, latest, other, previewOnly]);
  host.nodes((n) => n.type === 'button' && n.props['aria-expanded'] === false)[0].props.onClick();
  await new Promise((resolve) => setImmediate(resolve)); host.render();
  const groups = () => host.nodes((n) => n.props['data-testid'] === 'studio-retained-project-group');
  assert.deepEqual(groups().map((node) => node.props['data-project-id']), [item.projectId, secondId, thirdId]);
  assert.match(groups()[0].props['aria-label'], /^같은 이름/);
  assert.match(groups()[1].props['aria-label'], /^같은 이름/);
  assert.match(groups()[2].props['aria-label'], /^프로젝트 dddddddd/);

  const firstPreview = () => host.nodes((n) => n.type === 'input' && n.props['aria-label']?.includes(item.projectId) && n.props['aria-label'].includes('미리보기 캐시'))[0];
  const firstGroupSelect = () => host.nodes((n) => n.type === 'input' && n.props['aria-label']?.startsWith('프로젝트 파일 전체 선택:') && n.props['aria-label'].includes(item.projectId))[0];
  firstPreview().props.onChange({target: {checked: true}}); host.render();
  assert.equal(firstGroupSelect().props['aria-checked'], 'mixed');
  firstGroupSelect().props.onChange({target: {checked: true}}); host.render();
  assert.equal(firstGroupSelect().props.checked, true);
  firstGroupSelect().props.onChange({target: {checked: false}}); host.render();
  assert.equal(firstPreview().props.checked, false);

  // Selection in another same-named project must not enter this group's delete.
  host.nodes((n) => n.type === 'input' && n.props['aria-label']?.includes(secondId) && n.props['aria-label'].includes('PNG 파일'))[0].props.onChange({target: {checked: true}});
  host.render();
  const groupDelete = () => host.nodes((n) => n.type === 'button' && n.props['aria-label']?.includes(`(${item.projectId})`) && n.props['aria-label'].startsWith('프로젝트 보관 파일 모두 삭제'))[0];
  groupDelete().props.onClick(); host.render();
  let confirmation = host.nodes((n) => typeof n.type === 'function' && n.type.name === 'ConfirmDeletion')[0];
  assert.equal(host.calls.length, 0);
  assert.equal(confirmation.props.project.id, item.projectId);
  assert.deepEqual(Array.from(confirmation.props.items, (entry) => entry.id), [older.id, preview.id, latest.id]);
  confirmation.props.onCancel(); host.render();
  assert.equal(host.calls.length, 0);
  assert.equal(host.nodes((n) => n.type === 'input' && n.props['aria-label']?.includes(secondId) && n.props['aria-label'].includes('PNG 파일'))[0].props.checked, true);

  groupDelete().props.onClick(); host.render();
  confirmation = host.nodes((n) => typeof n.type === 'function' && n.type.name === 'ConfirmDeletion')[0];
  confirmation.props.onConfirm();
  await new Promise((resolve) => setImmediate(resolve)); host.render();
  assert.deepEqual(host.calls.map((entry) => entry.projectId), [item.projectId, item.projectId, item.projectId]);
  assert.deepEqual(groups().map((node) => node.props['data-project-id']), [secondId, thirdId]);
  assert.equal(host.nodes((n) => n.type === 'input' && n.props['aria-label']?.includes(secondId) && n.props['aria-label'].includes('PNG 파일'))[0].props.checked, true);
});

test('partial failure leaves the remaining group items available', async () => {
  const next = {...item, kind: 'preview', id: '11111111-1111-4111-8111-111111111111', projectName: null, previewUrl: undefined};
  const host = mount([item, next], {deleteRequest: async (entry) => {if (entry.id === next.id) throw new Error('파일 사용 중'); return {deleted: true};}});
  host.nodes((n) => n.type === 'button' && n.props['aria-expanded'] === false)[0].props.onClick();
  await new Promise((resolve) => setImmediate(resolve)); host.render();
  host.nodes((n) => n.type === 'button' && n.props['aria-label']?.startsWith('프로젝트 보관 파일 모두 삭제'))[0].props.onClick(); host.render();
  host.nodes((n) => typeof n.type === 'function' && n.type.name === 'ConfirmDeletion')[0].props.onConfirm();
  await new Promise((resolve) => setImmediate(resolve)); host.render();
  assert.deepEqual(host.calls.map((entry) => entry.id), [item.id, next.id]);
  assert.match(host.nodes((n) => n.props.role === 'alert')[0].props.children, /1개 삭제 후 작업을 멈췄습니다/);
  assert.equal(host.nodes((n) => n.type === 'input' && n.props['aria-label']?.includes('미리보기 캐시'))[0].props.checked, false);
  assert.equal(host.nodes((n) => n.type === 'input' && n.props['aria-label']?.includes('PNG 파일')).length, 0);
});
