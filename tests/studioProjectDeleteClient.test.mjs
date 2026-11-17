import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInThisContext} from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';
import * as editHistory from '../packages/studio-runtime/src/edit-history.mjs';
import * as projectDraft from '../packages/studio-runtime/src/project-draft.mjs';
import * as layerEditor from '../packages/studio-runtime/src/layer-editor.mjs';
import * as layerTransform from '../packages/studio-runtime/src/layer-transform.mjs';
import * as confirmation from '../packages/studio-runtime/src/write-confirmation.mjs';
import * as projectModel from '../packages/studio-runtime/src/project-model.mjs';
import * as workspaceKeys from '../src/features/studio/studioWorkspaceKeys.mjs';

const transpile = (name) => ts.transpileModule(readFileSync(new URL(`../src/features/studio/${name}`, import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
}).outputText;
const hookCode = transpile('useStudioEditor.ts');
const settingsCode = transpile('studioEditorSettings.ts');
const load = (code, require) => {const result = {}; runInThisContext(`(function(require, exports) {${code}\n})`)(require, result); return result;};
const settings = load(settingsCode, () => projectModel);
class ApiError extends Error {constructor(message, code, status) {super(message); this.code = code; this.status = status;}}
const storage = () => {const values = new Map(); return {getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key)};};
const makeProject = (name, id) => projectModel.createProjectDocument({name, composition: {width: 320, height: 400, fps: 24, durationInFrames: 48}}, {id});
const summary = (p) => ({id:p.id,name:p.name,revision:p.revision,updatedAt:p.updatedAt,composition:p.composition,assetCount:p.assets.length});

// Execute the actual editor hook with a minimal React host and an in-memory service.
function mount(initial) {
  const slots = [], pendingEffects = []; let cursor = 0, output, deletion;
  const docs = new Map(initial.map((p) => [p.id, p]));
  const localStorage = storage(), sessionStorage = storage(), timers = new Map(); let timerId = 0;
  const React = {
    useState(initialValue) {const index = cursor++; if (!slots[index]) slots[index] = {value:typeof initialValue === 'function' ? initialValue() : initialValue};
      return [slots[index].value, (next) => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];},
    useRef(initialValue) {const index = cursor++; return slots[index] ??= {current:initialValue};},
    useMemo(create, deps) {const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => !Object.is(v, old.deps[i]))) slots[index] = {value:create(), deps}; return slots[index].value;},
    useCallback(create, deps) {return React.useMemo(() => create, deps);},
    useEffect(effect, deps) {const index = cursor++, old = slots[index]; if (!old || !deps || deps.some((v, i) => !Object.is(v, old.deps[i]))) {pendingEffects.push({index,effect,cleanup:old?.cleanup}); slots[index] = {deps};}},
  };
  const api = {
    health:async () => ({service:'vyvyd-studio',status:'ok',protocolVersion:2}), list:async () => [...docs.values()].map(summary),
    open:async (id) => {if (!docs.has(id)) throw new ApiError('missing','PROJECT_NOT_FOUND',404); return docs.get(id);},
    status:async (id) => ({revision:docs.get(id).revision,compile:{state:'ready'},mcp:{}}),
    history:async (id) => ({projectId:id,currentRevision:docs.get(id).revision,versions:[]}),
    deleteProject:async (id, revision) => {if (deletion) return deletion(id, revision, docs); docs.delete(id); return {projectId:id,deleted:true};},
  };
  const fakeWindow = {setTimeout:(fn) => {const id = ++timerId; timers.set(id,fn); return id;}, clearTimeout:(id) => timers.delete(id),
    setInterval:() => 1, clearInterval:() => {}, addEventListener:() => {}, removeEventListener:() => {}};
  const fakeDocument = {visibilityState:'visible',addEventListener:() => {},removeEventListener:() => {}};
  const original = {window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage};
  Object.assign(globalThis, {window:fakeWindow,document:fakeDocument,localStorage,sessionStorage});
  const hook = load(hookCode, (name) => {
    if (name === 'react') return React;
    if (name.endsWith('/edit-history.mjs')) return editHistory;
    if (name.endsWith('/project-draft.mjs')) return projectDraft;
    if (name.endsWith('/layer-editor.mjs')) return layerEditor;
    if (name.endsWith('/layer-transform.mjs')) return layerTransform;
    if (name.endsWith('/write-confirmation.mjs')) return confirmation;
    if (name === './studioEditorSettings') return settings;
    if (name === './studioApi') return {studioApi:api,StudioApiError:ApiError};
    if (name === './studioBundleApi') return {studioBundleApi:{}};
    if (name === './studioWorkspaceKeys.mjs') return workspaceKeys;
    throw new Error(`Unexpected dependency: ${name}`);
  });
  const render = () => {cursor = 0; output = hook.useStudioEditor(true, 'test-workspace');
    for (const {index,effect,cleanup} of pendingEffects.splice(0)) {cleanup?.(); slots[index].cleanup = effect();} return output;};
  const settle = async () => {for (let i=0;i<8;i++) {await Promise.resolve(); render();}};
  render();
  return {render,settle,api,docs,localStorage,sessionStorage, get value() {return output;},
    setDelete(handler) {deletion=handler;},
    close() {slots.forEach((slot) => slot?.cleanup?.()); for (const [key,value] of Object.entries(original)) {if (value === undefined) delete globalThis[key]; else globalThis[key]=value;}}};
}

const first = makeProject('첫 포스터','d5376239-b6e0-461f-944d-33747b8d5d38');
const second = makeProject('두 번째','59517e04-3cba-4371-ba8b-9497623a3cd3');

test('deleting another project preserves the current draft; deleting the current project clears only its selection', async () => {
  const host=mount([first,second]); try {
    await host.settle(); await host.value.openProject(first.id); host.render();
    host.value.setFields({...host.value.fields,name:'유지할 초안'}); host.render();
    assert.equal(host.value.hasDeletionDraft(first.id),true); assert.equal(host.value.hasDeletionDraft(second.id),false);
    await host.value.deleteProject(summary(second)); host.render();
    assert.equal(host.value.project.id,first.id); assert.equal(host.value.fields.name,'유지할 초안'); assert.equal(host.value.dirty,true);
    assert.deepEqual(host.value.projects.map((item) => item.id),[first.id]);
    await host.value.deleteProject(summary(first)); host.render();
    assert.equal(host.value.project,null); assert.equal(host.value.projects.length,0);
    assert.equal(host.localStorage.getItem(workspaceKeys.studioWorkspaceKeys('test-workspace').selectedKey),null);
  } finally {host.close();}
});

test('conflict preserves the draft, and a lost response is reconciled only after the project is absent', async () => {
  const host=mount([first,second]); try {
    await host.settle(); await host.value.openProject(first.id); host.render();
    host.value.setFields({...host.value.fields,name:'보존할 초안'}); host.render();
    host.setDelete(async () => {throw new ApiError('changed','REVISION_CONFLICT',409);});
    await host.value.deleteProject(summary(first)); host.render();
    assert.equal(host.value.project.id,first.id); assert.equal(host.value.fields.name,'보존할 초안'); assert.equal(host.value.dirty,true);
    host.setDelete(async (id, _revision, docs) => {docs.delete(id); throw new ApiError('lost','CONNECTION_FAILED',0);});
    await host.value.deleteProject(summary(first)); host.render();
    assert.equal(host.value.project.id,first.id); assert.equal(host.value.fields.name,'보존할 초안');
    await host.value.connect(); host.render();
    assert.equal(host.value.project,null); assert.deepEqual(host.value.projects.map((item) => item.id),[second.id]);
    assert.match(host.value.error,/파일 정리 완료 여부/);
  } finally {host.close();}
});

test('an unrelated not-found error preserves the draft and a pending response is kept while the project still exists', async () => {
  const host=mount([first,second]); try {
    await host.settle(); await host.value.openProject(first.id); host.render();
    host.value.setFields({...host.value.fields,name:'그대로 둘 초안'}); host.render();
    host.setDelete(async () => {throw new ApiError('missing','PROJECT_NOT_FOUND',404);});
    await host.value.deleteProject(summary(first)); host.render();
    assert.equal(host.value.project.id,first.id); assert.equal(host.value.fields.name,'그대로 둘 초안');
    host.setDelete(async () => {throw new ApiError('lost','CONNECTION_FAILED',0);});
    await host.value.deleteProject(summary(first)); host.render(); await host.value.connect(); host.render();
    assert.equal(host.value.project.id,first.id); assert.equal(host.value.fields.name,'그대로 둘 초안'); assert.equal(host.value.dirty,true);
    await host.value.deleteProject(summary(second)); host.render();
    assert.match(host.value.error,/삭제 결과를 먼저 확인/); assert.ok(host.docs.has(second.id));
  } finally {host.close();}
});

test('partial disk cleanup is reported even after the project leaves the list', async () => {
  const host=mount([first]); try {
    await host.settle(); await host.value.openProject(first.id); host.render();
    host.setDelete(async (id, _revision, docs) => {docs.delete(id); return {projectId:id,deleted:true,cleanupPending:true};});
    await host.value.deleteProject(summary(first)); host.render();
    assert.equal(host.value.project,null); assert.match(host.value.error,/일부 파일을 정리하지 못했습니다/);
  } finally {host.close();}
});

test('confirmed deletion is recorded before the response so it can be reconciled after a reload', async () => {
  const host=mount([first]); try {
    await host.settle(); await host.value.openProject(first.id); host.render();
    let release; const waiting=new Promise((resolve) => {release=resolve;});
    host.setDelete(async (id, _revision, docs) => {await waiting; docs.delete(id); return {projectId:id,deleted:true};});
    const pending=host.value.deleteProject(summary(first));
    const key=`${workspaceKeys.studioWorkspaceKeys('test-workspace').selectedKey}.pendingDelete`;
    assert.equal(JSON.parse(host.sessionStorage.getItem(key)).id,first.id);
    release(); await pending; host.render();
    assert.equal(host.sessionStorage.getItem(key),null); assert.equal(host.value.project,null);
  } finally {host.close();}
});
