import {Worker} from 'node:worker_threads';

// Webpack/Chrome work must not block project reads, status polling or revision checks.
export function createWorkerPreviewRuntime({storeDataDir, previewDataDir, parentOrigins}) {
  let queue = Promise.resolve();
  let runtimePromise;
  const getRuntime = () => runtimePromise ??= import('./preview-runtime.mjs').then(({createPreviewRuntime}) => createPreviewRuntime({dataDir: previewDataDir}));
  const prepare = (project, options) => {
    const job = queue.then(async () => {
      // Export preparation must never fall back to the live asset catalog.
      // Functions cannot cross worker boundaries, so capture these bounded bytes
      // before dispatch and send only the fixed buffers to the worker.
      let frozenAssets;
      if (options.frozenAssets) {
        if (typeof options.readAsset !== 'function') throw new Error('고정 출력 이미지 읽기 함수가 필요합니다.');
        const total = project.assets.reduce((bytes, asset) => bytes + asset.size, 0);
        if (total > 200 * 1024 * 1024) throw new Error('출력 이미지는 합계 200MB 이하여야 합니다.');
        frozenAssets = {};
        for (const asset of project.assets) {
          const result = await options.readAsset(asset.id);
          const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
          if (!Buffer.isBuffer(bytes) || bytes.length !== asset.size) throw new Error('고정 출력 이미지 정보가 일치하지 않습니다.');
          frozenAssets[asset.id] = Buffer.from(bytes);
        }
      }
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./preview-worker.mjs', import.meta.url), {workerData: {
          project, storeDataDir, previewDataDir, frozenAssets,
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
      });
    });
    queue = job.catch(() => undefined);
    return job;
  };
  return {
    prepare,
    handle: async (...args) => (await getRuntime()).handle(...args),
    renderPreview: async (...args) => (await getRuntime()).renderPreview(...args),
    findSnapshot: async (project, options = {}) => (await getRuntime()).findSnapshot(project, {...options, parentOrigins}),
    getExportSnapshot: async (...args) => (await getRuntime()).getExportSnapshot(...args),
  };
}
