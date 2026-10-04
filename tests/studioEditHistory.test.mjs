import assert from 'node:assert/strict';
import test from 'node:test';
import {beginEditHistory, cancelEditHistory, createEditHistory, endEditHistory, recordEditHistory, redoEditHistory, undoEditHistory} from '../packages/studio-runtime/src/edit-history.mjs';

const snapshot = (x = 0, name = '홍보물') => ({fields: {name, width: '960', backgroundColor: '#ffffff'}, layers: {title: {x, text: '문구', locked: false}}});

test('a complete draft is restored across undo and redo, with detached caller data', () => {
  const initial = snapshot();
  let history = createEditHistory(initial);
  initial.layers.title.text = 'outside mutation';
  const changed = snapshot(50, '이름 변경');
  history = recordEditHistory(history, changed);
  changed.layers.title.x = 999;
  history = undoEditHistory(history);
  assert.deepEqual(history.present, snapshot());
  history = redoEditHistory(history);
  assert.deepEqual(history.present, snapshot(50, '이름 변경'));
});

test('many moves, including a repeated begin, make a single drag undo step', () => {
  let history = beginEditHistory(createEditHistory(snapshot()));
  for (let x = 1; x <= 25; x++) history = recordEditHistory(beginEditHistory(history), snapshot(x));
  assert.equal(history.past.length, 0);
  history = endEditHistory(history);
  assert.equal(history.past.length, 1);
  assert.deepEqual(undoEditHistory(history).present, snapshot());
  assert.deepEqual(redoEditHistory(undoEditHistory(history)).present, snapshot(25));
});

test('cancelled and round-trip gestures preserve the existing redo branch', () => {
  let history = undoEditHistory(recordEditHistory(createEditHistory(snapshot()), snapshot(10)));
  const redo = history.future;
  history = recordEditHistory(beginEditHistory(history), snapshot(20));
  history = cancelEditHistory(history);
  assert.deepEqual(history.present, snapshot());
  assert.equal(history.past.length, 0);
  assert.equal(history.future, redo);
  history = recordEditHistory(beginEditHistory(history), snapshot(20));
  history = endEditHistory(recordEditHistory(history, snapshot()));
  assert.equal(history.past.length, 0);
  assert.deepEqual(redoEditHistory(history).present, snapshot(10));
});

test('undo during a pending gesture only cancels it before committed undo', () => {
  let history = recordEditHistory(createEditHistory(snapshot()), snapshot(10));
  history = recordEditHistory(beginEditHistory(history), snapshot(20));
  history = undoEditHistory(history);
  assert.deepEqual(history.present, snapshot(10));
  assert.equal(history.past.length, 1);
  assert.equal(history.future.length, 0);
  assert.deepEqual(undoEditHistory(history).present, snapshot());
});

test('redo cancels a pending gesture before replaying an existing committed edit', () => {
  let history = undoEditHistory(recordEditHistory(createEditHistory(snapshot()), snapshot(10)));
  history = recordEditHistory(beginEditHistory(history), snapshot(20));
  history = redoEditHistory(history);
  assert.deepEqual(history.present, snapshot());
  assert.equal(history.future.length, 1);
  assert.deepEqual(redoEditHistory(history).present, snapshot(10));
});

test('a real new edit discards redo while structural no-ops do not', () => {
  let history = undoEditHistory(recordEditHistory(createEditHistory(snapshot()), snapshot(10)));
  const reordered = {layers: {title: {text: '문구', locked: false, x: 0}}, fields: {backgroundColor: '#ffffff', width: '960', name: '홍보물'}};
  assert.equal(recordEditHistory(history, reordered), history);
  history = endEditHistory(recordEditHistory(beginEditHistory(history), snapshot(30)));
  assert.equal(history.future.length, 0);
  assert.equal(redoEditHistory(history), history);
  assert.deepEqual(undoEditHistory(history).present, snapshot());
});

test('only the most recent 100 undo steps are kept', () => {
  let history = createEditHistory(snapshot());
  for (let x = 1; x <= 130; x++) history = recordEditHistory(history, snapshot(x));
  assert.equal(history.past.length, 100);
  for (let index = 0; index < 100; index++) history = undoEditHistory(history);
  assert.deepEqual(history.present, snapshot(30));
  assert.equal(undoEditHistory(history), history);
  for (let index = 0; index < 100; index++) history = redoEditHistory(history);
  assert.deepEqual(history.present, snapshot(130));
  assert.equal(redoEditHistory(history), history);
});

test('history accepts structured-cloneable values and distinguishes meaningful binary and date edits', () => {
  const data = {fields: {date: new Date('2026-10-04'), bytes: new Uint8Array([1, 2]), selected: new Set(['a'])}, layers: new Map([['a', {x: 0}]])};
  let history = createEditHistory(data);
  assert.equal(recordEditHistory(history, structuredClone(data)), history);
  const changed = structuredClone(data);
  changed.fields.bytes[1] = 3;
  history = recordEditHistory(history, changed);
  assert.equal(history.past.length, 1);
  changed.fields.date.setUTCDate(5);
  history = recordEditHistory(history, changed);
  assert.equal(history.past.length, 2);
});

test('reset via create drops old history and validates bounded capacity', () => {
  const history = createEditHistory(recordEditHistory(createEditHistory(snapshot()), snapshot(1)).present);
  assert.equal(history.past.length, 0);
  assert.equal(history.future.length, 0);
  assert.equal(history.transaction, null);
  for (const limit of [0, -1, 101, 1.5, NaN]) assert.throws(() => createEditHistory(snapshot(), {limit}), RangeError);
});
