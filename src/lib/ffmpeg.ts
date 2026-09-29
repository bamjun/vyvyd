import { FFmpeg } from '@ffmpeg/ffmpeg';
import { throwIfAborted } from '@/lib/cancellation';

let engine: FFmpeg | undefined;
let processingQueue: Promise<void> = Promise.resolve();

const loadEngine = async (
  ffmpeg: FFmpeg,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) => {
  throwIfAborted(signal);
  if (ffmpeg.loaded) return;

  onProgress?.('FFmpeg 준비 중...');
  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
  const urls: string[] = [];
  const download = async (name: string, type: string) => {
    const response = await fetch(`${baseURL}/${name}`, { signal });
    if (!response.ok) throw new Error('FFmpeg를 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
    const data = await response.arrayBuffer();
    throwIfAborted(signal);
    const url = URL.createObjectURL(new Blob([data], { type }));
    urls.push(url);
    return url;
  };

  try {
    const coreURL = await download('ffmpeg-core.js', 'text/javascript');
    const wasmURL = await download('ffmpeg-core.wasm', 'application/wasm');
    throwIfAborted(signal);
    await ffmpeg.load({ coreURL, wasmURL });
    throwIfAborted(signal);
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
};

/** All FFmpeg users share one FIFO; only an active job can terminate its engine. */
export const runFFmpegJob = <T>(
  task: (ffmpeg: FFmpeg) => Promise<T>,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<T> => {
  if (signal?.aborted) return Promise.reject(new DOMException('작업을 취소했습니다.', 'AbortError'));
  onProgress?.('변환 작업 대기 중...');

  let rejectAbort: (error: DOMException) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new DOMException('작업을 취소했습니다.', 'AbortError'));
  signal?.addEventListener('abort', onAbort, { once: true });

  const result = processingQueue.then(async () => {
    // A cancelled queued job never acquires or terminates another job's engine.
    throwIfAborted(signal);
    const jobEngine = engine ?? new FFmpeg();
    engine = jobEngine;
    const terminate = () => {
      jobEngine.terminate();
      if (engine === jobEngine) engine = undefined;
    };
    signal?.addEventListener('abort', terminate, { once: true });

    try {
      const work = (async () => {
        await loadEngine(jobEngine, signal, onProgress);
        throwIfAborted(signal);
        const value = await task(jobEngine);
        throwIfAborted(signal);
        return value;
      })();
      // Cancellation releases the queue even if file I/O is still settling.
      // Any late callback keeps its terminated engine, never the next job's one.
      return await Promise.race([work, aborted]);
    } catch (error) {
      if (!jobEngine.loaded) terminate();
      throwIfAborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener('abort', terminate);
    }
  });

  processingQueue = result.then(() => undefined, () => undefined);
  // Queued cancellation is immediate even while the preceding job is busy.
  return Promise.race([result, aborted]).finally(() => {
    signal?.removeEventListener('abort', onAbort);
  });
};
