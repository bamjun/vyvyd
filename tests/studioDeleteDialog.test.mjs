import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInThisContext} from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/features/studio/StudioDeleteDialog.tsx', import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX},
}).outputText;

function mount(hasDraft) {
  let onCancel = 0, confirmed = [], focusListener, effect, cleanup, nextId = 0, checked = true, refIndex = 0, tree, nodes, dialog, buttons;
  const original = {document:globalThis.document, HTMLElement:globalThis.HTMLElement};
  class Element {constructor() {this.isConnected = true;} focus() {document.activeElement = this;} contains(target) {return target === this || this.buttons?.includes(target);}}
  const previous = new Element();
  const document = {activeElement:previous, addEventListener:(_name, handler) => {focusListener = handler;}, removeEventListener:() => {focusListener = null;}};
  Object.assign(globalThis, {document, HTMLElement:Element});
  const refs = [{current:null},{current:null}];
  const react = {useId:() => `test-${++nextId}`, useRef:() => refs[refIndex++], useEffect:(fn) => {effect = fn;}, useState:() => [checked, (value) => {checked=value;}]};
  const element = (type, props) => ({type, props:props ?? {}});
  const exports = {};
  runInThisContext(`(function(require, exports) {${code}\n})`)((name) => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return {jsx:element,jsxs:element,Fragment:'Fragment'};
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports);
  const render = () => {refIndex = 0; nextId = 0; tree = exports.default({project:{id:'test',name:'삭제 대상'},hasDraft,onCancel:() => {onCancel++;},onConfirm:(value) => {confirmed.push(value);}});
    nodes = []; const visit = (node) => {if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; nodes.push(node); visit(node.props?.children);}; visit(tree);
    dialog = nodes.find((node) => node.props.role === 'dialog'); buttons = nodes.filter((node) => node.type === 'button');};
  render();
  const buttonElements = buttons.map(() => new Element()), checkboxElement = new Element(), dialogElement = new Element();
  dialogElement.buttons = [checkboxElement,...buttonElements]; dialogElement.querySelectorAll = () => [checkboxElement,...buttonElements];
  dialog.props.ref.current = dialogElement; buttons[0].props.ref.current = buttonElements[0];
  cleanup = effect();
  return {get tree() {return tree;},get nodes() {return nodes;},get dialog() {return dialog;},get buttons() {return buttons;},buttonElements,checkboxElement,document,previous,render,get onCancel() {return onCancel;},get confirmed() {return confirmed;},
    focusOutside() {const outsider = new Element(); outsider.focus(); focusListener({target:outsider});},
    close() {cleanup(); for (const [key,value] of Object.entries(original)) {if (value === undefined) delete globalThis[key]; else globalThis[key]=value;}}};
}

test('the in-app dialog identifies the project, warns about drafts and only confirms on explicit action', () => {
  const host = mount(true); try {
    assert.equal(host.dialog.props['aria-modal'],'true');
    assert.ok(host.nodes.some((node) => node.props.children === '삭제 대상'));
    assert.ok(host.nodes.some((node) => node.props.children === '이 탭에 보관된 미저장 초안도 삭제됩니다.'));
    assert.ok(host.nodes.some((node) => node.props.children === '이 프로젝트의 출력 파일과 미리보기 캐시도 삭제'));
    assert.ok(host.nodes.some((node) => node.props.children === '컴퓨터에 별도로 다운로드한 파일은 삭제되지 않습니다.'));
    assert.equal(host.document.activeElement,host.buttonElements[0]);
    const checkbox = host.nodes.find((node) => node.type === 'input');
    assert.equal(checkbox.props.checked,true);
    host.buttons[0].props.onClick(); assert.equal(host.onCancel,1); assert.deepEqual(host.confirmed,[]);
    host.buttons[1].props.onClick(); assert.deepEqual(host.confirmed,[true]);
    checkbox.props.onChange({target:{checked:false}}); host.render();
    assert.equal(host.nodes.find((node) => node.type === 'input').props.checked,false);
    assert.ok(host.nodes.some((node) => typeof node.props.children === 'string' && node.props.children.includes('디스크에 남지만')));
    host.buttons[1].props.onClick(); assert.deepEqual(host.confirmed,[true,false]);
  } finally {host.close();}
  assert.equal(host.document.activeElement,host.previous);
});

test('Escape cancels and keyboard focus remains inside the dialog', () => {
  const host = mount(false); try {
    assert.ok(!host.nodes.some((node) => node.props.children === '이 탭에 보관된 미저장 초안도 삭제됩니다.'));
    let prevented = false, stopped = false;
    host.checkboxElement.focus(); host.dialog.props.onKeyDown({key:'Tab',shiftKey:true,preventDefault:() => {prevented=true;}});
    assert.equal(prevented,true); assert.equal(host.document.activeElement,host.buttonElements[1]);
    prevented = false; host.dialog.props.onKeyDown({key:'Tab',shiftKey:false,preventDefault:() => {prevented=true;}});
    assert.equal(prevented,true); assert.equal(host.document.activeElement,host.checkboxElement);
    host.focusOutside(); assert.equal(host.document.activeElement,host.buttonElements[0]);
    host.dialog.props.onKeyDown({key:'Escape',preventDefault:() => {prevented=true;},stopPropagation:() => {stopped=true;}});
    assert.equal(host.onCancel,1); assert.deepEqual(host.confirmed,[]); assert.equal(stopped,true);
  } finally {host.close();}
});
