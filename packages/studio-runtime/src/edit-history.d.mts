export type EditSnapshot = {fields: Record<string, unknown>; layers: Record<string, unknown>};
export type EditHistory<T> = {
  readonly present: T;
  readonly past: readonly T[];
  readonly future: readonly T[];
  readonly transaction: {readonly initial: T} | null;
  readonly limit: number;
};
/** All snapshots must be structured-cloneable data. Default and maximum limit: 100. */
export function createEditHistory<T>(snapshot: T, options?: {limit?: number}): EditHistory<T>;
export function recordEditHistory<T>(history: EditHistory<T>, snapshot: T): EditHistory<T>;
/** Idempotent; repeated begin calls do not replace the gesture's initial snapshot. */
export function beginEditHistory<T>(history: EditHistory<T>): EditHistory<T>;
export function endEditHistory<T>(history: EditHistory<T>): EditHistory<T>;
export function cancelEditHistory<T>(history: EditHistory<T>): EditHistory<T>;
/** First cancels a pending gesture; otherwise moves through committed history. */
export function undoEditHistory<T>(history: EditHistory<T>): EditHistory<T>;
export function redoEditHistory<T>(history: EditHistory<T>): EditHistory<T>;
