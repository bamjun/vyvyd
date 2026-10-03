import {Worker} from 'node:worker_threads';

// Webpack/Chrome work must not block project reads, status polling or revision checks.
export function createWorkerPreviewRuntime({storeDataDir, previewDataDir, parentOrigins}) {
  let queue = Promise.resolve();
  let runtimePromise;
  const getRuntime = () => runtimePromise ??= import('./preview-runtime.mjs').then(({createPreviewRuntime}) => createPreviewRuntime({dataDir: previewDataDir}));
  const prepare = (project, options) => {
    const job = queue.then(() => new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./preview-worker.mjs', import.meta.url), {workerData: {
        project, storeDataDir, previewDataDir,
        options: {origin: options.origin, frame: options.frame, parentOrigins},
      }});
      let received = false;
      worker.once('message', (message) => {
        received = true;
        if (message.error) reject(Object.assign(new Error(message.error.message), message.error));
        else resolve(message.result);
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {if (!received) reject(new Error(`미리보기 컴파일 작업이 종료되었습니다 (${code}).`));});
    }));
    queue = job.catch(() => undefined);
    return job;
  };
  return {
    prepare,
    handle: async (...args) => (await getRuntime()).handle(...args),
    renderPreview: async (...args) => (await getRuntime()).renderPreview(...args),
    findSnapshot: async (...args) => (await getRuntime()).findSnapshot(...args),
  };
}
