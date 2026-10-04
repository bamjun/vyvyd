const MAX_HISTORY = 100;

// Object keys are not an edit: layer patches may recreate a record in a new order.
function equalSnapshot(left, right, seen = new WeakMap()) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Object.prototype.toString.call(left) !== Object.prototype.toString.call(right)) return false;
  if (seen.has(left)) return seen.get(left) === right;
  seen.set(left, right);
  if (left instanceof Date) return Object.is(left.getTime(), right.getTime());
  if (left instanceof RegExp) return left.source === right.source && left.flags === right.flags;
  if (left instanceof ArrayBuffer || ArrayBuffer.isView(left)) {
    const a = new Uint8Array(left.buffer ?? left, left.byteOffset ?? 0, left.byteLength);
    const b = new Uint8Array(right.buffer ?? right, right.byteOffset ?? 0, right.byteLength);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  if (left instanceof Map || left instanceof Set) {
    if (left.size !== right.size) return false;
    const a = [...left.entries()]; const b = [...right.entries()];
    return a.every((value, index) => equalSnapshot(value, b[index], seen));
  }
  if (left instanceof Error && (left.name !== right.name || left.message !== right.message || !equalSnapshot(left.cause, right.cause, seen))) return false;
  if (Array.isArray(left) && left.length !== right.length) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalSnapshot(left[key], right[key], seen));
}

const clone = (value) => structuredClone(value);
const append = (past, snapshot, limit) => [...past, clone(snapshot)].slice(-limit);

/** Snapshots must be structured-cloneable data. Treat returned history as readonly. */
export function createEditHistory(snapshot, {limit = MAX_HISTORY} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) throw new RangeError('Edit history limit must be an integer from 1 to 100.');
  return {present: clone(snapshot), past: [], future: [], transaction: null, limit};
}

/** A real edit outside a transaction is a complete undo step. */
export function recordEditHistory(history, snapshot) {
  if (equalSnapshot(history.present, snapshot)) return history;
  return {...history, present: clone(snapshot),
    past: history.transaction ? history.past : append(history.past, history.present, history.limit),
    future: history.transaction ? history.future : []};
}

/** Repeated begin calls are idempotent; a gesture has one original snapshot. */
export function beginEditHistory(history) {
  return history.transaction ? history : {...history, transaction: {initial: clone(history.present)}};
}

export function endEditHistory(history) {
  if (!history.transaction) return history;
  const changed = !equalSnapshot(history.transaction.initial, history.present);
  return {...history, transaction: null,
    past: changed ? append(history.past, history.transaction.initial, history.limit) : history.past,
    future: changed ? [] : history.future};
}

/** Cancellation restores the gesture's initial state without consuming undo/redo. */
export function cancelEditHistory(history) {
  return history.transaction ? {...history, present: clone(history.transaction.initial), transaction: null} : history;
}

/** Undo first cancels a pending gesture. A subsequent undo visits committed history. */
export function undoEditHistory(history) {
  if (history.transaction) return cancelEditHistory(history);
  if (!history.past.length) return history;
  return {...history, present: clone(history.past.at(-1)), past: history.past.slice(0, -1),
    future: [...history.future, clone(history.present)]};
}

/** A pending gesture is cancelled before redo, so a partial edit cannot be replayed. */
export function redoEditHistory(history) {
  if (history.transaction) return cancelEditHistory(history);
  if (!history.future.length) return history;
  return {...history, present: clone(history.future.at(-1)), future: history.future.slice(0, -1),
    past: append(history.past, history.present, history.limit)};
}
