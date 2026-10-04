import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {renderExport} from './export-renderer.mjs';

if (!isMainThread) {
  const render = renderExport({...workerData, onProgress: (progress) => parentPort.postMessage({type: 'progress', progress})});
  parentPort.on('message', (message) => {if (message?.type === 'cancel') render.cancel();});
  render.promise.then((result) => parentPort.postMessage({type: 'done', result}),
    (error) => parentPort.postMessage({type: 'failed', message: error instanceof Error ? error.message : String(error)}))
    .finally(() => {parentPort.close();});
}

export function runExportWorker({onProgress, ...data}) {
  const worker = new Worker(new URL('./export-worker.mjs', import.meta.url), {workerData: data});
  let outcome;
  const promise = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.type === 'progress') onProgress?.(message.progress);
      if (message.type === 'done') outcome = {result: message.result};
      if (message.type === 'failed') outcome = {error: new Error(message.message)};
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (outcome?.error) reject(outcome.error);
      else if (outcome?.result && code === 0) resolve(outcome.result);
      else reject(new Error(`출력 작업이 예기치 않게 종료되었습니다 (${code}).`));
    });
  });
  return {promise, cancel: () => worker.postMessage({type: 'cancel'})};
}
