import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInThisContext} from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/features/studio/StudioDeleteDialog.tsx', import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX},
}).outputText;

function mount(hasDraft) {
  let onCancel = 0, onConfirm = 0, focusListener, effect, cleanup, nextId = 0;
  const original = {document:globalThis.document, HTMLElement:globalThis.HTMLElement};
  class Element {constructor() {this.isConnected = true;} focus() {document.activeElement = this;} contains(target) {return target === this || this.buttons?.includes(target);}}
  const previous = new Element();
  const document = {activeElement:previous, addEventListener:(_name, handler) => {focusListener = handler;}, removeEventListener:() => {focusListener = null;}};
  Object.assign(globalThis, {document, HTMLElement:Element});
  const react = {useId:() => `test-${++nextId}`, useRef:() => ({current:null}), useEffect:(fn) => {effect = fn;}};
  const element = (type, props) => ({type, props:props ?? {}});
  const exports = {};
  runInThisContext(`(function(require, exports) {${code}\n})`)((name) => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return {jsx:element,jsxs:element,Fragment:'Fragment'};
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports);
  const tree = exports.default({project:{id:'test',name:'삭제 대상'},hasDraft,onCancel:() => {onCancel++;},onConfirm:() => {onConfirm++;}});
  const nodes = []; const visit = (node) => {if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; nodes.push(node); visit(node.props?.children);}; visit(tree);
  const dialog = nodes.find((node) => node.props.role === 'dialog');
  const buttons = nodes.filter((node) => node.type === 'button');
  const buttonElements = buttons.map(() => new Element()), dialogElement = new Element();
  dialogElement.buttons = buttonElements; dialogElement.querySelectorAll = () => buttonElements;
  dialog.props.ref.current = dialogElement; buttons[0].props.ref.current = buttonElements[0];
  cleanup = effect();
  return {tree,nodes,dialog,buttons,buttonElements,document,previous,get onCancel() {return onCancel;},get onConfirm() {return onConfirm;},
    focusOutside() {const outsider = new Element(); outsider.focus(); focusListener({target:outsider});},
    close() {cleanup(); for (const [key,value] of Object.entries(original)) {if (value === undefined) delete globalThis[key]; else globalThis[key]=value;}}};
}

test('the in-app dialog identifies the project, warns about drafts and only confirms on explicit action', () => {
  const host = mount(true); try {
    assert.equal(host.dialog.props['aria-modal'],'true');
    assert.ok(host.nodes.some((node) => node.props.children === '삭제 대상'));
    assert.ok(host.nodes.some((node) => node.props.children === '이 탭에 보관된 미저장 초안도 삭제됩니다.'));
    assert.equal(host.document.activeElement,host.buttonElements[0]);
    host.buttons[0].props.onClick(); assert.equal(host.onCancel,1); assert.equal(host.onConfirm,0);
    host.buttons[1].props.onClick(); assert.equal(host.onConfirm,1);
  } finally {host.close();}
  assert.equal(host.document.activeElement,host.previous);
});

test('Escape cancels and keyboard focus remains inside the dialog', () => {
  const host = mount(false); try {
    assert.ok(!host.nodes.some((node) => node.props.children === '이 탭에 보관된 미저장 초안도 삭제됩니다.'));
    let prevented = false, stopped = false;
    host.dialog.props.onKeyDown({key:'Tab',shiftKey:true,preventDefault:() => {prevented=true;}});
    assert.equal(prevented,true); assert.equal(host.document.activeElement,host.buttonElements[1]);
    prevented = false; host.dialog.props.onKeyDown({key:'Tab',shiftKey:false,preventDefault:() => {prevented=true;}});
    assert.equal(prevented,true); assert.equal(host.document.activeElement,host.buttonElements[0]);
    host.focusOutside(); assert.equal(host.document.activeElement,host.buttonElements[0]);
    host.dialog.props.onKeyDown({key:'Escape',preventDefault:() => {prevented=true;},stopPropagation:() => {stopped=true;}});
    assert.equal(host.onCancel,1); assert.equal(host.onConfirm,0); assert.equal(stopped,true);
  } finally {host.close();}
});
