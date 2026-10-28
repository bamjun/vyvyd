import { isAbortError, throwIfAborted } from './cancellation';

export type ImageBatchFileState =
  | { status: 'waiting' | 'processing' | 'succeeded' | 'cancelled' }
  | { status: 'failed'; message: string };

export type ImageBatchMode = 'all' | 'failed' | 'remaining';

export type ImageBatchOutcome<Result> =
  | { status: 'succeeded'; result: Result }
  | { status: 'failed'; message: string }
  | { status: 'cancelled' };

/** Retry selectors never include successes or unrelated failures. */
export const selectImageBatchItems = <Item extends { id: string }>(
  items: readonly Item[], states: Record<string, ImageBatchFileState>, mode: ImageBatchMode, id?: string,
): Item[] => items.filter((item) => {
  if (id !== undefined && item.id !== id) return false;
  const state = states[item.id];
  if (mode === 'all') return true;
  if (mode === 'failed') return state?.status === 'failed';
  return !state || state.status === 'waiting' || state.status === 'cancelled';
});

interface ImageBatchOptions<Item, Result> {
  items: readonly Item[];
  signal: AbortSignal;
  convert: (item: Item, index: number) => Promise<Result>;
  onStart?: (item: Item, index: number) => void;
  onOutcome: (item: Item, outcome: ImageBatchOutcome<Result>) => void;
  onDiscardResult?: (result: Result) => void;
}

/** Build all parts before the caller publishes any URLs or counts a source as successful. */
export const collectImageBatchParts = async <Part, Result>(
  parts: readonly Part[], signal: AbortSignal, convert: (part: Part, index: number) => Promise<Result>,
): Promise<Result[]> => {
  const results: Result[] = [];
  for (const [index, part] of parts.entries()) {
    throwIfAborted(signal);
    const result = await convert(part, index);
    throwIfAborted(signal);
    results.push(result);
  }
  return results;
};

/** A file failure does not stop later files; cancellation never publishes a late result. */
export const runImageBatch = async <Item, Result>({
  items, signal, convert, onStart, onOutcome, onDiscardResult,
}: ImageBatchOptions<Item, Result>): Promise<void> => {
  for (const [index, item] of items.entries()) {
    throwIfAborted(signal);
    onStart?.(item, index);
    let result: Result;
    try {
      result = await convert(item, index);
      if (signal.aborted) onDiscardResult?.(result);
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        onOutcome(item, { status: 'cancelled' });
        throwIfAborted(signal);
        throw error;
      }
      onOutcome(item, {
        status: 'failed',
        message: error instanceof Error && error.message ? error.message : '이미지를 처리하지 못했습니다. 설정을 확인하고 다시 시도해 주세요.',
      });
      continue;
    }
    onOutcome(item, { status: 'succeeded', result });
  }
};
