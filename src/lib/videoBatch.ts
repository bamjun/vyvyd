import { isAbortError, throwIfAborted } from './cancellation';

export type VideoBatchOutcome<Result> =
  | { status: 'succeeded'; result: Result }
  | { status: 'failed'; message: string }
  | { status: 'cancelled' };

export type VideoBatchFileState =
  | { status: 'waiting' | 'processing' | 'succeeded' | 'cancelled' }
  | { status: 'failed'; message: string };

interface VideoBatchOptions<Item, Result> {
  items: readonly Item[];
  signal: AbortSignal;
  convert: (item: Item, index: number) => Promise<Result>;
  onStart?: (item: Item, index: number) => void;
  onOutcome: (item: Item, outcome: VideoBatchOutcome<Result>) => void;
}

/** Ordinary file failures are isolated; cancellation stops the batch immediately. */
export const runVideoBatch = async <Item, Result>({
  items, signal, convert, onStart, onOutcome,
}: VideoBatchOptions<Item, Result>): Promise<void> => {
  for (const [index, item] of items.entries()) {
    throwIfAborted(signal);
    onStart?.(item, index);
    let result: Result;
    try {
      throwIfAborted(signal);
      result = await convert(item, index);
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        onOutcome(item, { status: 'cancelled' });
        throwIfAborted(signal);
        throw error;
      }
      onOutcome(item, {
        status: 'failed',
        message: error instanceof Error && error.message ? error.message : '영상을 변환하지 못했습니다. 설정을 확인하고 다시 시도해 주세요.',
      });
      continue;
    }
    onOutcome(item, { status: 'succeeded', result });
  }
};
